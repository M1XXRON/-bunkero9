import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { io } from 'socket.io-client';

const SITE = 'https://bunker9.lol';
const PORT = 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bots = [];
const bot = (name, avatar) => new Promise((res) => {
  const s = io(SITE, { transports: ['websocket'], reconnection: false, timeout: 20000 });
  s.on('connect', () => res({ name, sock: s }));
  bots.push({ name, sock: s });
});
const ack = (s, ev, p = {}) => new Promise((r) => { const t = setTimeout(() => r({}), 8000); s.emit(ev, p, (x) => { clearTimeout(t); r(x || {}); }); });

const CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.value;

async function main() {
  const host = await bot('Хост', '🦉');
  const created = await ack(host.sock, 'create', { name: 'Хост', avatar: '🦉' });
  const code = created.code;
  for (const [n, a] of [['Борис', '🐺'], ['Вера', '🦊'], ['Глеб', '🐻'], ['Дина', '🦅']]) await ack((await bot(n, a)).sock, 'join', { code, name: n, avatar: a });
  await sleep(600);

  const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--user-data-dir=/tmp/chrome-onb-dbg', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length) break; } catch {} await sleep(250); }
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${SITE}/#${code}` });
  for (let i = 0; i < 60; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(200); }
  await sleep(1200);
  await ev(`(() => { const n=document.getElementById('nameInput'); n.value='Телефон';
    n.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('codeInput').value='${code}';
    document.getElementById('joinForm').requestSubmit(); return true; })()`);
  await sleep(2500);
  await sleep(700);
  const sr = await ack(host.sock, 'start', {});
  console.log('start ack:', JSON.stringify(sr));
  await sleep(1600);

  console.log('DEBUG:', await ev(`JSON.stringify({
    screen: document.body.dataset.screen,
    phase: document.body.dataset.phase,
    modalOpen: !document.getElementById('modalRoot').classList.contains('hidden'),
    modalHtml: document.getElementById('modalRoot').innerHTML.length,
    flag: localStorage.getItem('bunker9-onboarded'),
    hasModal: !!document.querySelector('#modalRoot .modal'),
  })`));

  for (let step = 0; step < 3; step++) {
    const title = await ev(`(document.querySelector('#modalRoot .modal-head h2')||{}).textContent || 'нет модалки'`);
    console.log('шаг', step, '→', String(title).trim());
    const png = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`/tmp/audit/onboard-${step}.png`, Buffer.from(png.data, 'base64'));
    await ev(`(() => { const b=[...document.querySelectorAll('#modalRoot button')].find(x=>/Дальше|Понятно/.test(x.textContent)); if(b) b.click(); return !!b; })()`);
    await sleep(500);
  }

  ws.close(); chrome.kill();
  for (const b of bots) b.sock.close();
}
main().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
