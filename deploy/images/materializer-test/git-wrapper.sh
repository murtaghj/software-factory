#!/bin/sh
# Test image only (A-31). The k3s tier needs a clone that is still running when the pod is told to stop, and a fixture on the
# image's own disk clones in milliseconds. A clone of /fixture/stall.git therefore writes a marker, starts a child and waits;
# every other call is the real Git. The child is what makes the check honest: when the group is killed it is orphaned, and
# only an init process as PID 1 reaps it (without one it stays a zombie and the group never reads as gone).
case " $* " in
  *" file:///fixture/stall.git "*) : > /tmp/stalled; sleep 600 & wait ;;
  *) exec /usr/bin/git.real "$@" ;;
esac
