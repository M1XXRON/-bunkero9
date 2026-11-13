// Экономика бункера зависит от состава: стартовые запасы, суточный расход,
// масштаб событий. Проверяем, что «дней до кризиса» примерно одинаково на 5 и
// на 15 игроков, а расход реально считается от живых.
//
//   bun tools/economy-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..");
const PORT = 3118;
const SITE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

const dir = mkdtempSync(join(tmpdir(), "bunker-econ-"));
const server = spawn(BUN, ["run", "server.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT), BUNKER_TEST: "1", BUNKER_DB: join(dir, "econ.db") },
});
let log = "";
server.stdout.on("data", (d) => (log += String(d)));
server.stderr.on("data", (d) => (log += String(d)));

const act = (sid, cmd, payload = {}) =>
  fetch(`${SITE}/act/${cmd}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: `bunker_sid=${sid}` },
    body: JSON.stringify({ payload }),
  });
const page = async (sid) =>
  (await fetch(`${SITE}/`, { headers: { cookie: `bunker_sid=${sid}` } })).text();

const resources = (html) => {
  const num = (label) => {
    const m = html.match(new RegExp(`<i>${label}</i><b>(\\d+)</b>`));
    return m ? Number(m[1]) : null;
  };
  return { food: num("еда"), energy: num("энергия"), meds: num("меды") };
};
const dayCost = (html) => {
  const m = html.match(/Расход бункера: еда −(\d+), энергия −(\d+)/);
  return m ? { food: Number(m[1]), energy: Number(m[2]) } : null;
};

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    up = (await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    /* ждём */
  }
  if (!up) await sleep(150);
}
if (!up) {
  console.error("✗ сервер не поднялся\n" + log.slice(-600));
  process.exit(1);
}

async function measure(players) {
  const sid = `econ-${players}`;
  await act(sid, "create", { name: "Хост", avatar: "🦉" });
  if (players > 1) await act(sid, "bots", { count: players - 1 });
  await act(sid, "start");
  await sleep(300);
  const before = resources(await page(sid));
  await act(sid, "skip"); // интро -> первый день
  await sleep(500);
  const html = await page(sid);
  const after = resources(html);
  const cost = dayCost(html);
  await act(sid, "leave");
  return { before, after, cost };
}

try {
  const small = await measure(5);
  const big = await measure(15);

  console.log(
    `  5 игроков: старт ${JSON.stringify(small.before)}, расход ${JSON.stringify(small.cost)}`,
  );
  console.log(
    ` 15 игроков: старт ${JSON.stringify(big.before)}, расход ${JSON.stringify(big.cost)}`,
  );

  note(small.before.food === 26, `5 игроков: еда = (R−1)·5+6 (${small.before.food})`);
  note(big.before.food === 96, `15 игроков: еда = (R−1)·15+6 (${big.before.food})`);
  note(
    big.before.energy > small.before.energy,
    `15 игроков: энергии больше (${big.before.energy} > ${small.before.energy})`,
  );
  note(
    big.before.meds > small.before.meds,
    `15 игроков: медикаментов больше (${big.before.meds} > ${small.before.meds})`,
  );

  note(small.cost?.food === 5, `расход еды = живые (5 → −${small.cost?.food})`);
  note(big.cost?.food === 15, `расход еды = живые (15 → −${big.cost?.food})`);
  note(small.cost?.energy === 2, `расход энергии на 5 → −${small.cost?.energy} (минимум 2)`);
  note(big.cost?.energy === 5, `расход энергии на 15 → −${big.cost?.energy} (1 за каждые 3)`);

  // запас в днях не должен разъезжаться от размера команды
  const smallDays = small.before.energy / small.cost.energy;
  const bigDays = big.before.energy / big.cost.energy;
  note(
    Math.abs(smallDays - bigDays) <= 2,
    `энергии хватает примерно одинаково: ${smallDays.toFixed(1)} и ${bigDays.toFixed(1)} дн.`,
  );

  const smallFoodDays = small.before.food / small.cost.food;
  const bigFoodDays = big.before.food / big.cost.food;
  note(
    Math.abs(smallFoodDays - bigFoodDays) <= 2,
    `еды хватает примерно одинаково: ${smallFoodDays.toFixed(1)} и ${bigFoodDays.toFixed(1)} дн.`,
  );

  // события масштабируются от состава (чистая функция движка)
  const require = (await import("node:module")).createRequire(import.meta.url);
  const engine = require(join(ROOT, "src/engine.js"));
  const smallEvent = engine.scaleEffects({ food: -8, energy: -4, meds: 1 }, 5);
  const bigEvent = engine.scaleEffects({ food: -8, energy: -4, meds: 1 }, 15);
  note(
    smallEvent.food === -5 && smallEvent.energy === -2,
    `событие на 5 игроков мягче: food ${smallEvent.food}, energy ${smallEvent.energy}`,
  );
  note(
    bigEvent.food === -12 && bigEvent.energy === -6,
    `событие на 15 игроков сильнее: food ${bigEvent.food}, energy ${bigEvent.energy}`,
  );
  note(bigEvent.meds === 1 && smallEvent.meds === 1, "медикаменты в событиях не масштабируются");
  const huge = engine.scaleEffects({ food: -8 }, 20);
  const tiny = engine.scaleEffects({ food: -8 }, 3);
  note(
    huge.food === -12 && tiny.food === -5,
    `масштаб ограничен 0.6…1.5 (${tiny.food}…${huge.food})`,
  );
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nэкономика: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
