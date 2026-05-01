#!/bin/bash
# Run vitest with full output captured to a timestamped file.
# Exit code preserved via PIPESTATUS. Use this anytime we need to
# investigate a flake without losing output to terminal truncation.
LOGFILE="/tmp/test-output-$(date +%Y%m%d-%H%M%S).txt"
echo "Capturing test output to $LOGFILE"
npm test 2>&1 | tee "$LOGFILE"
EXIT=${PIPESTATUS[0]}
echo "Exit code: $EXIT"
echo "Log: $LOGFILE"
exit $EXIT
