CREATE TABLE IF NOT EXISTS portal_script_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  password_hash varchar(100) NOT NULL,
  updated_by_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_bot_password_attempts (
  id bigserial PRIMARY KEY,
  ip_hash char(64) NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_bot_password_ip_time_idx
  ON portal_bot_password_attempts (ip_hash, attempted_at DESC);

ALTER TABLE portal_licenses DROP COLUMN IF EXISTS token_hash;
