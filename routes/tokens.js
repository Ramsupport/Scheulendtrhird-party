const express    = require('express');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { pool }   = require('../db');
const router     = express.Router();
const upload     = multer({ storage: multer.memoryStorage() });

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  next();
}

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// GET /api/tokens
router.get('/', requireAuth, async (req, res) => {
  const { from, to, author_id, search, status } = req.query;
  const user = req.session.user;
  let query  = 'SELECT * FROM tokens WHERE 1=1';
  const params = [];
  let i = 1;

  // Agents only see their own tokens
  if (user.role !== 'admin') {
    query += ` AND author_id=$${i++}`; params.push(user.id);
  } else if (author_id) {
    query += ` AND author_id=$${i++}`; params.push(author_id);
  }
  if (from)   { query += ` AND created_at >= $${i++}`; params.push(from); }
  if (to)     { query += ` AND created_at <= $${i++}`; params.push(to + 'T23:59:59Z'); }
  if (search) { query += ` AND (details ILIKE $${i++} OR token_ref ILIKE $${i++})`; params.push(`%${search}%`, `%${search}%`); i++; }
  if (status) { query += ` AND status=$${i++}`; params.push(status); }
  query += ' ORDER BY created_at DESC';

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tokens
router.post('/', requireAuth, async (req, res) => {
  const { details, charge } = req.body;
  if (!details) return res.status(400).json({ error: 'Details required' });
  const user = req.session.user;
  try {
    // Generate token ref — use MAX id so deletions never cause duplicate refs
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(id),0) as maxid FROM tokens');
    const ref = 'TK' + String(parseInt(maxRows[0].maxid) + 1).padStart(4, '0');

    const { rows } = await pool.query(
      `INSERT INTO tokens (token_ref, details, charge, status, author_id, author_name)
       VALUES ($1,$2,$3,'active',$4,$5) RETURNING *`,
      [ref, details, parseFloat(charge) || 0, user.id, user.name]
    );
    const token = rows[0];

    // Notify only admin — get admin user IDs and emit to their rooms only
    const io = req.app.get('io');
    if (io) {
      try {
        const adminRows = await pool.query("SELECT id FROM users WHERE role='admin'");
        adminRows.rows.forEach(admin => {
          io.to(`user_${admin.id}`).emit('new_token', token);
        });
      } catch(_) {}
    }

    // Post to token-alerts channel
    try {
      const ch = await pool.query(`SELECT id FROM channels WHERE name='token-alerts' LIMIT 1`);
      if (ch.rows.length) {
        const msg = await pool.query(
          `INSERT INTO messages (channel_id, author_id, author_name, text, is_token_alert)
           VALUES ($1,$2,$3,$4,true) RETURNING *`,
          [ch.rows[0].id, user.id, user.name,
           `🎫 New token ${ref} added by ${user.name}\n${details}\nCharge: ₹${parseFloat(charge||0).toFixed(2)}`]
        );
        const io = req.app.get('io');
        if (io) io.to(`channel_${ch.rows[0].id}`).emit('new_message', msg.rows[0]);
      }
    } catch(_) {}

    res.json(token);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/tokens/:id  — edit details and charge
router.patch('/:id', requireAuth, async (req, res) => {
  const { details, charge } = req.body;
  if (!details) return res.status(400).json({ error: 'Details required' });
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM tokens WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Token not found' });
    if (user.role !== 'admin' && rows[0].author_id !== user.id)
      return res.status(403).json({ error: 'Not allowed' });
    const result = await pool.query(
      'UPDATE tokens SET details=$1, charge=$2 WHERE id=$3 RETURNING *',
      [details, parseFloat(charge) || 0, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/tokens/:id/status
router.patch('/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const user       = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM tokens WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Token not found' });
    if (user.role !== 'admin' && rows[0].author_id !== user.id)
      return res.status(403).json({ error: 'Not allowed' });
    const completed_at = status === 'completed' ? new Date() : null;
    const result = await pool.query(
      'UPDATE tokens SET status=$1, completed_at=$2 WHERE id=$3 RETURNING *',
      [status, completed_at, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/tokens/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM tokens WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Token not found' });
    if (user.role !== 'admin' && rows[0].author_id !== user.id)
      return res.status(403).json({ error: 'Not allowed' });
    // Destroy both KYC slots from Cloudinary before deleting the token
    if (rows[0].kyc_public_id)   await cloudinary.uploader.destroy(rows[0].kyc_public_id).catch(() => {});
    if (rows[0].kyc_public_id_2) await cloudinary.uploader.destroy(rows[0].kyc_public_id_2).catch(() => {});
    await pool.query('DELETE FROM tokens WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tokens/:id/kyc?slot=1|2  (admin only)
router.post('/:id/kyc', requireAdmin, upload.single('kyc_image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const slot   = req.query.slot === '2' ? 2 : 1;
  const urlCol = slot === 2 ? 'kyc_image_url_2'   : 'kyc_image_url';
  const pidCol = slot === 2 ? 'kyc_public_id_2'   : 'kyc_public_id';
  const atCol  = slot === 2 ? 'kyc_uploaded_at_2' : 'kyc_uploaded_at';
  const byCol  = slot === 2 ? 'kyc_uploaded_by_2' : 'kyc_uploaded_by';

  try {
    const { rows } = await pool.query('SELECT * FROM tokens WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Token not found' });

    // Remove old image for this slot if one already exists
    if (rows[0][pidCol]) {
      await cloudinary.uploader.destroy(rows[0][pidCol]).catch(() => {});
    }

    // Upload new image to Cloudinary via stream
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'token-tracker/kyc', resource_type: 'image' },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    const updated = await pool.query(
      `UPDATE tokens SET ${urlCol}=$1, ${pidCol}=$2, ${atCol}=NOW(), ${byCol}=$3
       WHERE id=$4 RETURNING *`,
      [result.secure_url, result.public_id, req.session.user.name, req.params.id]
    );
    const token = updated.rows[0];

    // Notify agent via Socket.IO — pass whichever URL was just uploaded
    const io = req.app.get('io');
    if (io && token.author_id) {
      io.to(`user_${token.author_id}`).emit('kyc_uploaded', {
        token_ref:     token.token_ref,
        kyc_image_url: slot === 1 ? token.kyc_image_url : token.kyc_image_url_2,
        slot,
      });
    }
    res.json(token);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/tokens/:id/kyc?slot=1|2  (admin only)
router.delete('/:id/kyc', requireAdmin, async (req, res) => {
  const slot   = req.query.slot === '2' ? 2 : 1;
  const urlCol = slot === 2 ? 'kyc_image_url_2'   : 'kyc_image_url';
  const pidCol = slot === 2 ? 'kyc_public_id_2'   : 'kyc_public_id';
  const atCol  = slot === 2 ? 'kyc_uploaded_at_2' : 'kyc_uploaded_at';
  const byCol  = slot === 2 ? 'kyc_uploaded_by_2' : 'kyc_uploaded_by';

  try {
    const { rows } = await pool.query(`SELECT ${pidCol} FROM tokens WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Token not found' });
    if (rows[0][pidCol]) {
      await cloudinary.uploader.destroy(rows[0][pidCol]).catch(() => {});
    }
    await pool.query(
      `UPDATE tokens SET ${urlCol}=NULL, ${pidCol}=NULL, ${atCol}=NULL, ${byCol}=NULL WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tokens/export  — CSV download
router.get('/export', requireAuth, async (req, res) => {
  const { from, to, author_id, status } = req.query;
  const user = req.session.user;
  let query  = 'SELECT * FROM tokens WHERE 1=1';
  const params = [];
  let i = 1;
  if (user.role !== 'admin') { query += ` AND author_id=$${i++}`; params.push(user.id); }
  else if (author_id) { query += ` AND author_id=$${i++}`; params.push(author_id); }
  if (from)   { query += ` AND created_at >= $${i++}`; params.push(from); }
  if (to)     { query += ` AND created_at <= $${i++}`; params.push(to + 'T23:59:59Z'); }
  if (status) { query += ` AND status=$${i++}`; params.push(status); }
  query += ' ORDER BY created_at DESC';
  try {
    const { rows } = await pool.query(query, params);
    let csv = 'Token ID,Submitted By,Date (IST),Details,Charges,Status\n';
    rows.forEach(t => {
      const d = new Date(t.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      csv += `"${t.token_ref}","${t.author_name}","${d}","${(t.details||'').replace(/"/g,'""')}","₹${parseFloat(t.charge||0).toFixed(2)}","${t.status}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tokens-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tokens/summary
router.get('/summary', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    let q = `SELECT COUNT(*) FILTER(WHERE status='active') as active_count,
                    COUNT(*) FILTER(WHERE status='completed') as completed_count,
                    COALESCE(SUM(charge) FILTER(WHERE status='completed'),0) as total_due
             FROM tokens`;
    const params = [];
    if (user.role !== 'admin') { q += ' WHERE author_id=$1'; params.push(user.id); }
    const { rows } = await pool.query(q, params);
    res.json(rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
