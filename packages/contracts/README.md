# @factory/contracts (W-003)

Wire types and runtime validators for the reference contracts in `docs/spec/contracts`
(domain 2.0, API description 2.5.0, factory tools 1.0.0/1.1.0/1.2.0).

| Path | What it is |
| --- | --- |
| `scripts/generate.ts` | Deterministic generator. `pnpm contracts:generate` rewrites `src/generated/`. |
| `src/generated/` | **Generated, never hand-edited.** Schema copies, `domain.ts` (one type per `$defs` entry), `api.ts` (per-operation request/response types and route metadata), `tools.ts` (negotiated tool sets), copies of the reference TypeScript and `reference-compat.ts`. |
| `src/validate.ts` | Ajv (draft 2020-12, strict) validators: `validateContract(name, value)`, `assertContract`. |
| `src/stage-output.ts` | AC-18: `decodeStageOutcome` (rejects malformed JSON, unknown major versions and schema-invalid outcomes) and `SubmissionLedger` (bounded format repair inside `RunLimits.maxToolCalls`). |
| `src/compat.ts` | Breaking-change detection between contract revisions; baselines live in `baseline/`. |

## Checks

- `pnpm contracts:check` regenerates and fails if `src/generated/` differs from the commit.
- Typecheck fails if any generated type stops being mutually assignable with the
  specification's own `schemas.generated.ts` (`src/generated/reference-compat.ts`), or if the
  reference service interfaces (`interfaces.ts`) no longer compile against the generated types.
- `test/ac-260-contracts.test.ts` checks every fixture in `docs/spec/examples`, using the
  classification in `test/fixture-catalog.ts`:
  - **schema-positive**: validates.
  - **schema-negative**: rejected, with an Ajv error at the path and keyword the fixture's
    stated reason names.
  - **semantic**: the stated reason is a service predicate beyond JSON Schema. Its wire parts must
    still validate. It is owned by an out-of-scope package: W-141–W-143 (ai_only) or W-144
    (design-only delivery). **These predicates are not implemented in M1.**
  - **external**: a Kubernetes Job manifest, owned by W-017.

Static types do not express `if/then`, `not`, `contains`, bounds or formats; those are enforced only
by the runtime validators. Validate every envelope at its boundary.
