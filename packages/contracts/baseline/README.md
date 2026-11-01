# Contract compatibility baselines

`1.13/` holds the accepted domain 2.0 / API 2.5.0 contracts from specification revision 1.13.
`pnpm contracts:check` compares docs/spec/contracts against the latest baseline and fails on any
breaking change. Update a baseline only when a contract revision is deliberately accepted.
