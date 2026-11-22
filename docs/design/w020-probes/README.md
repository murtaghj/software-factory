# W-020 probes

Throwaway probes run while writing and reviewing the W-020 brief (docs/m2-plan.md section 7.2,
probes Z1 to Z4, P1 to P3 and G1 to G4), on Node 24.22.2 and Git 2.50.1.

Only the scripts and their text results are kept here. The scratch trees and repositories they
produced are not committed: they contain nested Git repositories, a FIFO and symlinks that point
outside the tree (to /etc), which are the hostile cases being probed. Re-run a script to recreate
its tree. W-020a's own tests build these fixtures at test time.

Directories with a NOTES.md held probes run by hand with git commands; their commands and results
are in the section 7.2 table.
