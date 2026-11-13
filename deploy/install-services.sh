#!/bin/bash
# Ставит сайт и туннель в launchd: поднимаются при входе и перезапускаются
# при падении. Логи — в ~/Library/Logs/bunker9/.
#
#   ./deploy/install-services.sh            # установить/переустановить
#   ./deploy/install-services.sh --remove   # убрать
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_LABEL="lol.bunker9.web"
TUN_LABEL="lol.bunker9.tunnel"
LOGDIR="$HOME/Library/Logs/bunker9"
AGENTS="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/dev/bin/cloudflared")}"
# Отдельный порт: 3000 обычно занят другими проектами, а совпадение портов
# по разным семействам адресов (IPv4/IPv6) даёт «сайт отдаёт чужое приложение».
WEB_PORT="${WEB_PORT:-3100}"

bootout() {
	launchctl bootout "gui/$UID/$1" 2>/dev/null || launchctl unload "$AGENTS/$1.plist" 2>/dev/null || true
}

# bootstrap отдаёт EIO (код 5), если сервис уже загружен — это не ошибка,
# а «уже запущен». Поэтому пробуем ещё раз, а потом просто перезапускаем.
load_label() {
	local label="$1" attempt
	for attempt in 1 2 3; do
		if launchctl bootstrap "gui/$UID" "$AGENTS/$label.plist" 2>/dev/null; then
			return 0
		fi
		sleep 1
		if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
			launchctl kickstart -k "gui/$UID/$label" >/dev/null 2>&1
			return 0
		fi
		bootout "$label"
		sleep 1
	done
	echo "не удалось загрузить $label" >&2
	return 1
}

if [ "${1:-}" = "--remove" ]; then
	for label in "$WEB_LABEL" "$TUN_LABEL"; do
		bootout "$label"
		rm -f "$AGENTS/$label.plist"
		echo "убран $label"
	done
	exit 0
fi

if [ -z "$NODE_BIN" ]; then
	echo "node не найден в PATH" >&2
	exit 1
fi
if [ ! -s "$HOME/.cloudflared/cert.pem" ]; then
	echo "Сначала авторизуй cloudflared: $CFD tunnel login" >&2
	exit 1
fi
if [ ! -f "$HOME/.cloudflared/config.yml" ]; then
	echo "Нет ~/.cloudflared/config.yml — сначала ./deploy/setup-tunnel.sh" >&2
	exit 1
fi

mkdir -p "$LOGDIR" "$AGENTS"

write_plist() {
	local label="$1" program="$2" workdir="$3"
	shift 3
	# настоящие табуляции для отступов XML: в bash "\t" — это литерал, а printf считает
	local args_xml
	args_xml="$(printf '\t\t<string>%s</string>\n' "$@")"
	cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$program</string>
$args_xml
	</array>
	<key>WorkingDirectory</key><string>$workdir</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>StandardOutPath</key><string>$LOGDIR/$label.log</string>
	<key>StandardErrorPath</key><string>$LOGDIR/$label.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
		<key>HOME</key><string>$HOME</string>
		<key>PORT</key><string>$WEB_PORT</string>
	</dict>
</dict>
</plist>
PLIST
}

# сайт
write_plist "$WEB_LABEL" "$NODE_BIN" "$ROOT" "server.js"
# туннель: параметры берутся из ~/.cloudflared/config.yml
write_plist "$TUN_LABEL" "$CFD" "$HOME" "tunnel" "run"

# старый процесс не должен держать наш порт
OLD_PID="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
	echo "· останавливаю старый сервер на :$WEB_PORT (pid $OLD_PID)"
	kill "$OLD_PID" 2>/dev/null || true
	sleep 1
fi

for label in "$WEB_LABEL" "$TUN_LABEL"; do
	bootout "$label"
	load_label "$label"
	echo "· запущен $label"
done

sleep 3
echo ""
echo "Проверка:"
echo -n "  https://bunker9.lol/health  ->  "
curl -s -m 10 "http://127.0.0.1:$WEB_PORT/health" || echo "(пока не отвечает)"
echo ""
echo "Логи: $LOGDIR/"
