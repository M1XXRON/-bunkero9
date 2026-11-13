// Гейт проекта: типы, формат, боты и HTTP-проверки — одной командой, без
// внешнего сервера.
//
//   bun run verify            # всё
//   SKIP_BOTS=1 bun run verify   # только типы и формат
//
// Серверы поднимаются здесь же на свободных портах с временными базами. Раньше
// `bun run verify` падал с ECONNREFUSED, если рядом никто не слушал 3101, — то
// есть «гейт» из HANDOFF не работал на чистой машине.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const CWD = join(import.meta.dir, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(BUN, args, { cwd: CWD, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code ?? 1));
  });

const isUp = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};

// Боты ждут ускоренных таймеров (BUNKER_TEST=1), а HTTP-проверки наоборот —
// настоящих: под быстрыми таймерами фазы уезжают вперёд, и «дойти до ночи» не
// получается. Поэтому два сервера, по одному на сценарий.
async function withServer(env, fn) {
  const dir = mkdtempSync(join(tmpdir(), "bunker-verify-"));
  const port = 3200 + Math.floor(Math.random() * 300);
  const site = `http://127.0.0.1:${port}`;
  const server = spawn(BUN, ["run", "server.ts"], {
    cwd: CWD,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), BUNKER_DB: join(dir, "verify.db"), ...env },
  });
  let log = "";
  server.stdout.on("data", (d) => (log += String(d)));
  server.stderr.on("data", (d) => (log += String(d)));

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = await isUp(`${site}/health`);
    if (!up) await sleep(150);
  }
  try {
    if (!up) {
      console.error(`✗ сервер не поднялся (порт ${port})\n${log.slice(-800)}`);
      return 1;
    }
    return await fn(site);
  } finally {
    try {
      server.kill("SIGTERM");
    } catch {
      /* уже остановлен */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. типы и формат
for (const args of [["check"], ["fmt", "--check"]]) {
  if ((await run(args)) !== 0) {
    console.error(`\n✗ bun ${args.join(" ")} — провал`);
    process.exit(1);
  }
}

if (process.env.SKIP_BOTS === "1") {
  console.log("\n✓ типы и формат в порядке (боты пропущены: SKIP_BOTS=1)");
  process.exit(0);
}

// 2. боты по HTTP/SSE: 5 и 15 игроков
const botsCode = await withServer({ BUNKER_TEST: "1" }, async (SITE) => {
  for (const bots of ["5", "15"]) {
    const code = await run(["test/sim-bun.mjs"], { SITE, BOTS: bots });
    if (code !== 0) {
      console.error(`\n✗ боты (${bots} игроков) — провал`);
      return 1;
    }
  }
  return 0;
});
if (botsCode !== 0) process.exit(1);

// 3. HTTP-проверки: приватность ночного шёпота, ошибки лендинга, таймер
const httpCode = await withServer({}, (SITE) => run(["tools/http-e2e.mjs"], { SITE }));
if (httpCode !== 0) {
  console.error("\n✗ HTTP-проверки — провал");
  process.exit(1);
}

// 4. битая сессия (комната исчезла, cookie остался) не должна запирать лендинг
const staleCode = await run(["tools/stale-session-e2e.mjs"]);
if (staleCode !== 0) {
  console.error("\n✗ битая сессия: провал");
  process.exit(1);
}

// 5. пошаговое раскрытие: ходы, подтверждение, свои карты на экране
const turnCode = await run(["tools/turn-e2e.mjs"]);
if (turnCode !== 0) {
  console.error("\n✗ пошаговое раскрытие: провал");
  process.exit(1);
}

// 6. боты: добавление хостом и самостоятельная игра
const gameBots = await run(["tools/bots-e2e.mjs"]);
if (gameBots !== 0) {
  console.error("\n✗ боты: провал");
  process.exit(1);
}

console.log(
  "\n✓ verify: типы, формат, боты 5/15, HTTP-проверки, битая сессия, ходы раскрытия, игровые боты — всё зелёное",
);
