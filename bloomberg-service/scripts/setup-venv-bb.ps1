<#
setup-venv-bb.ps1 — One-command bootstrap for the Bloomberg relay on a fresh
machine. Recreates .venv-bb/ at the repo root, installs blpapi from PyPI plus
the firm-private xbbg_sapi wheel checked into the repo, seeds
bloomberg-service/.env from .env.example with a freshly-generated
RELAY_API_KEY, and prints the next steps.

Run from the repo root (or anywhere — paths are anchored):
    powershell -ExecutionPolicy Bypass -File bloomberg-service\scripts\setup-venv-bb.ps1
#>

$ErrorActionPreference = 'Stop'

$repoRoot  = Resolve-Path -Path (Join-Path $PSScriptRoot '..\..')
$venvDir   = Join-Path $repoRoot '.venv-bb'
$serviceDir = Join-Path $repoRoot 'bloomberg-service'
$envFile   = Join-Path $serviceDir '.env'
$envTpl    = Join-Path $serviceDir '.env.example'
$wheel     = Join-Path $repoRoot 'xbbg_sapi-1.0.0-py3-none-any.whl'

if (-not (Test-Path -LiteralPath $wheel)) {
    throw "Missing wheel: $wheel (expected the firm-private xbbg_sapi wheel at the repo root)."
}

Write-Host "==> Python interpreter" -ForegroundColor Cyan
$python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $python) {
    throw "Python 3 is not on PATH. Install Python 3.11+ and re-run."
}
& $python --version | Write-Host

Write-Host "==> Creating venv at $venvDir" -ForegroundColor Cyan
if (Test-Path -LiteralPath $venvDir) {
    Write-Host "    $venvDir already exists — reusing (delete it to force a clean rebuild)."
} else {
    & $python -m venv $venvDir
}
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

Write-Host "==> Upgrading pip" -ForegroundColor Cyan
& $venvPython -m pip install --upgrade pip --quiet

Write-Host "==> Installing blpapi + xbbg_sapi (this can take a minute)" -ForegroundColor Cyan
& $venvPython -m pip install blpapi 'fastapi[standard]' uvicorn pandas pydantic 'python-dotenv' requests --quiet
& $venvPython -m pip install $wheel --quiet

Write-Host "==> Verifying imports" -ForegroundColor Cyan
& $venvPython -c "import blpapi, fastapi, uvicorn, pandas, xbbg_sapi; print('blpapi', blpapi.__version__, '| xbbg_sapi', xbbg_sapi.__version__)"

Write-Host "==> Seeding bloomberg-service\.env" -ForegroundColor Cyan
if (Test-Path -LiteralPath $envFile) {
    Write-Host "    $envFile already exists — leaving it alone. Edit it by hand if you want a new API key."
} else {
    if (-not (Test-Path -LiteralPath $envTpl)) {
        throw "Missing template: $envTpl"
    }
    Copy-Item -LiteralPath $envTpl -Destination $envFile
    # Generate a random 32-byte hex API key so the relay and the frontend
    # can talk without a shared static secret the receiver had to ship with.
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    (Get-Content -LiteralPath $envFile) -replace '^RELAY_API_KEY=.*$', "RELAY_API_KEY=$key" | Set-Content -LiteralPath $envFile
    Write-Host "    Wrote $envFile (RELAY_API_KEY=<random 64-hex-char secret>)"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps (see LOCAL_SETUP.md for the full runbook):"
Write-Host "  1. Edit bloomberg-service\.env and fill in the Supabase / BBG_* fields if you're running the production tunnel path."
Write-Host "     For local-only mode (default), the existing values are fine — Bloomberg will connect using your host IP + the wheel's defaults."
Write-Host "  2. Start the relay:"
Write-Host "       cd '$repoRoot\bloomberg-service'"
Write-Host "       ..\.venv-bb\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000"
Write-Host "  3. Start the frontend (separate shell):"
Write-Host "       cd '$repoRoot\frontend'"
Write-Host "       npm install"
Write-Host "       cp .env.example .env.local"
Write-Host "       npm run dev"
