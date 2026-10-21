CREATE UNIQUE INDEX IF NOT EXISTS portal_accounts_name_lower_uq
  ON portal_accounts (lower(name));
