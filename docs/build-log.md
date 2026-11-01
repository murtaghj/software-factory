# Build log

One line per completed package: package · ACs passing (ran and passed in that session) · assumptions · spec issues.

- W-002 Repository and pinned toolchain · AC-260 (toolchain half: pinned versions, digest-pinned images, frozen lockfile, lint/typecheck/boundary violations fail) · A-01, A-02 · none
- W-003 Contract baseline and generation · AC-260 (contract half: reproducible generation, strict Ajv compile of 312 defs, reference-type compat, 94 positive + 36 schema-negative fixtures with stated reasons, 31 spec-validator negatives, tool-set frozen readers, breaking-change gate), AC-18 (decoder + bounded format repair; gate half lands in W-012) · none · SI-01, SI-02. 226 semantic negative fixtures are classified and wire-valid but deferred to W-141–W-144 (out of scope)
