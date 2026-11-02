# Adds the local deploy key (~/.ssh/aoe2lobby_vps.pub) to root on the VPS. Asks for the root password once.
param([string]$Server = "85.190.254.97")
Write-Host "Adding the aoe2lobby deploy key to root@$Server. Type the root password when asked (it will not show)."
Get-Content "$env:USERPROFILE\.ssh\aoe2lobby_vps.pub" | ssh -o StrictHostKeyChecking=accept-new "root@$Server" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_ADDED"
