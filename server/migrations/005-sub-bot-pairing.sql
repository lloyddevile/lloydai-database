ALTER TABLE portal_accounts
  DROP CONSTRAINT IF EXISTS portal_accounts_role_check;

ALTER TABLE portal_accounts
  ADD CONSTRAINT portal_accounts_role_check
  CHECK (role IN ('owner', 'partner', 'reseller', 'user'));

CREATE TABLE IF NOT EXISTS portal_subbots (
  id uuid PRIMARY KEY,
  account_id uuid UNIQUE REFERENCES portal_accounts(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'starting', 'pairing', 'connected', 'stop_requested', 'stopped', 'failed')),
  command varchar(16) CHECK (command IN ('pair', 'stop')),
  pairing_method varchar(16) CHECK (pairing_method IN ('qr', 'pairing-code')),
  phone varchar(15) CHECK (phone IS NULL OR phone ~ '^[1-9][0-9]{7,14}$'),
  pairing_code varchar(64),
  qr_image text,
  connected_phone varchar(15) CHECK (connected_phone IS NULL OR connected_phone ~ '^[1-9][0-9]{7,14}$'),
  error_message varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  worker_seen_at timestamptz
);

CREATE INDEX IF NOT EXISTS portal_subbots_command_idx
  ON portal_subbots (updated_at) WHERE command IS NOT NULL;

CREATE TABLE IF NOT EXISTS portal_signup_attempts (
  id bigserial PRIMARY KEY,
  ip_hash char(64) NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_signup_attempts_ip_time_idx
  ON portal_signup_attempts (ip_hash, attempted_at DESC);
