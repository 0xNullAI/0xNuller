-- Product decision (2026-10-11): profiles are discoverable by default, including accounts
-- created while discovery was opt-in. Users can still turn discovery off in their profile.
UPDATE user_profiles SET discoverable = 1 WHERE discoverable = 0;
