# Product roadmap

These items are recorded for later design and are not part of the 6.4.2 release.

## Credit-backed LLM usage

Replace the temporary free-trial quota with a metered LLM service backed by Cloudflare. Referrals
grant Credit to the inviter; authenticated LLM calls consume Credit; users can pay to continue when
their balance is insufficient.

Before launch, define the Credit-to-usage rate and expiry policy, then implement an append-only
ledger for grants, purchases, reservations, consumption and refunds. Each LLM request needs an
idempotency key so retries cannot charge twice, and failed or cancelled upstream requests must
release reserved Credit. The account UI must show the current balance and usage history before any
purchase flow is enabled. Add per-account and per-source abuse controls before removing the current
trial quota.

## Phone verification

Add optional phone verification as a second trust and recovery signal alongside email. Store phone
numbers in normalized encrypted form, keep a separate keyed lookup hash for uniqueness, and never
publish the number on profiles. Verification codes need short expiry, attempt limits, resend
cooldowns and provider-independent delivery state. Define which actions require a verified phone
only after measuring referral and account abuse; ordinary anonymous and local device use should
remain available without it.
