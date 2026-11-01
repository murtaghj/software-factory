# Design and alternatives

On cancellation, lock the order and validate ownership/state in one transaction. Write the cancellation result, one audit event and one outbox record atomically. Replay returns the original result. The worker releases inventory using the stable cancellation event ID.

A synchronous inventory call was rejected because a remote timeout would leave cancellation and stock state ambiguous. The outbox adds retry/operational work but makes the local decision durable. Inventory release remains asynchronous; the API never claims that stock release has completed.
