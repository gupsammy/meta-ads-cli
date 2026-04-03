#!/bin/bash
set -e

# Reset meta-ads-intel skill installation.
#
# Two modes:
#   Full reset (default): simulate a fresh customer install.
#     Removes CLI auth, config, skill data, installed skill, global npm package.
#   Skill-only (--skill-only): update skill files without losing onboarding data.
#     Preserves CLI auth, config.json, brand-context.md, data, reports.
#     Only replaces SKILL.md and references/ from the repo.
#
# Usage: reset-skill.sh [--repo-dir <path>] [--skill-only]
#   --repo-dir:    path to meta-ads-cli repo (default: auto-detect from script location)
#   --skill-only:  only replace skill files, keep all user/onboarding data

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."

# Parse args
SKILL_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --skill-only) SKILL_ONLY=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

SKILL_SRC="$REPO_DIR/skills/meta-ads-intel"
SKILL_DEST="$HOME/.claude/skills/meta-ads-intel"
DATA_DIR="$HOME/.meta-ads-intel"
CLI_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/meta-ads-cli"

if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "Error: SKILL.md not found at $SKILL_SRC/SKILL.md" >&2
  echo "Pass --repo-dir to specify the meta-ads-cli repo root." >&2
  exit 1
fi

if $SKILL_ONLY; then
  echo "=== meta-ads-intel skill-only update ==="
  echo "Preserving: CLI auth, config, brand context, data, reports"
else
  echo "=== meta-ads-intel fresh install reset ==="
fi
echo ""

if ! $SKILL_ONLY; then
  # 1. Remove CLI auth and config
  if [[ -d "$CLI_CONFIG_DIR" ]]; then
    echo "Removing CLI config at $CLI_CONFIG_DIR (auth token, account defaults)..."
    rm -rf "$CLI_CONFIG_DIR"
    echo "  done"
  else
    echo "No CLI config found at $CLI_CONFIG_DIR — already clean"
  fi

  # 2. Uninstall global meta-ads CLI
  if npm list -g meta-ads &>/dev/null; then
    echo "Uninstalling global meta-ads npm package..."
    npm uninstall -g meta-ads 2>/dev/null || true
    echo "  done"
  else
    echo "meta-ads not installed globally — already clean"
  fi

  # 3. Remove all skill user data
  if [[ -d "$DATA_DIR" ]]; then
    echo "Removing $DATA_DIR (config, brand context, data, reports, creatives)..."
    rm -rf "$DATA_DIR"
    echo "  done"
  else
    echo "No data dir found at $DATA_DIR — already clean"
  fi
fi

# 4. Remove installed skill
if [[ -d "$SKILL_DEST" ]]; then
  echo "Removing installed skill at $SKILL_DEST..."
  rm -rf "$SKILL_DEST"
  echo "  done"
else
  echo "No installed skill found at $SKILL_DEST — already clean"
fi

# 5. Reinstall skill from repo
echo "Installing skill from $SKILL_SRC..."
mkdir -p "$SKILL_DEST"
cp "$SKILL_SRC/SKILL.md" "$SKILL_DEST/"
cp -r "$SKILL_SRC/references" "$SKILL_DEST/"
echo "  done"

echo ""
if $SKILL_ONLY; then
  echo "=== Skill update complete ==="
  echo "Replaced: SKILL.md, references/"
  echo "Preserved: CLI auth, config.json, brand-context.md, data, reports"
  echo ""
  echo "Next: run /meta-ads-intel to test with updated skill"
else
  echo "=== Reset complete ==="
  echo "Removed:"
  echo "  - CLI auth + config ($CLI_CONFIG_DIR)"
  echo "  - meta-ads npm package"
  echo "  - Skill data ($DATA_DIR)"
  echo "  - Installed skill ($SKILL_DEST)"
  echo "Preserved: ffmpeg, Node.js, npm"
  echo "Reinstalled: skill files from repo"
  echo ""
  echo "Next: run /meta-ads-intel to start onboarding as a fresh customer"
fi
