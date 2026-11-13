#!/bin/bash
# Выкладка сайта на VPS с локальной машины. Запускать из корня проекта:
#
#   VPS_HOST=203.0.113.10 ./deploy/vps/deploy.sh
#   VPS_HOST=203.0.113.10 DOMAIN=bunker9.lol ./deploy/vps/deploy.sh
#
# Первый запуск делает всё (включая bootstrap), повторные — только код.
set -euo pipefail

HOST="${VPS_HOST:?укажи адрес сервера: VPS_HOST=1.2.3.4 ./deploy/vps/deploy.sh}"
DOMAIN="${DOMAIN:-bunker9.lol}"
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
USER_AT="${VPS_USER:-root}@$HOST"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
REMOTE_DIR=/opt/bunker9

cd "$(dirname "$0")/../.."
echo "· проект: $(pwd)"
echo "· сервер: $USER_AT"

if [ "${SKIP_VERIFY:-0}" != "1" ]; then
	echo "· проверки перед выкладкой (bun check + fmt + тесты)"
	~/.bun/bin/bun check || { echo "  типы не прошли — деплой остановлен"; exit 1; }
	~/.bun/bin/bun fmt --check || { echo "  формат не прошёл — деплой остановлен"; exit 1; }
	# тест сам поднимает сервер на свободном порту
	"$HOME/.bun/bin/bun" test/sim-bun.mjs || { echo "  тесты не прошли — деплой остановлен"; exit 1; }
fi

echo ""
echo "· компилирую бинарник (bun build --compile --bytecode)"
~/.bun/bin/bun build ./server.ts --compile --bytecode --target=bun-linux-x64 --outfile dist/bunker9 >/dev/null
file dist/bunker9 | sed 's/^/  /'

echo ""
echo "· проверяю ssh"
ssh "${SSH_OPTS[@]}" "$USER_AT" "echo '  ssh ok · ' \$(hostname)" || {
	echo "  не пускает. Проверь, что публичный ключ добавлен в панели и сервер готов."
	echo "  твой ключ:"; cat "$KEY.pub"
	exit 1
}

echo ""
echo "· готовлю каталоги"
ssh "${SSH_OPTS[@]}" "$USER_AT" "mkdir -p $REMOTE_DIR/app/dist $REMOTE_DIR/deploy"

echo "· копирую бинарник"
rsync -az -e "ssh ${SSH_OPTS[*]}" dist/bunker9 "$USER_AT:$REMOTE_DIR/app/dist/bunker9"

echo "· копирую код"
rsync -az --delete \
	-e "ssh ${SSH_OPTS[*]}" \
	--exclude node_modules --exclude .git --exclude test \
	--exclude screenshots --exclude deploy --exclude node_modules \
	./ "$USER_AT:$REMOTE_DIR/app/"

echo "· копирую серверную часть"
rsync -az -e "ssh ${SSH_OPTS[*]}" ./deploy/vps/ "$USER_AT:$REMOTE_DIR/deploy/"

echo ""
echo "· серверная часть (идемпотентно)"
ssh "${SSH_OPTS[@]}" "$USER_AT" "DOMAIN=$DOMAIN bash $REMOTE_DIR/deploy/bootstrap.sh"

echo ""
echo "· права"
ssh "${SSH_OPTS[@]}" "$USER_AT" "set -e; chown -R bunker:bunker $REMOTE_DIR; chmod +x $REMOTE_DIR/app/dist/bunker9"

echo ""
echo "· перезапуск"
ssh "${SSH_OPTS[@]}" "$USER_AT" "
	systemctl restart bunker9
	sleep 2
	systemctl is-active bunker9
	curl -s -m 5 http://127.0.0.1:3100/health || echo '  локально не отвечает'
	echo
"

echo ""
echo "· проверка снаружи"
sleep 3
DOMAIN="$DOMAIN" ./deploy/smoke.sh || {
	echo ""
	echo "  если DNS ещё не переключён на этот сервер — это ожидаемо."
	echo "  сертификат Caddy выдаст, как только A-запись домена укажет на $HOST."
	exit 0
}
