# Interfaces and data

POST /orders/{id}/cancel uses authenticated customer identity and an idempotency key. Success returns the stable cancellation result. Foreign orders use the existing nondisclosing access response; fulfilled orders return a conflict. Reusing a key for a different request is a conflict.

Add a unique cancellation identity, audit event and outbox record. A unique logical order-cancellation constraint and transaction locking prevent distinct keys from cancelling the same order twice. Preserve the current order schema and event consumer compatibility; no column removal or contract narrowing.
