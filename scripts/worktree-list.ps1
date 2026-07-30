# scripts/worktree-list.ps1
# Shows all live worktrees with their branch, ahead/behind main, and changed files.
#
# Usage:
#   pwsh scripts/worktree-list.ps1              # all worktrees vs main
#   pwsh scripts/worktree-list.ps1 -Branch dev  # compare vs a different base
[CmdletBinding()]
param(
    [string]$Base = "main"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$worktreesRoot = Join-Path $repoRoot ".kilo\worktrees"

# Validate base branch exists
$baseExists = git -C $repoRoot rev-parse --verify $Base 2>$null
if (-not $baseExists) {
    Write-Error "Base branch '$Base' not found."
    exit 1
}

# Get all worktrees (not just .kilo/worktrees — also any external ones)
$wtLines = git -C $repoRoot worktree list --porcelain
$worktrees = @()
$current = $null
foreach ($line in $wtLines) {
    if ($line -match "^worktree (.+)$") {
        if ($current) { $worktrees += $current }
        $current = @{ Path = $Matches[1]; Branch = "(detached)" }
    } elseif ($line -match "^branch refs/heads/(.+)$") {
        $current.Branch = $Matches[1]
    }
}
if ($current) { $worktrees += $current }

# Filter out the main repo
$mainResolved = (Resolve-Path $repoRoot).Path
$worktrees = $worktrees | Where-Object {
    $wtResolved = (Resolve-Path $_.Path -ErrorAction SilentlyContinue).Path
    $wtResolved -ne $mainResolved
}

if (-not $worktrees) {
    Write-Host "No worktrees registered. (Main repo: $repoRoot on $Base)"
    exit 0
}

Write-Host "Base: $Base"
Write-Host ("=" * 80)

foreach ($wt in $worktrees) {
    $branch = $wt.Branch
    $ahead  = (git -C $wt.Path rev-list --count "$Base..HEAD" 2>$null) -as [int]
    $behind = (git -C $wt.Path rev-list --count "HEAD..$Base" 2>$null) -as [int]
    $name = Split-Path $wt.Path -Leaf

    Write-Host ""
    Write-Host "[$name]" -ForegroundColor Cyan
    Write-Host "  Path:   $($wt.Path)"
    Write-Host "  Branch: $branch  (ahead: $ahead, behind: $behind)"

    if ($ahead -eq 0 -and $behind -eq 0) {
        Write-Host "  Same as $Base. Nothing to preview." -ForegroundColor DarkGray
        continue
    }

    if ($ahead -gt 0) {
        $files = git -C $wt.Path diff --name-status "$Base..HEAD"
        if ($files) {
            Write-Host "  Changed files ($ahead commit$(if ($ahead -ne 1) { 's' })):" -ForegroundColor Green
            $files | ForEach-Object { Write-Host "    $_" }
        }
    }

    if ($behind -gt 0) {
        Write-Host "  Behind $Base by $behind commit$(if ($behind -ne 1) { 's' }). Rebase to integrate." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Tip: powershell -ExecutionPolicy Bypass -File scripts/preview-worktree.ps1 -Name <branch>"
Write-Host "     to run its frontend."
