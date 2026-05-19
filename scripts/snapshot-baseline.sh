#!/usr/bin/env bash
#
# Snapshot the base ref's perf JSON for a (workload, lang) pair into a local
# file the diff action can read. Shared between caller matrix workflows and
# the reusable subms-perf-suite workflow so the logic is unit-testable and
# kept in one place.
#
# Inputs (env):
#   BASE_SHA        SHA to fetch the perf JSON from (typically the PR base)
#   PERF_PATH       repo-relative path to the perf JSON
#   OUTPUT_FILE     where to write the snapshot (default: baseline.json)
#   FALLBACK        "skip" (default) emits `exists=false` on $GITHUB_OUTPUT and exits 0
#                   "copy-candidate" copies $CANDIDATE_FILE so the diff becomes a no-op
#                   "fail" exits 1
#   CANDIDATE_FILE  used only when FALLBACK=copy-candidate
#
# Writes:
#   exists=true|false       on $GITHUB_OUTPUT (consumed by `if:` guards)
#   $OUTPUT_FILE            the snapshotted JSON (or candidate copy)

set -euo pipefail

: "${BASE_SHA:?BASE_SHA env var is required}"
: "${PERF_PATH:?PERF_PATH env var is required}"
OUTPUT_FILE="${OUTPUT_FILE:-baseline.json}"
FALLBACK="${FALLBACK:-skip}"

write_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >> "$GITHUB_OUTPUT"
  fi
}

if git cat-file -e "${BASE_SHA}:${PERF_PATH}" 2>/dev/null; then
  git show "${BASE_SHA}:${PERF_PATH}" > "${OUTPUT_FILE}"
  write_output "exists=true"
  echo "snapshot-baseline: ${PERF_PATH}@${BASE_SHA::10} -> ${OUTPUT_FILE}"
  exit 0
fi

case "${FALLBACK}" in
  skip)
    write_output "exists=false"
    echo "snapshot-baseline: ${PERF_PATH} not present at ${BASE_SHA::10}; skipping diff."
    exit 0
    ;;
  copy-candidate)
    : "${CANDIDATE_FILE:?CANDIDATE_FILE env var required when FALLBACK=copy-candidate}"
    cp "${CANDIDATE_FILE}" "${OUTPUT_FILE}"
    write_output "exists=false"
    echo "snapshot-baseline: no baseline at ${BASE_SHA::10}; using candidate as baseline (no-op diff)."
    exit 0
    ;;
  fail)
    write_output "exists=false"
    echo "snapshot-baseline: ${PERF_PATH} missing at ${BASE_SHA::10}; failing as configured." >&2
    exit 1
    ;;
  *)
    echo "snapshot-baseline: unknown FALLBACK=${FALLBACK}; expected skip|copy-candidate|fail." >&2
    exit 2
    ;;
esac
