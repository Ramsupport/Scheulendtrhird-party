const express    = require('express');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { pool }   = require('../db');
const router     = express.Router();
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  next();
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Helper: fetch unpaid/partially-paid completed tokens for an agent ────────
async function _getUnpaidTokens(submittedBy, method, fromDate, toDate) {
  const params = [submittedBy];
  let q = `
    SELECT t.*,
           COALESCE(SUM(pa.allocated_amount), 0)::numeric AS paid_amount
    FROM   tokens t
    LEFT   JOIN payment_allocations pa ON pa.token_id = t.id
    WHERE  t.status      = 'completed'
      AND  t.author_id = $1`;

  if (method === 'date_range') {
    if (!fromDate || !toDate) throw new Error('from_date and to_date are required');
    q += ` AND t.created_at::date BETWEEN $2 AND $3`;
    params.push(fromDate, toDate);
  }

  q += `
    GROUP  BY t.id
    HAVING t.charge > COALESCE(SUM(pa.allocated_amount), 0)
    ORDER  BY t.created_at ASC`;

  const { rows } = await pool.query(q, params);
  return rows;
}

// ── GET /api/payments ────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    let q      = `
      SELECT p.*,
             COALESCE(SUM(pa.allocated_amount), 0)::numeric AS total_allocated
      FROM   payments p
      LEFT   JOIN payment_allocations pa ON pa.payment_id = p.id
      WHERE  1=1`;
    const params = [];
    if (user.role !== 'admin') {
      q += ' AND p.submitted_by=$1';
      params.push(user.id);
    }
    q += ' GROUP BY p.id ORDER BY p.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/payments ────────────────────────────────────────────────────────
router.post('/', requireAuth, upload.single('screenshot'), async (req, res) => {
  const { details, amount, payment_date } = req.body;
  if (!details || !amount) return res.status(400).json({ error: 'Details and amount are required' });
  const user = req.session.user;

  let screenshot_url = null, screenshot_public_id = null;
  if (req.file) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'token-tracker/payments', resource_type: 'image' },
          (err, r) => err ? reject(err) : resolve(r)
        );
        stream.end(req.file.buffer);
      });
      screenshot_url       = result.secure_url;
      screenshot_public_id = result.public_id;
    } catch (e) { /* screenshot failed — still save payment */ }
  }

  try {
    const { rows: cnt } = await pool.query('SELECT COUNT(*) FROM payments');
    let counter = parseInt(cnt[0].count) + 1;
    let payment = null;
    let ref = '';
    const pdate = payment_date || new Date().toISOString().slice(0, 10);

    // ── CONCURRENCY-SAFE GENERATOR ──
    while (!payment) {
      ref = 'PAY' + String(counter).padStart(4, '0');
      try {
        const { rows } = await pool.query(
          `INSERT INTO payments
             (payment_ref, details, amount, payment_date,
              screenshot_url, screenshot_public_id, submitted_by, submitted_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [ref, details, parseFloat(amount), pdate,
           screenshot_url, screenshot_public_id, user.id, user.name]
        );
        payment = rows[0];
      } catch (dbErr) {
        if (dbErr.code === '23505') {
          counter++; // 23505 is Unique Constraint Violation, add 1 and try again
        } else {
          throw dbErr;
        }
      }
    }
    res.json(payment);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/payments/:id ─────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (user.role !== 'admin' && rows[0].submitted_by !== user.id)
      return res.status(403).json({ error: 'Not allowed' });
    if (rows[0].screenshot_public_id)
      await cloudinary.uploader.destroy(rows[0].screenshot_public_id).catch(() => {});
    await pool.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/payments/:id/screenshot ───────────────────────────────────────
router.post('/:id/screenshot', requireAuth, upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (user.role !== 'admin' && rows[0].submitted_by !== user.id)
      return res.status(403).json({ error: 'Not allowed' });
    if (rows[0].screenshot_public_id)
      await cloudinary.uploader.destroy(rows[0].screenshot_public_id).catch(() => {});
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'token-tracker/payments', resource_type: 'image' },
        (err, r) => err ? reject(err) : resolve(r)
      );
      stream.end(req.file.buffer);
    });
    const updated = await pool.query(
      'UPDATE payments SET screenshot_url=$1, screenshot_public_id=$2 WHERE id=$3 RETURNING *',
      [result.secure_url, result.public_id, req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/payments/:id/screenshot ─────────────────────────────────────
router.delete('/:id/screenshot', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (user.role !== 'admin' && rows[0].submitted_by !== user.id)
      return res.status(403).json({ error: 'Not allowed' });
    if (rows[0].screenshot_public_id)
      await cloudinary.uploader.destroy(rows[0].screenshot_public_id).catch(() => {});
    await pool.query(
      'UPDATE payments SET screenshot_url=NULL, screenshot_public_id=NULL WHERE id=$1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/payments/:id/apply/preview ────────────────────────────────────
router.post('/:id/apply/preview', requireAdmin, async (req, res) => {
  const { method, from_date, to_date, amount } = req.body;
  try {
    const { rows: payRows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!payRows.length) return res.status(404).json({ error: 'Payment not found' });
    const payment = payRows[0];

    const tokens = await _getUnpaidTokens(payment.submitted_by, method, from_date, to_date);

    let remaining = method === 'custom_amount' ? parseFloat(amount) : Infinity;
    if (method === 'custom_amount' && (isNaN(remaining) || remaining <= 0))
      return res.status(400).json({ error: 'Invalid amount' });

    const preview     = [];
    let totalAllocated = 0;

    for (const t of tokens) {
      if (method === 'custom_amount' && remaining <= 0) break;
      const unpaid = parseFloat(t.charge) - parseFloat(t.paid_amount);
      if (unpaid <= 0) continue;

      const alloc = method === 'date_range' ? unpaid : Math.min(unpaid, remaining);
      if (method === 'custom_amount') remaining -= alloc;
      totalAllocated += alloc;

      preview.push({
        token_id          : t.id,
        details           : (t.details || '').substring(0, 80),
        charge            : parseFloat(t.charge),
        already_paid      : parseFloat(t.paid_amount),
        will_allocate     : parseFloat(alloc.toFixed(2)),
        will_be_fully_paid: (parseFloat(t.paid_amount) + alloc) >= parseFloat(t.charge),
        created_at        : t.created_at,
      });
    }

    res.json({
      tokens          : preview,
      total_allocated : parseFloat(totalAllocated.toFixed(2)),
      remaining_after : method === 'custom_amount' ? parseFloat(Math.max(0, remaining).toFixed(2)) : null,
      agent_name      : payment.submitted_name,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/payments/:id/apply ────────────────────────────────────────────
router.post('/:id/apply', requireAdmin, async (req, res) => {
  const { method, from_date, to_date, amount } = req.body;
  try {
    const { rows: payRows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!payRows.length) return res.status(404).json({ error: 'Payment not found' });
    const payment = payRows[0];

    const tokens = await _getUnpaidTokens(payment.submitted_by, method, from_date, to_date);
    if (!tokens.length) return res.json({ allocations: [], message: 'No unpaid tokens found' });

    let remaining = method === 'custom_amount' ? parseFloat(amount) : Infinity;
    if (method === 'custom_amount' && (isNaN(remaining) || remaining <= 0))
      return res.status(400).json({ error: 'Invalid amount' });

    const allocations = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const t of tokens) {
        if (method === 'custom_amount' && remaining <= 0) break;
        const unpaid = parseFloat(t.charge) - parseFloat(t.paid_amount);
        if (unpaid <= 0) continue;

        const alloc = method === 'date_range' ? unpaid : Math.min(unpaid, remaining);
        if (method === 'custom_amount') remaining -= alloc;

        const { rows: a } = await client.query(
          `INSERT INTO payment_allocations (payment_id, token_id, allocated_amount)
           VALUES ($1, $2, $3)
           ON CONFLICT (payment_id, token_id)
             DO UPDATE SET allocated_amount = payment_allocations.allocated_amount + EXCLUDED.allocated_amount
           RETURNING *`,
          [payment.id, t.id, parseFloat(alloc.toFixed(2))]
        );
        allocations.push(a[0]);
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({
      allocations,
      applied_count   : allocations.length,
      remaining_amount: method === 'custom_amount' ? parseFloat(Math.max(0, remaining).toFixed(2)) : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/payments/:id/allocations ───────────────────────────────────────
router.get('/:id/allocations', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pa.*,
              t.details      AS token_details,
              t.charge       AS token_charge,
              t.created_at   AS token_created_at
       FROM   payment_allocations pa
       JOIN   tokens t ON t.id = pa.token_id
       WHERE  pa.payment_id = $1
       ORDER  BY t.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/payments/:id/allocations ────────────────────────────────────
router.delete('/:id/allocations', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM payment_allocations WHERE payment_id=$1', [req.params.id]
    );
    res.json({ ok: true, removed: rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/payments/token-paid-status ─────────────────────────────────────
router.get('/token-paid-status', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    let q = `
      SELECT t.id           AS token_id,
             t.charge,
             COALESCE(SUM(pa.allocated_amount), 0)::numeric AS total_paid
      FROM   tokens t
      LEFT   JOIN payment_allocations pa ON pa.token_id = t.id
      WHERE  t.status = 'completed'`;
    const params = [];
    if (user.role !== 'admin') {
      q += ' AND t.author_id=$1';
      params.push(user.id);
    }
    q += ' GROUP BY t.id, t.charge HAVING COALESCE(SUM(pa.allocated_amount),0) > 0';
    const { rows } = await pool.query(q, params);

    const map = {};
    rows.forEach(r => {
      map[r.token_id] = {
        total_paid    : parseFloat(r.total_paid),
        is_fully_paid : parseFloat(r.total_paid) >= parseFloat(r.charge),
      };
    });
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
