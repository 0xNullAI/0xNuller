-- Keep only a digest of a managed visual request alongside its reservation.
-- Raw camera frames remain transient in the proxy/provider request.
ALTER TABLE text_billing_outbox ADD COLUMN request_hash TEXT;
