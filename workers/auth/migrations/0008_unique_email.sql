-- New registrations require email. Existing pre-email accounts may remain NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
ON users(lower(email))
WHERE email IS NOT NULL;
