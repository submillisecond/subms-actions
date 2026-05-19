# subms-perf-diff - pre-commit hook

A pre-commit hook that catches perf regressions **before they leave your
laptop**. Reads every staged subms perf JSON file, diffs it against the
HEAD revision of the same file, and refuses the commit when any stage
regresses beyond the configured threshold.

Mirrors the [`subms-action-diff`](.github/actions/subms-action-diff/) GitHub Action's gate,
so local developers and CI agree about what counts as a regression.

**Crucially: the hook does NOT re-run benches.** It compares the JSON you've
staged against the JSON already in HEAD. That keeps the hook fast (<100 ms)
and means the bench-runner workflow stays separate (it can take 30+ seconds;
that doesn't belong in pre-commit).

## Install

Using [pre-commit.com](https://pre-commit.com/) - the cross-language hook
runner - add to your repo's `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/submillisecond/subms-actions    # or your fork
    rev: v0.3.0                                     # pin to a release
    hooks:
      - id: subms-perf-diff
```

Then once:

```sh
pip install pre-commit
pre-commit install
```

The hook fires on every commit that touches a matching perf JSON path:
`*.perf.json`, `*.bench.json`, `**/perf/*.json`, `**/bench/*.json`.

For the no-framework path, drop the script in your repo and wire it into
`.git/hooks/pre-commit` directly:

```sh
#!/usr/bin/env bash
files=$(git diff --cached --name-only --diff-filter=ACMR -- '**/perf/*.json' '**/bench/*.json')
[ -n "$files" ] && node tools/precommit-perf-diff.js $files
```

## Configuration

All knobs are env vars - no config file required. Set them in your shell or
in `.pre-commit-config.yaml`:

```yaml
hooks:
  - id: subms-perf-diff
    env:
      SUBMS_PRECOMMIT_THRESHOLD_PCT: "15"
      SUBMS_PRECOMMIT_PER_STAGE: '{"slow_path":25,"warmup":50}'
```

| env var | default | description |
|---|---|---|
| `SUBMS_PRECOMMIT_THRESHOLD_PCT` | `10` | Global regression threshold (percent). |
| `SUBMS_PRECOMMIT_PER_STAGE` | `""` | JSON object of per-stage overrides. |
| `SUBMS_PRECOMMIT_FAIL_ON_REGRESS` | `true` | Set `false` for warn-only mode. |

## What it prints

**Clean commit:**

```text
subms-perf-diff: perf/<workload>.rust.json OK (worst 2.4% put, 0.8% get_hit)
```

**Regression - commit blocked:**

```text
subms-perf-diff: perf/<workload>.rust.json REGRESSED
  threshold=+10%
  put          p99        1.2us ->     1.5us     +25.0%  (threshold +10.0%)

Commit blocked by subms-perf-diff. Investigate the regression, or override:
  SUBMS_PRECOMMIT_THRESHOLD_PCT=20 git commit ...            # bump threshold once
  SUBMS_PRECOMMIT_PER_STAGE='{"slow_path":25}' git commit ... # per-stage override
  SUBMS_PRECOMMIT_FAIL_ON_REGRESS=false git commit ...      # warn-only mode
  git commit --no-verify ...                                # bypass all pre-commit hooks
```

## Two hook IDs

- `subms-perf-diff` (default) - refuses commits on regression.
- `subms-perf-summary` - read-only; just prints the percentile table. Useful
  to enable alongside the diff hook when you want to *see* numbers on every
  commit, or alone in projects that don't yet have a baseline to compare
  against.

## Why pre-commit, not "run the bench every commit"

Benches take seconds. Devs commit dozens of times an hour. Running benches
in pre-commit is a path to people uninstalling the hook. The split that
works:

| stage | what runs |
|---|---|
| **local bench script** | re-run benches when you want; produces new perf JSON |
| **pre-commit** | quick `git diff`-style check that the staged JSON didn't regress vs HEAD |
| **CI** ([`subms-action-diff` action](.github/actions/subms-action-diff/)) | re-run benches in a clean env, compare against the base ref |
| **nightly** ([`subms-action-drift` action](.github/actions/subms-action-drift/)) | trend analysis over the last N runs |

The pre-commit hook is the cheapest possible gate: it catches the case
"I bumped the LSM put cost by 25% and remembered to re-bench but forgot
the regression was material" - which is the dominant pre-merge failure
mode in real projects.
