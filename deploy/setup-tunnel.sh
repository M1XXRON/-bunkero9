#!/bin/bash
# Поднимает туннель Cloudflare для bunker9.lol.
# Можно запускать повторно: туннель переиспользуется, конфиг перезаписывается.
#
#   ./deploy/setup-tunnel.sh              # bunker9.lol -> http://127.0.0.1:3100
#   DOMAIN=play.bunker9.lol ./deploy/setup-tunnel.sh
set -euo pipefail

NAME="${TUNNEL_NAME:-bunker9}"
DOMAIN="${DOMAIN:-bunker9.lol}"
# 127.0.0.1, а не localhost: localhost может резолвиться в ::1 и отдать
# чужому приложению, если оно заняло тот же порт по IPv6.
ORIGIN="${ORIGIN:-http://127.0.0.1:3100}"
# staging: новая реализация крутится рядом и смотрится до переключения домена
STAGING_HOST="${STAGING_HOST:-next.$DOMAIN}"
STAGING_ORIGIN="${STAGING_ORIGIN:-http://127.0.0.1:3101}"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/dev/bin/cloudflared")}"

if [ ! -x "$CFD" ]; then
	echo "cloudflared не найден. Укажи путь: CLOUDFLARED=/путь/к/cloudflared $0" >&2
	exit 1
fi
if [ ! -s "$HOME/.cloudflared/cert.pem" ]; then
	echo "Нет авторизации. Сначала выполни: $CFD tunnel login" >&2
	exit 1
fi

tunnel_id() {
	"$CFD" tunnel list -o json 2>/dev/null |
		python3 -c "import json,sys;n=sys.argv[1]
raw=sys.stdin.read().strip() or '[]'
d=json.loads(raw) or []
print(next((t['id'] for t in d if t.get('name')==n),''))" "$NAME"
}

if [ -z "$(tunnel_id)" ]; then
	echo "· создаю туннель $NAME"
	"$CFD" tunnel create "$NAME" >/dev/null
else
	echo "· туннель $NAME уже есть"
fi
UUID="$(tunnel_id)"
if [ -z "$UUID" ]; then
	echo "не удалось получить id туннеля" >&2
	exit 1
fi

echo "· пишу конфиг ~/.cloudflared/config.yml"
cat > "$HOME/.cloudflared/config.yml" <<YML
# Сгенерировано deploy/setup-tunnel.sh
tunnel: $UUID
credentials-file: $HOME/.cloudflared/$UUID.json
protocol: quic

ingress:
  - hostname: $DOMAIN
    service: $ORIGIN
  - hostname: www.$DOMAIN
    service: $ORIGIN
  - hostname: $STAGING_HOST
    service: $STAGING_ORIGIN
  # WebSocket (socket.io) cloudflared проксирует сам, доп. настроек не нужно
  - service: http_status:404
YML

route_one() {
	local host="$1"
	local out
	if out="$("$CFD" tunnel route dns "$NAME" "$host" 2>&1)"; then
		echo "  $host -> $NAME"
	else
		echo "  $host: не удалось"
		if grep -q "already exists" <<<"$out"; then
			cat <<TXT
    В зоне уже есть A/AAAA/CNAME для $host (обычно остатки парковки).
    Удали их: Cloudflare → DNS → Records → все A и AAAA на $host → Delete.
    После этого просто запусти этот скрипт снова.
TXT
		else
			sed 's/^/    /' <<<"$out"
		fi
	fi
}

echo "· привязываю DNS"
route_one "$DOMAIN"
route_one "www.$DOMAIN"
route_one "$STAGING_HOST"

echo ""
echo "Готово. Запуск на переднем плане (для проверки):"
echo "  $CFD tunnel run $NAME"
echo ""
echo "Постоянная работа после перезагрузки:"
echo "  ./deploy/install-services.sh"
