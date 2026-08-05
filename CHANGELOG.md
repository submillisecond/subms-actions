# Changelog

All notable changes to `subms-actions` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The pre-commit hooks could never have run.** `.pre-commit-hooks.yaml`
  declared `language: node` while the repo shipped no `package.json`, so
  pre-commit aborted while building the hook environment:

  ```
  AssertionError: `language: node` must have package.json or additional_dependencies
  ```

  This went unnoticed because nobody had `pre-commit` installed - the config in
  consuming repos was aspirational, not a gate. The failure mode is worse than a
  hook that does nothing: pre-commit builds every hook repo's environment before
  running anything, so one unbuildable repo takes down the entire commit,
  including unrelated hooks that work fine.

  Two defects, both fixed. A `package.json` now exists, exposing the script as a
  `subms-perf-diff` bin. `entry:` was `node tools/precommit-perf-diff.js`, a path
  relative to this repo, which does not resolve - hooks run with the CONSUMING
  repo as the working directory. It is now the bin name, which the installed
  package puts on PATH.

  Consumers must re-enable the hooks and should pin `rev:` to a tag rather than
  `main`: pre-commit never re-resolves a mutable ref after the first install, so
  a broken environment persists until the cache is cleared by hand.

## [0.1.0] - 2026-07-27

### Added
- Initial public release.
