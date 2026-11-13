// Характеристики с механикой: припасы на старте и суточные модификаторы.
//
//   bun tools/traits-e2e.mjs
//
// Проверяем движок напрямую — без сервера и таймеров.
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const engine = require(join(import.meta.dir, "..", "src", "engine.js"));
const content = require(join(import.meta.dir, "..", "src", "content.js"));

const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

let seq = 0;
function room(n) {
  seq += 1;
  const host = engine.createRoom({ name: `H0-${seq}`, avatar: "🦉", socketId: `s${seq}-0` });
  for (let i = 1; i < n; i += 1) {
    engine.joinRoom({
      code: host.room.code,
      name: `H${i}-${seq}`,
      avatar: "🐺",
      socketId: `s${seq}-${i}`,
    });
  }
  engine.startGame(host.room, host.player.id);
  return host.room;
}

// все карты — нейтральные, чтобы считать базовую линию
function neutralise(target) {
  for (const player of target.players) {
    player.traits.forEach((trait) => {
      trait.value = "абсолютно здоров";
    });
  }
}

// ---------- 1. база ----------
{
  const r = room(5);
  neutralise(r);
  const cost = engine.dailyCost(r);
  note(cost.food === 5 && cost.energy === 2, `база: еда ${cost.food}, энергия ${cost.energy}`);
}

// ---------- 2. повар кормит смену ----------
{
  const r = room(5);
  neutralise(r);
  r.players[0].traits[0].value = "повар";
  const cost = engine.dailyCost(r);
  note(cost.food === 2.5, `повар: еда ${cost.food} (было 5)`);
  note(cost.crewEat === -0.5, `повар: модификатор ${cost.crewEat}`);
}

// ---------- 3. аллергия и диабет добавляют личную норму ----------
{
  const r = room(5);
  neutralise(r);
  r.players[1].traits[1].value = "аллергия на антибиотики";
  r.players[2].traits[1].value = "повышенный обмен";
  const cost = engine.dailyCost(r);
  note(cost.food === 6, `двое едят больше: еда ${cost.food}`);
  note(cost.personalEat === 1, `личные надбавки: +${cost.personalEat}`);
}

// ---------- 4. электрик экономит энергию ----------
{
  const r = room(5);
  neutralise(r);
  const base = engine.dailyCost(r).energy;
  r.players[0].traits[0].value = "электрик";
  const after = engine.dailyCost(r).energy;
  note(after === base - 1, `электрик: энергия ${base} → ${after}`);
}

// ---------- 5. припасы на старте ----------
{
  const r = room(5);
  neutralise(r);
  r.players[0].traits[2].value = "ящик консервов";
  r.players[1].traits[2].value = "канистра бензина";
  r.players[2].traits[2].value = "медицинская аптечка";
  const supply = engine.supplyOf(r);
  note(
    supply.food === 5 && supply.energy === 3 && supply.meds === 2,
    `припасы: еда +${supply.food}, энергия +${supply.energy}, медики +${supply.meds}`,
  );
}

// ---------- 6. расход пишется в чат с модификаторами ----------
{
  const r = room(5);
  neutralise(r);
  r.players[0].traits[0].value = "повар";
  engine.skipPhase(r.code, r.hostId); // интро -> день
  const line = r.messages.map((m) => m.text).find((t) => t.startsWith("Расход бункера"));
  note(/еда −2\.5/.test(line || ""), `в ленте расход: «${line}»`);
  note(/повар/.test(line || ""), "в ленте есть пояснение модификатора");
}

// ---------- 7. без ключа характеристики остаются управляемыми ----------
{
  const r = room(6);
  const values = new Set();
  for (const player of r.players) for (const trait of player.traits) values.add(trait.value);
  const pool = new Set();
  for (const cat of content.TRAITS) for (const v of cat.values) pool.add(v);
  const unknown = [...values].filter((v) => !pool.has(v));
  note(unknown.length === 0, `все карты из пулов (${values.size} разных)`);
  note(
    Object.keys(content.TRAIT_EFFECTS).length >= 14,
    `эффектов в контенте: ${Object.keys(content.TRAIT_EFFECTS).length}`,
  );
}

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nхарактеристики: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
