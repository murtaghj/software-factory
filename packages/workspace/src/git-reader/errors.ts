// Typed refusals of the untrusted-Git reader (W-020a). The code list is closed: a refusal names the
// file (relative to the generation directory) and the rule, and never carries more than 64 bytes of
// content, as hex. Anything the reader throws that is not a ReaderError is a bug.
export type ReaderErrorCode =
  // the request and the file system
  | 'invalid_request' | 'invalid_limits' | 'path_unsafe' | 'unreadable' | 'not_regular_file' | 'file_changed' | 'output_exists' | 'limit_exceeded'
  // objects, packs, deltas and zlib
  | 'object_missing' | 'object_corrupt' | 'unsupported_pack' | 'preset_dictionary' | 'truncated' | 'zlib_error' | 'trailing_data'
  // refs
  | 'unsupported_ref_storage' | 'invalid_ref' | 'unsupported_hash'
  // trees, paths and symlinks (the first three, `duplicate_path` and `escaping_symlink` use W-018's codes)
  | 'unsupported_tree_entry' | 'non_utf8_path' | 'non_utf8_symlink_target' | 'invalid_path' | 'duplicate_path' | 'escaping_symlink'
  // the index
  | 'invalid_index' | 'unmerged_index' | 'submodule' | 'split_index' | 'sparse_index' | 'unsupported_index';

export const READER_ERROR_CODES = [
  'invalid_request', 'invalid_limits', 'path_unsafe', 'unreadable', 'not_regular_file', 'file_changed', 'output_exists', 'limit_exceeded',
  'object_missing', 'object_corrupt', 'unsupported_pack', 'preset_dictionary', 'truncated', 'zlib_error', 'trailing_data',
  'unsupported_ref_storage', 'invalid_ref', 'unsupported_hash',
  'unsupported_tree_entry', 'non_utf8_path', 'non_utf8_symlink_target', 'invalid_path', 'duplicate_path', 'escaping_symlink',
  'invalid_index', 'unmerged_index', 'submodule', 'split_index', 'sparse_index', 'unsupported_index',
] as const satisfies readonly ReaderErrorCode[];

export type ReaderErrorDetail = { file?: string; limit?: string; reason?: string; content?: Uint8Array };

export const MAX_ERROR_CONTENT_BYTES = 64;

// A file name chosen by a candidate, made safe to put in a message: printable ASCII kept, every other byte as \xNN, at most 160 characters.
export function printable(name: Uint8Array): string {
  let out = '';
  for (const b of name) {
    out += b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
    if (out.length >= 160) return `${out.slice(0, 160)}...`;
  }
  return out;
}

export class ReaderError extends Error {
  readonly code: ReaderErrorCode;
  readonly file: string | undefined;
  readonly limit: string | undefined;
  readonly reason: string | undefined;
  // At most 64 bytes of what was refused, as lowercase hex.
  readonly contentHex: string | undefined;

  constructor(code: ReaderErrorCode, detail: ReaderErrorDetail = {}) {
    const hex = detail.content === undefined ? undefined : Buffer.from(detail.content.subarray(0, MAX_ERROR_CONTENT_BYTES)).toString('hex');
    super([code, detail.reason, detail.limit === undefined ? undefined : `limit ${detail.limit}`, detail.file === undefined ? undefined : `file ${detail.file}`, hex === undefined ? undefined : `content ${hex}`].filter((x) => x !== undefined).join(': '));
    this.name = 'ReaderError';
    this.code = code;
    this.file = detail.file;
    this.limit = detail.limit;
    this.reason = detail.reason;
    this.contentHex = hex;
  }
}

export const refuse = (code: ReaderErrorCode, reason: string, file?: string, content?: Uint8Array): ReaderError =>
  new ReaderError(code, { reason, ...(file === undefined ? {} : { file }), ...(content === undefined ? {} : { content }) });

export const limitError = (limit: string, reason: string, file?: string): ReaderError =>
  new ReaderError('limit_exceeded', { limit, reason, ...(file === undefined ? {} : { file }) });
