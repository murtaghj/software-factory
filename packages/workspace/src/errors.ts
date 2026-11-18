export type WorkspaceErrorCode =
  // manager
  | 'conflict' | 'stale_epoch' | 'not_found' | 'invalid_state' | 'forbidden' | 'invalid_request' | 'not_supported'
  | 'writer_active' | 'publish_in_progress' | 'receipt_mismatch' | 'verifier_binding_required' | 'binding_mismatch'
  // paths and names
  | 'path_traversal' | 'escaping_symlink' | 'caller_supplied_url' | 'invalid_clone_url' | 'branch_outside_namespace'
  | 'root_inside_checkout' | 'unsafe_root' | 'path_collision' | 'tree_too_large' | 'duplicate_path' | 'checkpoint_not_accepted' | 'repository_not_registered' | 'repository_not_linked' | 'ambiguous_subpath'
  // materialization
  | 'target_exists' | 'thin_bundle' | 'bundle_invalid' | 'commit_not_found' | 'tree_digest_mismatch' | 'non_utf8_path'
  | 'non_utf8_symlink_target' | 'unsupported_tree_entry' | 'git_failed' | 'git_too_old' | 'invalid_subpath'
  // publisher
  | 'not_publishable' | 'push_failed'
  // setup
  | 'invalid_setup_profile' | 'unsupported_setup_feature' | 'executor_required' | 'output_outside_allowed_paths' | 'setup_failed' | 'setup_timeout';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details;
  }
}
