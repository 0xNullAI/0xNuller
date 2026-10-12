-- A native installation keeps this random key across FCM FID rotations. The
-- key is scoped to an account so one account cannot replace another's devices.
-- Legacy registrations remain nullable and continue to work until upgraded.
ALTER TABLE push_registrations ADD COLUMN installation_key TEXT;
CREATE UNIQUE INDEX push_registrations_account_installation
  ON push_registrations(user_id, installation_key)
  WHERE installation_key IS NOT NULL;
