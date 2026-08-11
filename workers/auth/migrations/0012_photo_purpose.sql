ALTER TABLE user_photos ADD COLUMN purpose TEXT NOT NULL DEFAULT 'album';
CREATE INDEX idx_photos_album ON user_photos (user_id, purpose, created_at DESC);
