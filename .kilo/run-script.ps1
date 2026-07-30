# .kilo/run-script.ps1
# Started by the Agent Manager Run button. Runs from the worktree dir.
# WORKTREE_PATH = current run directory (the worktree checkout, or main repo for LOCAL)
# REPO_PATH     = main repository root
$ErrorActionPreference = "Stop"

$worktree = $env:WORKTREE_PATH
$repoRoot = $env:REPO_PATH

# Derive a stable per-worktree port (matches setup-script.ps1)
$hash = [Math]::Abs(($worktree.GetHashCode()) % 9)
$portOffset = $hash + 1   # 1..9
$vitePort = 5173 + $portOffset

$frontendDir = Join-Path $worktree "frontend"
if (-not (Test-Path -LiteralPath $frontendDir)) {
    throw "frontend/ not found at $frontendDir"
}

Write-Host "==> Starting frontend dev server (vite) for $worktree"
Write-Host "    Port: $vitePort"

Push-Location $frontendDir
try {
    npm run dev -- --port $vitePort --strictPort
} finally {
    Pop-Location
}
