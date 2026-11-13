#!/bin/sh
# Находит bun: PATH -> ~/.bun/bin -> /usr/local/bin (как на VPS).
# Нужен потому, что `bun run <script>` запускает bash, где ~/.bun/bin не в PATH.
BUN_BIN=$(command -v bun 2>/dev/null || true)
[ -n "$BUN_BIN" ] || BUN_BIN="$HOME/.bun/bin/bun"
[ -x "$BUN_BIN" ] || BUN_BIN=/usr/local/bin/bun
if [ ! -x "$BUN_BIN" ]; then
	echo "bun не найден: поставь его (curl -fsSL https://bun.sh/install | bash)" >&2
	exit 127
fi
exec "$BUN_BIN" "$@"
