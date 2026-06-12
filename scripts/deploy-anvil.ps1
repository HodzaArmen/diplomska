# Deploy SupplyChain.sol na lokalni Anvil (Foundry forge 1.7+)
# Zahteva: docker compose up -d anvil

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "Preverjam Anvil..."
Set-Location $Root

$logs = docker logs anvil --tail 3 2>&1 | Out-String
if ($logs -notmatch "0\.0\.0\.0:8545") {
    Write-Host "Anvil znova zaganjam (mora poslusati na 0.0.0.0:8545)..."
    docker compose up -d anvil --force-recreate
    Start-Sleep -Seconds 4
}

$chainCheck = docker run --rm --add-host=host.docker.internal:host-gateway `
    --entrypoint cast ghcr.io/foundry-rs/foundry:latest `
    chain-id --rpc-url http://host.docker.internal:8545 2>&1 | Out-String
if ($chainCheck -notmatch "31337") {
    Write-Host "NAPAKA: Anvil ne odgovarja na http://127.0.0.1:8545 (chainId 31337)" -ForegroundColor Red
    Write-Host $chainCheck
    exit 1
}
Write-Host "Anvil OK (chainId 31337)"

Write-Host "Deploy SupplyChain.sol (--broadcast)..."
$deployOutput = docker run --rm `
    --add-host=host.docker.internal:host-gateway `
    -v "${Root}/src:/src" `
    -w /src `
    --entrypoint forge `
    ghcr.io/foundry-rs/foundry:latest `
    create SupplyChain.sol:SupplyChain `
    --rpc-url http://host.docker.internal:8545 `
    --mnemonic "test test test test test test test test test test test junk" `
    --mnemonic-index 0 `
    --broadcast 2>&1 | Out-String

# Zadnjih nekaj vrstic (Deployed to / napaka)
$tail = ($deployOutput -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 8) -join "`n"
Write-Host $tail

if ($deployOutput -match "Deployed to:\s*(0x[a-fA-F0-9]{40})") {
    $addr = $Matches[1]
    Write-Host ""
    Write-Host "USPEH! CONTRACT_ADDRESS=$addr" -ForegroundColor Green
    Write-Host ""
    Write-Host "V src/.env nastavi:"
    Write-Host "  CONTRACT_ADDRESS=$addr"
    Write-Host "  CHAIN_RPC_URL=http://anvil:8545"
    Write-Host "  CHAIN_RPC_PUBLIC=http://127.0.0.1:8545"
    Write-Host "  CHAIN_ID=31337"
    Write-Host "  CHAIN_NAME=Anvil Local"
    Write-Host "  ETHERSCAN_BASE_URL="
} else {
    Write-Host "NAPAKA: Deploy ni vrnil naslova." -ForegroundColor Red
    exit 1
}
