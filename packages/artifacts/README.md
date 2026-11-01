# @factory/artifacts (W-007)

The chapter 02 artifact storage protocol, behind a trusted `ArtifactService`.

1. `reserve` (stage producers) and `reserveOwned` (trusted controllers) authorize the
   authenticated producer and bind the upload to its org, scope, authority, media type, schema
   version, classification and size limit. Embargo group and data classification are derived
   from the task or application, never supplied by the caller. Owner scopes are closed unless an
   `OwnerAuthority` verifies current authority (default: deny).
2. `upload` takes an HMAC upload capability that writes only that upload's temporary key, within
   its byte limit.
3. `finalize` checks producer, scope and stage are still current. It verifies length, SHA-256 and
   JSON content/schema version against the reservation, then promotes the object to the immutable
   `org/{orgId}/sha256/{digest}` key by conditional create. An existing object is re-hashed; a
   mismatch is an integrity incident. Metadata is registered in one transaction. Rows are reused
   only when all metadata matches, and retention only extends.
4. `readVerified` is the only read path for a gate. The registration must exist and match the ref,
   and the bytes must hash correctly. A missing object is `artifact_unavailable` and is never
   regenerated.
5. `access` returns a short-lived download capability for the isolated download origin
   (`startDownloadOrigin`, AC-49):
   - Active types (HTML, SVG, unknown) are served as `application/octet-stream` attachments.
   - Inert allow-listed types get an inline preview.
   - Every response carries `nosniff`, a `sandbox` CSP, `no-store` and no CORS.
   - Cookies and Authorization headers are ignored.
6. `sweepExpiredUploads` and `sweepOrphanObjects` run only as the separate `factory_retention`
   job role. That role can bypass RLS, so embargoed registrations are never mistaken for orphans.
   Each deletion re-checks reachability first.

Denied operations are audited in their own committed transaction. `FileObjectStore` is the
local-development store (docs/assumptions.md A-05).
