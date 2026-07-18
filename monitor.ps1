Write-Host "Monitoring frontend every 30 seconds..."
Set-Location "C:\Users\pranj\.gemini\antigravity\scratch\aoe2lobby-clone"
while ($true) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8080" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Write-Host "$(Get-Date -Format 'o') UP $($response.StatusCode)"
    } catch {
        Write-Host "$(Get-Date -Format 'o') DOWN $($_.Exception.Message)"
        Write-Host "Starting fe_server.js..."
        Start-Process "node" -ArgumentList "fe_server.js" -WindowStyle Hidden
    }
    Start-Sleep -Seconds 30
}
