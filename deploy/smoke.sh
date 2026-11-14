#!/bin/bash
# Проверка, что по домену отдаётся именно бункер, а не чужое приложение.
# Запускать после любой правки портов, туннеля или соседних сервисов.
#
#   ./deploy/smoke.sh                      # https://bunker9.lol
#   DOMAIN=play.example.com ./deploy/smoke.sh
set -uo pipefail

DOMAIN="${DOMAIN:-bunker9.lol}"
BASE="https://$DOMAIN"
fail=0

ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; fail=$((fail + 1)); }

echo "проверяю $BASE"

code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$BASE/")
[ "$code" = "200" ] && ok "главная: 200" || bad "главная: $code"

title=$(curl -s -m 15 "$BASE/" | grep -o '<title>[^<]*</title>' | sed 's/<[^>]*>//g')
case "$title" in
*БУНКЕР*) ok "заголовок: $title" ;;
*) bad "заголовок чужой: ${title:-пусто}" ;;
esac

health=$(curl -s -m 15 "$BASE/health")
case "$health" in
*'"ok":true'*) ok "health: $health" ;;
*) bad "health чужой: ${health:-пусто}" ;;
esac

# QR из продукта убран (ветка bun-datastar) — проверяем, что работает новый стек
css=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$BASE/style.css")
[ "$css" = "200" ] && ok "стиль клиента (style.css): 200" || bad "style.css: $css"

for asset in redesign.css stages.css experience.js; do
	asset_code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$BASE/$asset")
	[ "$asset_code" = "200" ] && ok "$asset: 200" || bad "$asset: $asset_code"
done

wcode=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://www.$DOMAIN/")
[ "$wcode" = "301" ] && ok "www: 301" || bad "www: $wcode (ожидался 301)"

echo ""
if [ "$fail" -eq 0 ]; then
	echo "всё в порядке"
else
	echo "проблем: $fail"
	exit 1
fi
