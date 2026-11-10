# Deploys the stop card to a Home Assistant instance over SSH (Terminal &
# SSH add-on). Copies dist/stop/ - the card and its lang files - to
# /config/www/gtfs2-stop-card/ and prints the Lovelace resource URL, whose
# ?v= is the card's CARD_VERSION: bump the version, redeploy, and browsers
# pick the new code up.
#
#   .\deploy.ps1                              # HA_HOST and HA_USER from env
#   .\deploy.ps1 -HaHost home.local -HaUser root
#
# One-time setup in Home Assistant afterwards:
#   Settings -> Dashboards -> Resources -> Add resource
#     URL:     /local/gtfs2-stop-card/gtfs2-stop-card.js?v=<version printed>
#     Type:    JavaScript Module
#
# Never deployed under www/community/: that is HACS's territory, and this
# card is private.
param(
    [string]$HaHost = $env:HA_HOST,
    [string]$HaUser = $env:HA_USER
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not $HaHost -or -not $HaUser) {
    throw "Set -HaHost/-HaUser, or the HA_HOST/HA_USER environment variables."
}

$dist = "dist/stop"
$card = Join-Path $dist "gtfs2-stop-card.js"
if (-not (Test-Path $card)) { throw "card not found: $card" }

# the card's own version: the cache-buster the resource URL carries
$version = if ((Get-Content $card -TotalCount 5) -match 'CARD_VERSION\s*=\s*"([^"]+)"') { $Matches[1] } else { "0" }

$remote = "/config/www/gtfs2-stop-card"
Write-Host "Deploying gtfs2-stop-card v$version -> ${HaUser}@${HaHost}:$remote"

ssh "$HaUser@$HaHost" "mkdir -p $remote/lang"
if ($LASTEXITCODE -ne 0) { throw "ssh failed - is the Terminal & SSH add-on reachable?" }

scp "$card" "${HaUser}@${HaHost}:$remote/gtfs2-stop-card.js"
if ($LASTEXITCODE -ne 0) { throw "scp of the card failed" }

Get-ChildItem "$dist/lang" -Filter *.js | ForEach-Object {
    scp $_.FullName "${HaUser}@${HaHost}:$remote/lang/$($_.Name)"
    if ($LASTEXITCODE -ne 0) { throw "scp of lang/$($_.Name) failed" }
}

Write-Host ""
Write-Host "Deployed. Resource URL (JavaScript Module):"
Write-Host "  /local/gtfs2-stop-card/gtfs2-stop-card.js?v=$version"
Write-Host ""
Write-Host "Card config, e.g.:"
Write-Host "  type: custom:gtfs2-stop-card"
Write-Host "  title: Buses nearby"
Write-Host "  stops:"
Write-Host "    - sensor.xxx_local_stop_zone.home"
Write-Host "  route_ids:"
Write-Host '    "003": "6613"'
