# Risks and decisions

R1 is duplicate cancellation/release during a race. The proposed mitigation is transaction locking, a unique cancellation identity and stable consumer dedupe; S2/S6 must demonstrate the outcome.

R2 is a durable cancellation with inventory temporarily unavailable. The proposed mitigation is outbox retry and operational visibility; S7 must demonstrate eventual single release. These are planned mitigations awaiting implementation evidence. Any unsupported consumer assumption reopens design review before implementation proceeds.
