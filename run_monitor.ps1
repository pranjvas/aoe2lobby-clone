$testPassed = $false
Write-Host "Starting E2E Monitor Loop..."

while (-not $testPassed) {
    node monitor_e2e.js
    if ($LASTEXITCODE -eq 0) {
        $testPassed = $true
    } else {
        Write-Host "Retrying in 30 seconds..."
        Start-Sleep -Seconds 30
    }
}
