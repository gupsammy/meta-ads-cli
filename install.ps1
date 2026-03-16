# meta-ads-cli installer for Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/gupsammy/meta-ads-cli/master/install.ps1 | iex

$ErrorActionPreference = "Stop"
$RequiredNodeMajor = 20

# --- Helpers -----------------------------------------------------------------

function Write-Banner {
    Write-Host ""
    Write-Host "  +--------------------------------------+"
    Write-Host "  |         meta-ads-cli installer       |"
    Write-Host "  |   CLI for the Meta Marketing API     |"
    Write-Host "  +--------------------------------------+"
    Write-Host ""
}

function Write-Info  { param([string]$msg) Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  ! $msg" -ForegroundColor Yellow }

function Write-Err {
    param([string]$msg)
    Write-Host "  X $msg" -ForegroundColor Red
}

function Stop-WithError {
    param([string]$msg)
    Write-Err $msg
    exit 1
}

# --- Node.js -----------------------------------------------------------------

function Get-NodeMajor {
    param([string]$version)
    $version = $version.TrimStart("v")
    $parts = $version.Split(".")
    return [int]$parts[0]
}

function Test-NodeInstalled {
    try {
        $null = Get-Command node -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-WingetInstalled {
    try {
        $null = Get-Command winget -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Install-NodeViaFnm {
    if (-not (Test-WingetInstalled)) {
        Write-Err "Node.js is not installed and winget is not available."
        Write-Err ""
        Write-Err "Please install fnm manually from:"
        Write-Err "  https://github.com/Schniz/fnm/releases"
        Write-Err ""
        Write-Err "Then run:  fnm install $RequiredNodeMajor; fnm use $RequiredNodeMajor"
        Write-Err "And re-run this installer."
        exit 1
    }

    Write-Info "Node.js not found. Installing fnm via winget..."
    winget install Schniz.fnm --accept-source-agreements --accept-package-agreements

    # Refresh PATH so fnm is available in this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Get-Command fnm -ErrorAction SilentlyContinue)) {
        Stop-WithError "fnm installation succeeded but 'fnm' is not on PATH. Please restart your terminal and re-run this installer."
    }

    Write-Ok "fnm installed."

    Write-Info "Installing Node.js $RequiredNodeMajor via fnm..."
    fnm install $RequiredNodeMajor
    fnm use $RequiredNodeMajor

    # Update PATH again after fnm sets up Node
    fnm env | ForEach-Object { Invoke-Expression $_ }

    $nodeVersion = node --version
    Write-Ok "Node.js $nodeVersion installed."
}

function Ensure-Node {
    if (Test-NodeInstalled) {
        $version = node --version
        $major = Get-NodeMajor $version

        if ($major -ge $RequiredNodeMajor) {
            Write-Ok "Node.js $version found (>= $RequiredNodeMajor)"
            return
        } else {
            Write-Err "Node.js $version found, but version $RequiredNodeMajor+ is required."
            Write-Err ""
            Write-Err "If you use fnm:  fnm install $RequiredNodeMajor; fnm use $RequiredNodeMajor"
            Write-Err "If you use nvm:  nvm install $RequiredNodeMajor; nvm use $RequiredNodeMajor"
            Write-Err ""
            Write-Err "Then re-run this installer."
            exit 1
        }
    }

    Install-NodeViaFnm
}

function Ensure-Npm {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Stop-WithError "npm not found. It should have been installed with Node.js. Please reinstall Node."
    }
}

# --- Install meta-ads-cli ----------------------------------------------------

function Install-Cli {
    Write-Info "Installing meta-ads-cli via npm..."
    npm install -g meta-ads
    Write-Ok "meta-ads-cli installed."
}

function Verify-Install {
    if (-not (Get-Command meta-ads -ErrorAction SilentlyContinue)) {
        Stop-WithError "Installation failed: 'meta-ads' command not found on PATH."
    }

    $cliVersion = meta-ads --version
    Write-Ok "Verified: meta-ads v$cliVersion"
}

# --- Onboarding --------------------------------------------------------------

function Start-Setup {
    Write-Host ""
    Write-Info "Launching guided setup..."
    Write-Host ""
    meta-ads setup
}

# --- Main --------------------------------------------------------------------

Write-Banner
Ensure-Node
Ensure-Npm
Install-Cli
Verify-Install
Start-Setup
