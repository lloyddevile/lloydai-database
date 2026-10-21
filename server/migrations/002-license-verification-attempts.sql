CREATE TABLE IF NOT EXISTS portal_license_verification_attempts (
  id bigserial PRIMARY KEY,
  ip_hash char(64) NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_license_verification_ip_time_idx
  ON portal_license_verification_attempts (ip_hash, attempted_at DESC);
