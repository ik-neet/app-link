$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AdminUrl = "http://127.0.0.1:8790/admin"
$HealthUrl = "http://127.0.0.1:8790/api/apps"

function Test-AdminServer {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

Set-Location -LiteralPath $ProjectRoot

if (-not (Test-AdminServer)) {
    Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "scripts/admin-server.mjs" -WorkingDirectory $ProjectRoot

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (Test-AdminServer) {
            break
        }
        Start-Sleep -Milliseconds 300
    }
}

Start-Process $AdminUrl
