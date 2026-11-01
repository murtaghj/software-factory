export type ArtifactErrorCode =
  | 'forbidden' | 'not_found' | 'expired' | 'too_large' | 'digest_mismatch' | 'size_mismatch' | 'content_mismatch'
  | 'state_conflict' | 'artifact_unavailable' | 'ref_mismatch' | 'integrity_incident' | 'invalid_request';

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}
