# Build log

One line per completed package: package · ACs passing (ran and passed in that session) · assumptions · spec issues.

- W-002 Repository and pinned toolchain · AC-260 (toolchain half: pinned versions, digest-pinned images, frozen lockfile, lint/typecheck/boundary violations fail) · A-01, A-02 · none
- W-003 Contract baseline and generation · AC-260 (contract half: reproducible generation, strict Ajv compile of 312 defs, reference-type compat, 94 positive + 36 schema-negative fixtures with stated reasons, 31 spec-validator negatives, tool-set frozen readers, breaking-change gate), AC-18 (decoder + bounded format repair; gate half lands in W-012) · none · SI-01, SI-02. 226 semantic negative fixtures are classified and wire-valid but deferred to W-141–W-144 (out of scope)
- W-003 review fixes (independent review) · AC-260, AC-18 re-verified from a clean worktree · none · SI-03
- W-004 Representative fixture system · AC-20 (red/lock/green verified on pinned faulty/fixed releases; DB-outage baseline inconclusive; edited-copy and incomparable-environment candidates invalid), AC-25 (happy-path candidate incomplete despite author claim), AC-32 (boundary evidence blames orders, not the last-erroring inventory; two controls) · A-03 · none
- W-006 Database migrations and repositories · AC-05 (DB layer: RLS read/write isolation, tenant-qualified FKs, fail-closed without tenant), AC-58 (expand/backfill/contract with dual readers, per-tenant restartable backfill, reader-retirement gate; Temporal history replay half pending W-011), AC-203 (runtime column grants, no org creation, immutable digests/evidence/tool identity, irreversible proposal acceptance, terminal tool calls, git_object_id) · A-04 · SI-04, SI-05, SI-06
