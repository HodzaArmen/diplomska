#!/usr/bin/env bash
# Deploy SupplyChain.sol na lokalni Anvil (forge 1.7+ potrebuje --broadcast)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! docker logs anvil --tail 3 2>&1 | grep -q "0.0.0.0:8545"; then
  docker compose up -d anvil --force-recreate
  sleep 4
fi

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$ROOT/src:/src" \
  -w /src \
  --entrypoint forge \
  ghcr.io/foundry-rs/foundry:latest \
  create SupplyChain.sol:SupplyChain \
  --rpc-url http://host.docker.internal:8545 \
  --mnemonic "test test test test test test test test test test test junk" \
  --mnemonic-index 0 \
  --broadcast

echo ""
echo "Vpiši Deployed to: naslov v src/.env (glej src/.env.anvil.example)"
