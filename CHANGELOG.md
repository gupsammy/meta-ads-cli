# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-03-21

### Added
- Objective-aware analysis pipeline in Meta Ads Intel skill

### Changed
- Extract and consolidate CLI helper functions and constants
- Harden CLI security implementation
- Improve code quality across skill codebase

### Fixed
- Resolve video KPI handling and creative-media output in insights analysis
- Fix IFS variable splitting and lock directory staleness checks
- Correct analysis pipeline architecture issues identified in multi-agent audit
- Resolve remaining data processing bugs in objective-aware analysis
- Fix creative field handling for video-only advertisements

## [0.5.2] - 2026-03-19

### Fixed
- Correct funnel denominator calculation and standardize omni-first extraction for action metrics
- Add missing ad set fields to insights output

## [0.5.1] - 2026-03-18

### Fixed
- Read CLI version from package.json instead of hardcoded string

## [0.5.0] - 2026-03-18

### Added
- Filter analysis pipeline to OUTCOME_SALES campaigns for improved signal quality

### Fixed
- Warn on malformed campaigns-meta.json and simplify account-health jq filtering

## [0.4.0] - 2026-03-18

### Added
- Script-driven analysis pipeline with onboarding and analysis modes for skill-based insights
- Deep brand context integration in Meta Ads Intel skill for enhanced analysis
- Foundation for daily week-over-week analysis

### Fixed
- Fix jq as-bindings placement in onboard-scan to resolve object construction errors
- Address review findings from code quality audit

## [0.3.0] - 2026-03-17

### Added
- Complete CLI for Meta Ads API v21.0 with commands for managing ad accounts, campaigns, ad sets, ads, and custom audiences
- Insights reporting with configurable fields, time increments, date presets, and pagination
- Creative content metadata in ads output (title, body, image URL, thumbnail URL)
- Cross-platform installer and interactive onboarding wizard with default account ID setup
- `meta-ads-intel` AI skill for ad performance analysis and metrics summarization
- Support for both environment variables and stored credentials for authentication
- OAuth2 authentication flow with app secret via environment variable
- Pagination support across all list commands with cursor-based navigation
- JSON output mode for all commands with consistent structure
- Verbose output option to display rate limit and pagination metadata
- Retry logic with exponential backoff for API rate limits (HTTP 429) and server errors (5xx)
- Interactive confirmations for destructive operations with `--force` flag to skip in scripts

### Changed
- Improve output handling and pagination to align server-side cursors with page size

### Security
- Move access tokens to Authorization header from query parameters
- Strengthen OAuth validation and restrict configuration file permissions (0600)
