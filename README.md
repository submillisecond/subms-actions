# subms-actions

**Continuous performance testing as composable GitHub Actions.** Five
actions, a pre-commit hook, and a reusable workflow that turn any
JSON-emitting bench into a CI-gated, observable, sink-friendly, drift-aware
perf pipeline.

Speaks one stable JSON shape across runtimes. Rust and Java emit it
natively via the [`subms`](https://submillisecond.com/subms/) crate / jar;
JMH, Criterion, HdrHistogram plug in via tiny adapter scripts.

## What's in here

| | |
|---|---|
| [`actions/subms-action-bench`](actions/subms-action-bench/) | Run a bench command, capture stdout, validate JSON, retry on flake, warm up the runtime. |
| [`actions/subms-action-diff`](actions/subms-action-diff/) | Compare two perf JSON files. Sticky PR comment + step-summary table + per-stage thresholds + status-check tollgate. |
| [`actions/subms-action-diff-aggregate`](actions/subms-action-diff-aggregate/) | Roll N diffs (matrix runs) into a single comment + verdict. |
| [`actions/subms-action-diff-sink`](actions/subms-action-diff-sink/) | Push diff/summary JSON to **13 sinks**: Slack, HTTP/REST, S3, GCS, Azure Blob, Prometheus, InfluxDB, Datadog, Splunk HEC, New Relic, Honeycomb, file, stdout. Multi-sink dispatch. |
| [`actions/subms-action-drift`](actions/subms-action-drift/) | Detect slow drift (Welford mean ± k·σ) against a rolling window of historical JSON. |
| [`tools/precommit-perf-diff.js`](tools/PRE-COMMIT.md) | pre-commit hook: refuse local commits whose staged perf JSON regresses vs HEAD. |
| [`.github/workflows/subms-perf-suite.yml`](.github/workflows/subms-perf-suite.yml) | Reusable callable workflow: bench → diff → sink → drift in one job. |

## Quickstart

```yaml
jobs:
  perf:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: submillisecond/subms-action-bench@v1
        id: bench
        with:
          command: "cargo run --release --features harness --example perf_main < params.txt"
          output: candidate.json
      - uses: submillisecond/subms-action-diff@v1
        with:
          baseline: prior.json
          candidate: candidate.json
          threshold-pct: "15"
      - uses: submillisecond/subms-action-diff-sink@v1
        if: failure()
        with:
          input: subms-diff.json
          sink: slack
          webhook-url: ${{ secrets.SLACK_PERF_WEBHOOK }}
```

Or with the reusable workflow (one call wraps bench → diff → sink → drift):

```yaml
jobs:
  perf:
    uses: submillisecond/subms-actions/.github/workflows/subms-perf-suite.yml@v1
    secrets: inherit
    with:
      bench-command: "cargo run --release --features harness --example perf_main < params.txt"
      baseline-source: "base-ref"
      baseline-path: "perf/myworkload.rust.json"
      sink: "slack,prometheus"
      drift-history-glob: "history/myworkload-rust-*.json"
```

## The universal JSON contract

Every action consumes / emits this shape (or its diff variant). Producing
it from your toolchain is sufficient to plug in.

### `SubMsBenchSummary` (one bench run)

```jsonc
{
  "workload":  "my-workload",
  "lang":      "rust",                  // free-text tag
  "timestamp": "2026-05-19T13:11:58Z",  // ISO-8601 seconds-precision
  "inputs":    { "entries": "50000" },
  "meta":      { "host":    "ci-1" },
  "stages": {
    "put": {
      "count":      50000,
      "p50_ns":     300,
      "p99_ns":     1200,
      "p999_ns":    153900,
      "max_ns":     3895300,
      "mean_ns":    1761,
      "samples_ns": [...]               // optional, downsampled
    }
  }
}
```

`subms-diff.json` is the same shape with regression deltas added per stage.
See [docs/JSON-CONTRACT.md](docs/JSON-CONTRACT.md) for the full spec and
adapter notes (JMH, Criterion, HdrHistogram).

## Enterprise

See [docs/Enterprise.md](docs/Enterprise.md) for proxy / mTLS / OIDC /
audit-trail / CODEOWNERS routing / policy-as-code patterns.

## Why use these over JMH / Criterion / Micrometer?

- **Cross-toolchain.** One JSON shape, two native runtimes (Rust + Java), adapters for everything else.
- **First-class regression detection.** The diff action ships the gate - no per-team scripts.
- **Sticky PR comments + job summary + artifact + sink** out of the box.
- **Drift detection** - catches the "p99 has been creeping +1% per week" case static base-ref diffing misses.
- **Zero deps in the actions.** Composite + Node native; nothing to `npm install`.
- **Portable**. Use the actions, the pre-commit hook, OR the reusable workflow.
