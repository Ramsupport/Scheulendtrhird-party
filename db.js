require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'agent',
      color         TEXT DEFAULT '#00d4aa',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id            SERIAL PRIMARY KEY,
      token_ref     TEXT UNIQUE NOT NULL,
      details       TEXT NOT NULL,
      charge        NUMERIC(12,2) DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active',
      author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name   TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      completed_at  TIMESTAMPTZ,
      kyc_image_url   TEXT,
      kyc_public_id   TEXT,
      kyc_uploaded_at TIMESTAMPTZ,
      kyc_uploaded_by TEXT
    );

    CREATE TABLE IF NOT EXISTS channels (
      id          SERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      description TEXT,
      icon        TEXT DEFAULT '💬',
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             SERIAL PRIMARY KEY,
      channel_id     INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      author_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name    TEXT NOT NULL,
      text           TEXT NOT NULL,
      is_token_alert BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS direct_messages (
      id           SERIAL PRIMARY KEY,
      dm_key       TEXT NOT NULL,
      sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sender_name  TEXT NOT NULL,
      sender_color TEXT DEFAULT '#00d4aa',
      receiver_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text         TEXT NOT NULL,
      is_read      BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session(expire);

    CREATE TABLE IF NOT EXISTS payments (
      id                   SERIAL PRIMARY KEY,
      payment_ref          TEXT UNIQUE NOT NULL,
      details              TEXT NOT NULL,
      amount               NUMERIC(14,2) NOT NULL,
      payment_date         DATE NOT NULL,
      screenshot_url       TEXT,
      screenshot_public_id TEXT,
      submitted_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_name       TEXT NOT NULL,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── KYC slot-2 columns (safe to re-run on existing databases) ──────────────
  await pool.query(`
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS kyc_image_url_2   TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS kyc_public_id_2   TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS kyc_uploaded_at_2 TIMESTAMPTZ;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS kyc_uploaded_by_2 TEXT;
  `);

  // Seed default channels
  await pool.query(`
    INSERT INTO channels (name, description, icon) VALUES
      ('general',      'General team chat',      '💬'),
      ('token-alerts', 'Token notifications',    '🎫'),
      ('support',      'Help & support',          '🛠️')
    ON CONFLICT (name) DO NOTHING;
  `);

  // Seed default admin user (admin / admin123)
  const bcrypt = require('bcryptjs');
  const hash   = await bcrypt.hash('admin123', 10);
  await pool.query(`
    INSERT INTO users (username, name, password_hash, role, color)
    VALUES ('admin', 'Admin', $1, 'admin', '#00d4aa')
    ON CONFLICT (username) DO NOTHING;
  `, [hash]);

  console.log('✅ Database schema ready');
}

module.exports = { pool, initSchema };
