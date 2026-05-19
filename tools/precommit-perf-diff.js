#!/usr/bin/env node
//
// Pre-commit hook: diff each staged subms perf JSON against its HEAD version
// and refuse the commit on regression. Self-contained (Node std lib only, no
// npm deps). Compatible with https://pre-commit.com - the hook framework
// passes staged filenames as positional args.
//
// Local dev usage outside pre-commit:
//   node tools/precommit-perf-diff.js path/to/perf.json [more paths...]
//   node tools/precommit-perf-diff.js --summary-only path/to/perf.json
//
// Configuration via env (set in .pre-commit-config.yaml `args:` or shell):
//   SUBMS_PRECOMMIT_THRESHOLD_PCT   default 10
//   SUBMS_PRECOMMIT_PER_STAGE       JSON object e.g. {"get_miss":25}
//   SUBMS_PRECOMMIT_FAIL_ON_REGRESS "true" (default) - exit non-zero on regression
//
// Exit codes:
//   0  no regressions (or summary-only mode)
//   1  one or more files regressed
//   2  configuration / I/O error
//
// The hook intentionally never re-runs benches - that's slow and unsuitable
// for a commit-time gate. It compares the staged JSON against the JSON in
// HEAD, which is what local devs check in after they have re-benched.

"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const summaryOnly = args.includes("--summary-only");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  process.exit(0);   // nothing staged; pre-commit invoked us with no matches
}

const THRESHOLD_PCT = Number.parseFloat(process.env.SUBMS_PRECOMMIT_THRESHOLD_PCT || "10");
const FAIL_ON_REGRESSION = (process.env.SUBMS_PRECOMMIT_FAIL_ON_REGRESS || "true") === "true";

let perStageThresholds = {};
try {
  if (process.env.SUBMS_PRECOMMIT_PER_STAGE) {
    perStageThresholds = JSON.parse(process.env.SUBMS_PRECOMMIT_PER_STAGE);
  }
} catch (e) {
  process.stderr.write(`subms-perf-diff: SUBMS_PRECOMMIT_PER_STAGE not valid JSON: ${e.message}\n`);
  process.exit(2);
}

function thresholdFor(stage) {
  return Object.prototype.hasOwnProperty.call(perStageThresholds, stage)
    ? Number.parseFloat(perStageThresholds[stage])
    : THRESHOLD_PCT;
}

/** Read a file's HEAD revision. Returns null when the file is new (no HEAD entry). */
function readFromHead(path) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  } catch (_) {
    return null;
  }
}

function readStaged(path) {
  return fs.readFileSync(path, "utf8");
}

function loadFirstSummary(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}: not valid JSON (${e.message})`);
  }
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function formatNs(ns) {
  const abs = Math.abs(ns);
  if (abs < 1_000) return `${Math.round(ns)}ns`;
  if (abs < 1_000_000) return `${(ns / 1_000).toFixed(1)}us`;
  return `${(ns / 1_000_000).toFixed(2)}ms`;
}

function fmtPct(p) {
  return Number.isFinite(p) ? `${p >= 0 ? "+" : ""}${p.toFixed(1)}%` : "+inf%";
}

function diffMetric(metric, base, cand) {
  const delta = cand - base;
  const pct = base === 0 ? (cand === 0 ? 0.0 : Number.POSITIVE_INFINITY) : (100 * delta) / base;
  return { metric, base, cand, delta, pct };
}

function printSummaryTable(label, summary) {
  process.stdout.write(`\n${label}\n`);
  process.stdout.write(`  ${"stage".padEnd(12)}  ${"p50".padStart(9)}  ${"p99".padStart(9)}  ${"p99.9".padStart(9)}  ${"max".padStart(9)}  ${"mean".padStart(9)}\n`);
  for (const [name, s] of Object.entries(summary.stages || {})) {
    process.stdout.write(
      `  ${name.padEnd(12)}  ${formatNs(s.p50_ns).padStart(9)}  ${formatNs(s.p99_ns).padStart(9)}  ${formatNs(s.p999_ns).padStart(9)}  ${formatNs(s.max_ns).padStart(9)}  ${formatNs(s.mean_ns).padStart(9)}\n`,
    );
  }
}

let anyRegression = false;

for (const path of files) {
  let staged;
  try {
    staged = loadFirstSummary(readStaged(path), path);
  } catch (e) {
    process.stderr.write(`subms-perf-diff: ${path}: ${e.message}\n`);
    process.exit(2);
  }

  if (summaryOnly) {
    printSummaryTable(`${path}`, staged);
    continue;
  }

  const headRaw = readFromHead(path);
  if (headRaw === null) {
    process.stdout.write(`subms-perf-diff: ${path} is new; baseline not in HEAD, skipping diff.\n`);
    continue;
  }
  let baseline;
  try {
    baseline = loadFirstSummary(headRaw, `${path}@HEAD`);
  } catch (e) {
    process.stderr.write(`subms-perf-diff: ${path}@HEAD: ${e.message}\n`);
    process.exit(2);
  }

  // Compute per-stage diff; track worst regression and which metric it lives on.
  const stageRows = [];
  let fileRegressed = false;
  for (const [stage, s] of Object.entries(staged.stages || {})) {
    const b = (baseline.stages || {})[stage];
    if (!b) continue;
    const metrics = [
      diffMetric("p50",   b.p50_ns,  s.p50_ns),
      diffMetric("p99",   b.p99_ns,  s.p99_ns),
      diffMetric("p99.9", b.p999_ns, s.p999_ns),
      diffMetric("max",   b.max_ns,  s.max_ns),
      diffMetric("mean",  b.mean_ns, s.mean_ns),
    ];
    let worst = 0;
    let worstMetric = null;
    for (const m of metrics) {
      if (Number.isFinite(m.pct) && m.pct > worst) {
        worst = m.pct;
        worstMetric = m;
      }
    }
    const limit = thresholdFor(stage);
    const regressed = worst > limit;
    if (regressed) fileRegressed = true;
    stageRows.push({ stage, worst, limit, regressed, worstMetric });
  }

  if (!fileRegressed) {
    process.stdout.write(`subms-perf-diff: ${path} OK (worst ${stageRows.length ? stageRows.map((r) => r.worst.toFixed(1) + "% " + r.stage).join(", ") : "no stages"})\n`);
    continue;
  }

  anyRegression = true;
  process.stderr.write(`\nsubms-perf-diff: ${path} REGRESSED\n`);
  process.stderr.write(`  threshold=+${THRESHOLD_PCT}%`);
  if (Object.keys(perStageThresholds).length > 0) {
    process.stderr.write(`  per-stage=${JSON.stringify(perStageThresholds)}`);
  }
  process.stderr.write("\n");
  for (const row of stageRows) {
    if (!row.regressed) continue;
    const m = row.worstMetric;
    process.stderr.write(
      `  ${row.stage.padEnd(12)} ${m.metric.padEnd(6)} ${formatNs(m.base).padStart(9)} -> ${formatNs(m.cand).padStart(9)}  ${fmtPct(m.pct).padStart(9)}  (threshold +${row.limit.toFixed(1)}%)\n`,
    );
  }
}

if (anyRegression && FAIL_ON_REGRESSION) {
  process.stderr.write(
    "\nCommit blocked by subms-perf-diff. Investigate the regression, or override:\n" +
      "  SUBMS_PRECOMMIT_THRESHOLD_PCT=20 git commit ...            # bump threshold once\n" +
      "  SUBMS_PRECOMMIT_PER_STAGE='{\"slow_path\":25}' git commit ... # per-stage override\n" +
      "  SUBMS_PRECOMMIT_FAIL_ON_REGRESS=false git commit ...      # warn-only mode\n" +
      "  git commit --no-verify ...                                # bypass all pre-commit hooks\n",
  );
  process.exit(1);
}

process.exit(0);
