// A stand-in for @factory/database inside the materializer image: the pod has no database. The one value the
// workspace package imports from it (a registry lookup) refuses to run.
export function resolveRepositorySource() {
  throw new Error('the pod executor has no database');
}
