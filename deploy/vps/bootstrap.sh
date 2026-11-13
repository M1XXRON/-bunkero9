#!/bin/bash
# Один раз на VPS, от root. Идемпотентно: можно запускать повторно.
#
#   DOMAIN=bunker9.lol bash bootstrap.sh
set -euo pipefail

DOMAIN="${DOMAIN:-bunker9.lol}"
APP_USER="bunker"
APP_DIR="/opt/bunker9/app"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n· %s\n' "$1"; }

say "пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync ufw unzip >/dev/null

say "bun"
if ! command -v bun >/dev/null 2>&1 || [ ! -x /usr/local/bin/bun ]; then
	curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
	BUN_INSTALL=/usr/local bash /tmp/bun-install.sh >/dev/null
fi
# bun — один статический бинарник: положим в /usr/local/bin, чтобы он был
# доступен служебному пользователю bunker
if [ -x /usr/local/bin/bun ]; then
	echo "  bun $(/usr/local/bin/bun --version)"
else
	echo "  bun не установился" >&2
	exit 1
fi

say "caddy"
if ! command -v caddy >/dev/null 2>&1; then
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
		gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		-o /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy >/dev/null
fi
echo "  $(caddy version | head -1)"

say "пользователь и каталоги"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
	useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR" /opt/bunker9/deploy
chown -R "$APP_USER:$APP_USER" /opt/bunker9

say "systemd"
install -m 644 "$HERE/bunker9.service" /etc/systemd/system/bunker9.service
systemctl daemon-reload
systemctl enable bunker9 >/dev/null 2>&1 || true

say "caddy: конфиг для $DOMAIN"
sed "s/bunker9\.lol/$DOMAIN/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
echo "  $(ufw status | head -1)"

say "готово"
echo "  дальше: ./deploy.sh с локальной машины (копирует код и перезапускает)"
