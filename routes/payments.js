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

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// GET /api/payments — returns each payment with an `images` array
router.get('/', requireAuth, async (req, res) => {
  const user = req.session.user;
  const params = [];
  let where = '1=1';
  if (user.role !== 'admin') {
    where += ' AND p.submitted_by=$1';
    params.push(user.id);
  }
  try {
    const query = `
      SELECT p.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id',          pi.id,
              'url',         pi.image_url,
              'public_id',   pi.public_id,
              'uploaded_at', pi.uploaded_at
            ) ORDER BY pi.uploaded_at ASC
          ) FILTER (WHERE pi.id IS NOT NULL),
          '[]'::json
        ) AS images
      FROM payments p
      LEFT JOIN payment_images pi ON pi.payment_id = p.id
      WHERE ${where}
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payments  (with optional initial screenshot)
router.post('/', requireAuth, upload.single('screenshot'), async (req, res) => {
  const { details, amount, payment_date } = req.body;
  if (!details || !amount) return res.status(400).json({ error: 'Details and amount are required' });
  const user = req.session.user;

  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM payments');
    let counter = parseInt(countRows[0].count) + 1;
    const pdate = payment_date || new Date().toISOString().slice(0, 10);
    
    let payment = null;
    let ref = '';

    // ── CONCURRENCY-SAFE GENERATOR (Fixes Duplicate Key Error) ──
    while (!payment) {
      ref = 'PAY' + String(counter).padStart(4, '0');
      try {
        const { rows } = await pool.query(
          `INSERT INTO payments (payment_ref, details, amount, payment_date, submitted_by, submitted_name)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [ref, details, parseFloat(amount), pdate, user.id, user.name]
        );
        payment = rows[0]; 
      } catch (dbErr) {
        if (dbErr.code === '23505') counter++; // Code 23505 is Unique Constraint Violation
        else throw dbErr; 
      }
    }

    // If a screenshot was attached, upload it and store in payment_images
    if (req.file) {
      try {
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'token-tracker/payments', resource_type: 'image' },
            (err, result) => err ? reject(err) : resolve(result)
          );
          stream.end(req.file.buffer);
        });
        await pool.query(
          `INSERT INTO payment_images (payment_id, image_url, public_id, uploaded_at, uploaded_by)
           VALUES ($1, $2, $3, NOW(), $4)`,
          [payment.id, result.secure_url, result.public_id, user.name]
        );
      } catch(e) { /* screenshot upload failed — payment still saved */ }
    }

    res.json(payment);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payments/:id/images  — add a screenshot to an existing payment
router.post('/:id/images', requireAuth, upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (user.role !== 'admin' && rows[0].submitted_by !== user.id)
      return res.status(403).json({ error: 'Not allowed' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'token-tracker/payments', resource_type: 'image' },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    await pool.query(
      `INSERT INTO payment_images (payment_id, image_url, public_id, uploaded_at, uploaded_by)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [req.params.id, result.secure_url, result.public_id, user.name]
    );
    res.json({ ok: true, url: result.secure_url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/payments/:id/images/:imageId  — remove one screenshot by its row id
router.delete('/:id/images/:imageId', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const pay = await pool.query('SELECT submitted_by FROM payments WHERE id=$1', [req.params.id]);
    if (!pay.rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (user.role !== 'admin' && pay.rows[0].submitted_by !== user.id)
      return res.status(403).json({ error: 'Not allowed' });

    const { rows } = await pool.query(
      'SELECT * FROM payment_images WHERE id=$1 AND payment_id=$2',
      [req.params.imageId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Image not found' });

    if (rows[0].public_id) {
      await cloudinary.uploader.destroy(rows[0].public_id).catch(() => {});
    }
    await pool.query('DELETE FROM payment_images WHERE id=$1', [req.params.imageId]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/payments/:id  (admin or own)
router.delete('/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (user.role !== 'admin' && rows[0].submitted_by !== user.id)
      return res.status(403).json({ error: 'Not allowed' });

    const imgs = await pool.query('SELECT public_id FROM payment_images WHERE payment_id=$1', [req.params.id]);
    for (const img of imgs.rows) {
      if (img.public_id) await cloudinary.uploader.destroy(img.public_id).catch(() => {});
    }
    if (rows[0].screenshot_public_id) {
      await cloudinary.uploader.destroy(rows[0].screenshot_public_id).catch(() => {});
    }

    await pool.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
