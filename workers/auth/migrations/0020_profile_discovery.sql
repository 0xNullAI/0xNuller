-- Discovery is opt-in. Existing profiles remain undiscoverable and keep their
-- previous visibility, so this migration cannot publish old profile data.
ALTER TABLE user_profiles ADD COLUMN interests TEXT;
ALTER TABLE user_profiles ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0
  CHECK (discoverable IN (0, 1));

CREATE INDEX idx_profiles_discoverable_updated
  ON user_profiles (discoverable, visibility, updated_at DESC);
