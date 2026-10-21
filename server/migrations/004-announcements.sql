CREATE TABLE IF NOT EXISTS portal_announcement (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  title varchar(120) NOT NULL,
  message varchar(3000) NOT NULL,
  updated_by_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
