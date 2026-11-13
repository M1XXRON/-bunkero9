// Аудит мобильного экрана: 5 ботов создают партию, браузер 390×844 заходит
// шестым игроком, каждая фаза снимается скриншотом и обмеряется.
// Без playwright: socket.io-client + Chrome DevTools Protocol.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { io } from 'socket.io-client';

const SITE = process.env.SITE || 'https://bunker9.lol';
const OUT = '/tmp/audit';
const PORT = 9230;
const W = 390;
const H = 844;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// ---------- боты ----------
const bots = [];
function bot(name, avatar) {
  return new Promise((resolve) => {
    const s = io(SITE, { transports: ['websocket'], reconnection: false, timeout: 20000 });
    const b = { name, sock: s, state: null };
    s.on('state', (st) => { b.state = st; });
    s.on('connect', () => resolve(b));
    bots.push(b);
  });
}
const ack = (s, ev, payload = {}) =>
  new Promise((res) => { const t = setTimeout(() => res({ ok: false, timeout: true }), 8000); s.emit(ev, payload, (r) => { clearTimeout(t); res(r || {}); }); });

// ---------- браузер ----------
const CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
let ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height), Math.round(r.top)]; };
  const vh = window.innerHeight;
  const overflowing = [...document.querySelectorAll('.panel, .game-grid > *, .chat-panel')]
    .filter((e) => e.scrollWidth > e.clientWidth + 2)
    .map((e) => e.className.split(' ')[0]);
  return JSON.stringify({
    screen: document.body.dataset.screen,
    phase: (q('#topPhase') || {}).textContent,
    docW: document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth,
    docH: document.documentElement.scrollHeight + '/' + vh,
    gameGrid: box('.game-grid'),
    players: box('.players-panel'),
    chat: box('.chat-panel'),
    loop: box('.loop-panel'),
    overflow: overflowing.slice(0, 5),
  });
})()`;

async function main() {
  // 1. комната и боты
  const host = await bot('Хост', '🦉');
  const created = await ack(host.sock, 'create', { name: 'Хост', avatar: '🦉' });
  if (!created.ok) throw new Error('create: ' + JSON.stringify(created));
  const code = created.code;
  console.log('код комнаты:', code);

  for (const [n, a] of [['Второй', '🐺'], ['Третий', '🦊'], ['Четвёртый', '🐻'], ['Пятый', '🦅']]) {
    const b = await bot(n, a);
    const r = await ack(b.sock, 'join', { code, name: n, avatar: a });
    if (!r.ok) throw new Error(`join ${n}: ` + JSON.stringify(r));
  }
  await sleep(800);
  console.log('игроков в комнате:', host.state?.players?.length ?? host.state?.snapshot?.players?.length);

  // 2. браузер на 390×844
  const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 40; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length) break; } catch {}
    await sleep(250);
  }
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await send('Page.enable'); await send('Runtime.enable');

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${SITE}/#${code}` });
  for (let i = 0; i < 60; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(200); }
  await sleep(1200);

  await ev(`(() => {
    const n = document.getElementById('nameInput'); n.value = 'Телефон';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('codeInput').value = '${code}';
    document.getElementById('joinForm').requestSubmit();
    return true;
  })()`);
  await sleep(2500);
  console.log('браузер на экране:', await ev('document.body.dataset.screen'));

  // 3. гоняем фазы
  const shots = [];
  const shot = async (tag) => {
    await ev(closeModals);
    await sleep(300);
    const m = await ev(MEASURE);
    const png = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/${tag}.png`, Buffer.from(png.data, 'base64'));
    console.log(`${tag.padEnd(12)} ${m}`);
    shots.push(tag);
  };

  await ack(host.sock, 'start', {});
  await sleep(1500);

  // модалка «Личное дело» открывается на старте — иначе на скриншотах только она
  const closeModals = `(() => {
    const root = document.getElementById('modalRoot');
    if (!root) return 'нет root';
    const btn = (re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));
    const show = btn(/Показать роль/i);
    if (show) { show.click(); return 'роль показана'; }
    const close = btn(/Закрыть|Понятно|Дальше|Далее|×/i);
    if (close) { close.click(); return 'закрыто'; }
    return 'нечего закрывать';
  })()`;
  for (let i = 0; i < 3; i++) { console.log('модалка:', await ev(closeModals)); await sleep(400); }
  await sleep(600);

  for (let step = 0; step < 24; step++) {
    const st = host.state;
    const phase = st?.phase || st?.snapshot?.state || '?';
    const tag = `${String(step).padStart(2, '0')}-${phase}`;
    await shot(tag);
    if (phase === 'end') break;

    // действия ботов, чтобы игра шла
    const snap = st.snapshot || st;
    for (const p of snap.players || []) {
      const me = p.role; // роли тут нет у чужих; просто пропускаем
    }
    // голосуем за первого живого чужого
    if (phase === 'vote') {
      const alive = (snap.players || []).filter((p) => p.alive && p.id !== snap.me?.id);
      for (const b of bots) {
        const s = b.state?.snapshot || b.state;
        const t = (s?.players || []).find((p) => p.alive && p.id !== s.me?.id);
        if (t) await ack(b.sock, 'vote', { targetId: t.id });
      }
    }
    if (phase === 'reveal') {
      for (const b of bots) await ack(b.sock, 'reveal', { index: 0 });
    }
    await sleep(900);
    await ack(host.sock, 'skip', {});
    await sleep(1400);
  }

  console.log('\nскриншоты:', OUT);
  ws.close(); chrome.kill();
  for (const b of bots) b.sock.close();
}

main().catch((e) => { console.error('ОШИБКА:', e.message); process.exitCode = 1; try { ws?.close(); } catch {} process.exit(1); });
