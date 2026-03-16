#!/usr/bin/env bash
set -euo pipefail

# meta-ads-cli installer for macOS / Linux / WSL
# Usage: curl -fsSL https://raw.githubusercontent.com/gupsammy/meta-ads-cli/master/install.sh | sh

REQUIRED_NODE_MAJOR=20
FNM_INSTALL_URL="https://fnm.vercel.app/install"

# --- Helpers ----------------------------------------------------------------

print_banner() {
  printf '\n'
  printf '  ┌──────────────────────────────────────┐\n'
  printf '  │         meta-ads-cli installer        │\n'
  printf '  │   CLI for the Meta Marketing API      │\n'
  printf '  └──────────────────────────────────────┘\n'
  printf '\n'
}

info()  { printf '  \033[1;34m>\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; }
die()   { err "$*"; exit 1; }

# --- Detect OS and architecture ---------------------------------------------

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    CYGWIN*|MINGW*|MSYS*) os="windows" ;;
    *)       die "Unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             die "Unsupported architecture: $arch" ;;
  esac

  info "Detected platform: ${os}-${arch}"
}

# --- Node.js -----------------------------------------------------------------

parse_node_major() {
  # Input: "v20.11.0" → Output: "20"
  local version="$1"
  version="${version#v}"          # strip leading v
  printf '%s' "${version%%.*}"    # everything before the first dot
}

check_node() {
  if command -v node >/dev/null 2>&1; then
    local version major
    version="$(node --version)"
    major="$(parse_node_major "$version")"

    if [ "$major" -ge "$REQUIRED_NODE_MAJOR" ]; then
      ok "Node.js $version found (>= $REQUIRED_NODE_MAJOR)"
      return 0
    else
      err "Node.js $version found, but version $REQUIRED_NODE_MAJOR+ is required."
      err ""
      err "If you use fnm:  fnm install $REQUIRED_NODE_MAJOR && fnm use $REQUIRED_NODE_MAJOR"
      err "If you use nvm:  nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR"
      err ""
      err "Then re-run this installer."
      exit 1
    fi
  fi

  return 1
}

install_node_via_fnm() {
  info "Node.js not found. Installing fnm (Fast Node Manager)..."

  curl -fsSL "$FNM_INSTALL_URL" | bash -s -- --skip-shell
  ok "fnm installed."

  # Determine fnm binary location
  local fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  if [ ! -d "$fnm_dir" ]; then
    fnm_dir="$HOME/.fnm"
  fi

  export PATH="$fnm_dir:$PATH"

  # Activate fnm in the current session
  eval "$(fnm env)"

  info "Installing Node.js $REQUIRED_NODE_MAJOR via fnm..."
  fnm install "$REQUIRED_NODE_MAJOR"
  fnm use "$REQUIRED_NODE_MAJOR"
  ok "Node.js $(node --version) installed."

  # Append fnm init to shell profile so it persists
  append_fnm_to_profile
}

append_fnm_to_profile() {
  local shell_name profile_file init_line

  shell_name="$(basename "${SHELL:-/bin/sh}")"
  init_line='eval "$(fnm env)"'

  case "$shell_name" in
    zsh)  profile_file="$HOME/.zshrc" ;;
    bash) profile_file="$HOME/.bashrc" ;;
    fish) profile_file="$HOME/.config/fish/config.fish"
          init_line='fnm env | source' ;;
    *)    profile_file="$HOME/.profile" ;;
  esac

  if [ -f "$profile_file" ] && grep -qF 'fnm env' "$profile_file" 2>/dev/null; then
    info "fnm init already present in $profile_file"
    return
  fi

  printf '\n# fnm (Fast Node Manager)\n%s\n' "$init_line" >> "$profile_file"
  ok "Added fnm init to $profile_file"
  warn "Restart your shell or run: source $profile_file"
}

ensure_node() {
  if ! check_node; then
    install_node_via_fnm
  fi
}

# --- npm check ---------------------------------------------------------------

ensure_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    die "npm not found. It should have been installed with Node.js. Please reinstall Node."
  fi
}

# --- Install meta-ads-cli ----------------------------------------------------

install_cli() {
  info "Installing meta-ads-cli via npm..."
  npm install -g meta-ads-cli
  ok "meta-ads-cli installed."
}

verify_install() {
  if ! command -v meta-ads >/dev/null 2>&1; then
    die "Installation failed: 'meta-ads' command not found on PATH."
  fi

  local cli_version
  cli_version="$(meta-ads --version)"
  ok "Verified: meta-ads v${cli_version}"
}

# --- Onboarding --------------------------------------------------------------

run_setup() {
  printf '\n'
  info "Launching guided setup..."
  printf '\n'
  meta-ads setup
}

# --- Main --------------------------------------------------------------------

main() {
  print_banner
  detect_platform
  ensure_node
  ensure_npm
  install_cli
  verify_install
  run_setup
}

main
