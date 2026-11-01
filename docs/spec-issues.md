# Specification issues

Problems found in docs/spec (revision 1.13) while implementing. The spec is never edited here;
each entry records the location, the problem, the choice made and why (most conservative reading).

| ID | Location | Problem | Choice made | Why |
| --- | --- | --- | --- | --- |
| SI-01 | contracts/factory-tools*.schema.json `x-tools` | Tool manifests reference `./domain.schema.json#/$defs/...`. Resolved against the manifests' `$id` (`https://factory.example/spec/factory-tools/1.2.0`), that names `https://factory.example/spec/factory-tools/domain.schema.json`, not the domain `$id` `https://factory.example/spec/domain/2.0`. | Resolve the references file-relative (sibling file `domain.schema.json`), as tools/validate_spec.py does. | This doesn't change behaviour. The references sit inside an annotation keyword, so JSON Schema never dereferences them. |
| SI-02 | examples/ai-review (negatives without `expect`/`error`) | 8 schema-rejectable negatives and about 100 adversarial negatives state only `"expected": "reject"` or nothing. Their reason exists only in the file name. | For the 8 schema negatives, the expected Ajv path and keyword are derived from the file name (packages/contracts/test/fixture-catalog.ts `NAMED_SCHEMA_NEGATIVES`) and asserted. The adversarial ones are semantic and deferred to W-141–W-143. | A test can only check "rejected for the stated reason" if the reason is stated. Deriving it from the name is the most literal reading. |
