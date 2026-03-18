#!/bin/bash
set -e

# Reset meta-ads-intel to simulate a fresh customer install.
# Removes: CLI auth, CLI config, skill data, installed skill, global npm package.
# Preserves: jq, ffmpeg, Node.js, npm.
# Reinstalls: skill files from repo into ~/.claude/skills/.
#
# Usage: reset-skill.sh [--repo-dir <path>]
#   --repo-dir: path to meta-ads-cli repo (default: auto-detect from script location)
#
# What gets removed:
#   ~/.config/meta-ads-cli/     — CLI auth token + defaults (account_id)
#   ~/.meta-ads-intel/          — config, brand context, data, reports, creatives
#   ~/.claude/skills/meta-ads-intel/  — installed skill files
#   meta-ads global npm package — simulates user who hasn't installed the CLI yet
#
# What gets reinstalled:
#   SKILL.md, scripts/, references/  — copied from repo into ~/.claude/skills/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
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

echo "=== meta-ads-intel fresh install reset ==="
echo ""

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
cp -r "$SKILL_SRC/scripts" "$SKILL_DEST/"
cp -r "$SKILL_SRC/references" "$SKILL_DEST/"
echo "  done"

echo ""
echo "=== Reset complete ==="
echo "Removed:"
echo "  - CLI auth + config ($CLI_CONFIG_DIR)"
echo "  - meta-ads npm package"
echo "  - Skill data ($DATA_DIR)"
echo "  - Installed skill ($SKILL_DEST)"
echo "Preserved: jq, ffmpeg, Node.js, npm"
echo "Reinstalled: skill files from repo"
echo ""
echo "Next: run /meta-ads-intel to start onboarding as a fresh customer"
