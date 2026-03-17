# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-03-17

### Added
- Cross-platform installer with onboarding wizard and default account ID configuration
- Meta-ads-intel skill for ad performance analysis across campaigns and ad sets
- Entity IDs (ad_id, adset_id, ad_name, adset_name) and creative content fields (title, body, image URL, thumbnail URL) to insights output
- Daily breakdown support via `--time-increment` parameter for insights

### Changed
- Improve output handling, pagination, and CLI UX
- Reorder installation methods in documentation, recommend one-line installer
- Strengthen OAuth authentication flow and move access token to Authorization header
- Restrict sensitive config file permissions (mode 0600)

### Fixed
- Exit code handling in interactive modes and non-TTY environments
- Windows npm executable path for installer
- Debug token authentication flow
- Cursor alignment in paginated API responses
- Missing `warn_if_truncated` parameter for creatives data pull
- Print "Aborted" message when user denies interactive logout
