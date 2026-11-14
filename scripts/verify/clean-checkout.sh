#!/usr/bin/env bash
# Clean-checkout verification.
#
# Copies only the files a checkout would contain (no node_modules, no lib, no
# read-only recon/team state), installs from the lockfile, then runs the gate
# (typecheck -> test -> build -> test -> check), the t5 core suite and the
# repair-round probes on the fresh bytes.
#
# Since t7 the package carries `pretest: pnpm run build`, so a literal
# `typecheck && test && build` chain also works: `pnpm test` builds first. The
# explicit build/test steps below keep every exit code visible either way.
#
# Usage: bash scripts/verify/clean-checkout.sh
# Exit code: 0 only when every step exits 0.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loomy-clean-XXXXXX")"
CLEAN="${TMP_ROOT}/repo"
mkdir -p "${CLEAN}"

echo "repo:  ${REPO_ROOT}"
echo "clean: ${CLEAN}"

rsync -a \
  --exclude node_modules \
  --exclude lib \
  --exclude .refs \
  --exclude .agent-teams \
  --exclude .memsearch \
  --exclude .pnpm-store \
  --exclude .pnpm-cache \
  "${REPO_ROOT}/" "${CLEAN}/"

cd "${CLEAN}" || exit 1

declare -a NAMES=()
declare -a CODES=()

record() {
  local name="$1"
  local code="$2"
  NAMES+=("${name}")
  CODES+=("${code}")
  printf '%-32s exit %s\n' "${name}" "${code}"
}

run() {
  local name="$1"
  shift
  echo ""
  echo "=== ${name}: $* ==="
  "$@"
  record "${name}" "$?"
}

run "pnpm install" pnpm install
run "pnpm typecheck" pnpm typecheck
run "pnpm test (pretest builds first)" pnpm test
run "pnpm build" pnpm build
run "pnpm test (after explicit build)" pnpm test
run "pnpm check" pnpm check
run "t5 core suite" node scripts/verify/run-all.mjs
run "repair probes" node scripts/verify/run-repairs.mjs

echo ""
echo "== summary =="
FAILED=0
for index in "${!NAMES[@]}"; do
  name="${NAMES[$index]}"
  code="${CODES[$index]}"
  if [[ "${code}" -ne 0 ]]; then
    echo "  FAIL ${name} (exit ${code})"
    FAILED=1
  else
    echo "  PASS ${name}"
  fi
done

rm -rf "${TMP_ROOT}"
exit "${FAILED}"
