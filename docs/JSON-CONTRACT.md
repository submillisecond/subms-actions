# JSON contract

The actions consume / emit two shapes. Any tool that can produce either
plugs in.

## `SubMsBenchSummary` - one bench run

```jsonc
{
  "workload":  "my-workload",
  "lang":      "rust",                        // free-text tag (rust / java / py / ...)
  "timestamp": "2026-05-19T13:11:58Z",        // ISO-8601, seconds precision, trailing Z
  "inputs":    { "<key>": "<value>", ... },   // workload-driving knobs (entries, warmup, ...)
  "meta":      { "<key>": "<value>", ... },   // anything else (host, jvm, sstables, ...)
  "stages": {
    "<stage-name>": {
      "count":      <int>,                    // number of samples recorded
      "p50_ns":     <int>,                    // 50th percentile, nanoseconds
      "p99_ns":     <int>,                    // 99th percentile
      "p999_ns":    <int>,                    // 99.9th percentile
      "max_ns":     <int>,
      "mean_ns":    <int>,
      "samples_ns": [<int>, ...]              // optional, chronological, downsampled to 500
    }
  }
}
```

`stages` is an **object keyed by stage name**, NOT an array. Insertion
order in the JSON should match the registration order in the harness
(V8 preserves non-integer string keys' insertion order).

A "sweep" - several runs of the same workload with varied inputs - is
emitted as a **JSON array of summaries**: `[<summary>, <summary>, ...]`.
The actions accept either single-object or array form transparently
(they take the first element when an array is passed where one summary
is expected).

## `SubMsBenchDiff` - regression analysis between two summaries

Emitted by `subms-action-diff`:

```jsonc
{
  "baseline_workload":         "my-workload",
  "candidate_workload":        "my-workload",
  "lang":                      "rust",
  "regression_threshold_pct":  15.0,
  "per_stage_thresholds":      { "<stage>": <pct>, ... },
  "has_regression":            true,
  "stages": [
    {
      "stage":                 "put",
      "worst_regression_pct":  25.0,         // max delta_pct across this stage's metrics
      "metrics": [
        { "metric": "p50",   "baseline_ns": <int>, "candidate_ns": <int>, "delta_ns": <int>, "delta_pct": <num> },
        { "metric": "p99",   "baseline_ns": <int>, "candidate_ns": <int>, "delta_ns": <int>, "delta_pct": <num> },
        { "metric": "p99.9", "baseline_ns": <int>, "candidate_ns": <int>, "delta_ns": <int>, "delta_pct": <num> },
        { "metric": "max",   "baseline_ns": <int>, "candidate_ns": <int>, "delta_ns": <int>, "delta_pct": <num> },
        { "metric": "mean",  "baseline_ns": <int>, "candidate_ns": <int>, "delta_ns": <int>, "delta_pct": <num> }
      ]
    }
  ],
  "baseline_only_stages":      [<string>, ...],   // dropped / renamed
  "candidate_only_stages":     [<string>, ...]    // newly added
}
```

`stages` is an **array** in the diff (registration order from the
candidate), NOT an object. `delta_pct` is `null` when the baseline was 0
and the candidate is non-zero (`f64::INFINITY` in Rust).

## Drift output - `subms-drift.json`

```jsonc
{
  "comment_marker":  "subms-drift",
  "component":       "my-workload (rust)",
  "workload":        "my-workload",
  "lang":            "rust",
  "metric":          "p99",
  "k_stddev":        3,
  "min_history":     5,
  "history_count":   12,
  "enough_history":  true,
  "has_drift":       true,
  "rows": [
    { "stage": "put", "value": <ns>, "mean": <ns>, "stddev": <ns>, "sigma": <num>, "n": <int> }
  ]
}
```

## Aggregate output - `subms-diff-aggregate.json`

```jsonc
{
  "comment_marker":            "subms-diff-aggregate",
  "has_regression":            true,
  "component_count":           32,
  "regressed_component_count": 2,
  "top": [
    {
      "component":             "<workload> (<lang>)",
      "stage":                 "put",
      "worst_regression_pct":  25.3,
      "threshold":             15.0,
      "regressed":             true
    }
  ]
}
```

## Producing the contract from existing tools

### Rust - `subms` crate

Native. `subms::summary_to_json(&summary, &mut writer)` emits the exact
shape.

### Java - `subms` jar

Native. `SubMsBench.summaryToJson(summary, printStream)` emits the exact
shape.

### JMH

`-rf json` produces JMH's own structure. Map per-benchmark:

```js
// JMH: results[i].primaryMetric.scorePercentiles = { "50.0": ms, "99.0": ms, ... }
const scoreFactor = scoreUnitToNsFactor(jmh.scoreUnit);  // e.g. ms -> 1_000_000
const stage = {
  count:      jmh.measurementIterations * jmh.measurementBatchSize,
  p50_ns:     Math.round(jmh.primaryMetric.scorePercentiles["50.0"]  * scoreFactor),
  p99_ns:     Math.round(jmh.primaryMetric.scorePercentiles["99.0"]  * scoreFactor),
  p999_ns:    Math.round(jmh.primaryMetric.scorePercentiles["99.9"]  * scoreFactor),
  max_ns:     Math.round(jmh.primaryMetric.scorePercentiles["100.0"] * scoreFactor),
  mean_ns:    Math.round(jmh.primaryMetric.score                     * scoreFactor),
  samples_ns: [],
};
```

A ~60-line `tools/adapt-jmh.js` is the canonical bridge.

### Criterion.rs

Each `target/criterion/<bench>/estimates.json` has `Mean.point_estimate`
(ns). For percentiles, parse the matching `tukey.json` (Q1, Median, Q3)
or call criterion's `--save-baseline` and parse the dumped raw samples.
Suggested mapping:

```rust
p50_ns  = median;
p99_ns  = q3 + 1.5 * iqr;   // approximate; for real p99 use raw samples
```

### HdrHistogram

Take a snapshot, call `valueAtPercentile(50/99/99.9/100)`, fill in
`stages.<your-name>`. Examples in
[HdrHistogram-rs](https://docs.rs/hdrhistogram/) /
[HdrHistogram-java](https://github.com/HdrHistogram/HdrHistogram).
