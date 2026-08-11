-- Market moderation is attached to an account, not a shared administrator password.
-- No account is promoted by migration; the first administrator is selected explicitly
-- after registration so a public "first signup wins" race cannot grant privileges.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

CREATE INDEX idx_users_admin_role ON users(role) WHERE role = 'admin';
