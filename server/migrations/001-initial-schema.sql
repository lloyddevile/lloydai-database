CREATE TABLE IF NOT EXISTS portal_accounts (
  id uuid PRIMARY KEY,
  name varchar(60) NOT NULL,
  email varchar(120) NOT NULL,
  password_hash varchar(100) NOT NULL,
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'partner', 'reseller')),
  parent_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  created_by_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'owner' AND parent_id IS NULL) OR role <> 'owner')
);

CREATE UNIQUE INDEX IF NOT EXISTS portal_accounts_email_lower_uq
  ON portal_accounts (lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS portal_accounts_single_owner_uq
  ON portal_accounts (role) WHERE role = 'owner';

CREATE INDEX IF NOT EXISTS portal_accounts_parent_role_idx
  ON portal_accounts (parent_id, role);

CREATE TABLE IF NOT EXISTS portal_licenses (
  id uuid PRIMARY KEY,
  phone varchar(15) NOT NULL UNIQUE CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  token_hash char(64) NOT NULL,
  reseller_id uuid NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  created_by_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_licenses_reseller_created_idx
  ON portal_licenses (reseller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS portal_licenses_created_by_idx
  ON portal_licenses (created_by_id);

CREATE TABLE IF NOT EXISTS portal_login_attempts (
  id bigserial PRIMARY KEY,
  ip_hash char(64) NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_login_attempts_ip_time_idx
  ON portal_login_attempts (ip_hash, attempted_at DESC);
