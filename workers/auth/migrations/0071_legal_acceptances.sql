-- Which version of the 用户协议 and 隐私政策 an account agreed to, and when. Registration writes
-- one row in the same batch as the account. A table rather than columns on users, so a later
-- re-acceptance of a new version adds a row instead of overwriting the earlier record.
-- Additive only: older Workers never read or write this table, and accounts created before it
-- simply have no row (they are not asked to re-accept yet).
CREATE TABLE legal_acceptances (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 terms_version TEXT NOT NULL CHECK(length(terms_version) BETWEEN 1 AND 64),
 accepted_at INTEGER NOT NULL,
 PRIMARY KEY(user_id, terms_version)
);
