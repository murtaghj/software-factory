# Quality and security

Customer identity must come from the authenticated context, not an arbitrary request body. Queries must scope every read/write to that identity and avoid leaking foreign order existence. Keep customer data out of logs.

S3 tests forbidden access, S2/S6 test duplicate and concurrent attempts, and S7 tests recovery after an inventory outage. Existing service latency/resource guardrails remain in force; run the same fixture workload before and after. No new UI is included, so interaction/accessibility changes are not applicable to this API-only slice.
