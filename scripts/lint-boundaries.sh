#!/usr/bin/env bash
# Structural lints: the machine-checked boundaries from docs/standards.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. core/ is a pure library: no Telegram, no SQLite, no Node-only APIs.
if grep -rEn "grammy|better-sqlite3|node:" core/src/; then
    echo "FAIL: platform dependency in core/src" >&2
    exit 1
fi

# 2. tg/ never signs or sends transactions and holds no chain keys.
if grep -rEn "Keypair|signTransaction|sendTransaction|sendRawTransaction" tg/src/; then
    echo "FAIL: transaction capability in tg/src" >&2
    exit 1
fi

# 3. No secrets in the repository: the bot token lives in env only.
if grep -rEn --include='*.ts' --include='*.toml' \
    'BOT_TOKEN[[:space:]]*=|[0-9]+:[A-Za-z0-9_-]{35}' .; then
    echo "FAIL: secret material in the repository" >&2
    exit 1
fi

# 4. miniapp/ is public static content: no env access.
if grep -rEn "process\.env" miniapp/src/; then
    echo "FAIL: env access in miniapp/src" >&2
    exit 1
fi

# 5. Dependencies point one way: tg -> core, miniapp -> core.
if grep -rEn "from ['\"].*/(tg|miniapp)/" core/src/ 2>/dev/null; then
    echo "FAIL: core imports a shell" >&2
    exit 1
fi
if grep -rEn "from ['\"].*/miniapp/" tg/src/ 2>/dev/null; then
    echo "FAIL: tg imports miniapp" >&2
    exit 1
fi
if grep -rEn "from ['\"].*/tg/" miniapp/src/ 2>/dev/null; then
    echo "FAIL: miniapp imports tg" >&2
    exit 1
fi

# 6. The salt vectors are a byte-exact copy of the factory's reference —
#    the single offchain etalon, itself fuzz-verified against the deployed
#    program in crown-factory.
reference="../Crown-Factory/vectors/stream-salt.json"
if [ ! -f "$reference" ]; then
    reference=$(mktemp)
    curl -sf -o "$reference" \
        https://raw.githubusercontent.com/69walterwhite420-star/Crown-Factory/solana-only/vectors/stream-salt.json
fi
if ! cmp -s core/vectors/stream-salt.json "$reference"; then
    echo "FAIL: core/vectors/stream-salt.json drifted from the factory reference" >&2
    exit 1
fi

echo "boundaries OK"
