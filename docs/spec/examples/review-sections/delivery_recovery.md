# Delivery and recovery

Deliver the exact verified candidate and migration as a PR using completion policy review_completed: remain available for up to three review rounds until required human approvals match the current head. Close or handover before that outcome is incomplete. No merge, preview or production authority is implied. Include a rollout note: additive schema first, compatible worker/handler next, staged enablement after release approval.

On rollout failure, disable new cancellations and keep draining acknowledged outbox work. Do not reverse already completed business cancellations or discard events by dropping the new table. Preserve audit data and use a reviewed roll-forward repair if data changes preclude rollback. A future release must qualify this procedure independently.
