# scripts/preview-worktree.ps1
# Usage:
#   pwsh scripts/preview-worktree.ps1                    # interactive picker
#   pwsh scripts/preview-worktree.ps1 -Name accurate-wasp  # specific worktree
#   pwsh scripts/preview-worktree.ps1 -Install            # full npm install (no symlink)
#
# Starts `npm run dev` inside a worktree's frontend/, using the main repo's
# node_modules via a junction (no reinstall). Auto-derives a port from the
# worktree path so multiple worktrees can run side-by-side.
[CmdletBinding()]
param(
    [string]$Name,
    [switch]$Install,
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$worktreesRoot = Join-Path $repoRoot ".kilo\worktrees"

function Get-WorktreePort($wtPath) {
    $hash = [Math]::Abs(($wtPath.GetHashCode()) % 9)
    return 5173 + $hash + 1   # 5174..5182
}

# 1. Pick a worktree
if (-not $Name) {
    $existing = Get-ChildItem -LiteralPath $worktreesRoot -Directory -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Error "No worktrees found under $worktreesRoot"
        exit 1
    }
    Write-Host "Available worktrees:"
    for ($i = 0; $i -lt $existing.Count; $i++) {
        $wt = $existing[$i]
        $branch = (git -C $wt.FullName rev-parse --abbrev-ref HEAD 2>$null) -as [string]
        $wtPort = Get-WorktreePort $wt.FullName
        Write-Host ("  [{0}] {1}  (branch: {2}, port: {3})" -f ($i + 1), $wt.Name, $branch, $wtPort)
    }
    $choice = Read-Host "Pick a worktree (1-$($existing.Count))"
    if (-not ($choice -as [int]) -or $choice -lt 1 -or $choice -gt $existing.Count) {
        Write-Error "Invalid choice."
        exit 1
    }
    $selected = $existing[$choice - 1]
} else {
    $selected = Get-Item -LiteralPath (Join-Path $worktreesRoot $Name) -ErrorAction SilentlyContinue
    if (-not $selected) {
        Write-Error "Worktree not found: $Name"
        exit 1
    }
}

$wtPath = $selected.FullName
$frontend = Join-Path $wtPath "frontend"

if (-not (Test-Path -LiteralPath $frontend)) {
    Write-Error "frontend/ not found in $wtPath"
    exit 1
}

# 2. Make sure node_modules exists (symlink or install)
$mainNm = Join-Path $repoRoot "frontend\node_modules"
$wtNm = Join-Path $frontend "node_modules"

if (-not (Test-Path -LiteralPath $wtNm)) {
    if ($Install) {
        Write-Host "Running 'npm install' in $frontend (this may take a while)..."
        Push-Location $frontend
        try { npm install } finally { Pop-Location }
    } elseif (Test-Path -LiteralPath $mainNm) {
        Write-Host "Symlinking node_modules from main repo (fast, no install)..."
        New-Item -ItemType Junction -Path $wtNm -Target $mainNm | Out-Null
    } else {
        Write-Error "node_modules missing and main repo has none. Run 'npm install' in $frontend first, or pass -Install."
        exit 1
    }
} else {
    Write-Host "node_modules already present."
}

# 3. Compute port
if ($Port -le 0) { $Port = Get-WorktreePort $wtPath }
$branch = (git -C $wtPath rev-parse --abbrev-ref HEAD 2>$null) -as [string]
$ahead = (git -C $wtPath rev-list --count main..HEAD 2>$null) -as [int]
$behind = (git -C $wtPath rev-list --count HEAD..main 2>$null) -as [int]

Write-Host ""
Write-Host "==> Previewing worktree:"
Write-Host "    Path:   $wtPath"
Write-Host "    Branch: $branch  (ahead of main: $ahead, behind main: $behind)"
Write-Host "    Port:   $Port"
Write-Host ""

Push-Location $frontend
try {
    npm run dev -- --port $Port --strictPort
} finally {
    Pop-Location
}
