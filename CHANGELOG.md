# Changelog

All notable changes to `subms-actions` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The pre-commit hooks could never have run. `.pre-commit-hooks.yaml` declared `language: node` with no `package.json` in the repo, so pre-commit aborted while building the hook environment.
- Nobody had `pre-commit` installed, so the config in consuming repos was aspirational. The moment a runner existed it took every commit down, including unrelated hooks that work.
- pre-commit builds each hook repo's environment before running anything. One unbuildable repo is a landmine, not an inert config.
- Added a `package.json` exposing the script as a `subms-perf-diff` bin.
- `entry:` was `node tools/precommit-perf-diff.js`, a path relative to this repo. Hooks run with the consuming repo as cwd, so it never resolved. It is now the bin name.
- Consumers should pin `rev:` to a tag. pre-commit never re-resolves a mutable ref after first install, so a broken environment survives until the cache is cleared by hand.

## [0.1.0] - 2026-07-27

### Added
- Initial public release.
