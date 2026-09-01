#!/usr/bin/env bash
# Run every unit test. No dependencies beyond node.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

status=0
for file in *.test.js; do
  echo "== $file"
  node "$file" || status=1
  echo
done

if [[ $status -eq 0 ]]; then echo "all suites passed"; else echo "FAILURES"; fi
exit $status
