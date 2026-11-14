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
  r.players[0].traits.find((t) => t.cat === "profession").value = "повар";
  const cost = engine.dailyCost(r);
  note(cost.food === 2.5, `повар: еда ${cost.food} (было 5)`);
  note(cost.crewEat === -0.5, `повар: модификатор ${cost.crewEat}`);
}

// ---------- 3. аллергия и диабет добавляют личную норму ----------
{
  const r = room(5);
  neutralise(r);
  r.players[1].traits.find((t) => t.cat === "health").value = "аллергия на антибиотики";
  r.players[2].traits.find((t) => t.cat === "health").value = "повышенный обмен";
  const cost = engine.dailyCost(r);
  note(cost.food === 6, `двое едят больше: еда ${cost.food}`);
  note(cost.personalEat === 1, `личные надбавки: +${cost.personalEat}`);
  r.players[1].traits.find((t) => t.cat === "health").revealed = true;
  const snapshot = engine.serializeFor(r, r.players[2]);
  const health = snapshot.players[1].traitSlots.find((slot) => slot.cat === "health");
  note(health.impact?.kind === "drain", `болезнь подсвечена красным (${health.impact?.label})`);
}

// ---------- 4. электрик экономит энергию ----------
{
  const r = room(5);
  neutralise(r);
  const base = engine.dailyCost(r).energy;
  r.players[0].traits.find((t) => t.cat === "profession").value = "электрик";
  const after = engine.dailyCost(r).energy;
  note(after === base - 1, `электрик: энергия ${base} → ${after}`);
}

// ---------- 5. припасы вскрываются картой, а не на старте ----------
{
  const r = room(5);
  neutralise(r);
  r.players[0].traits.find((t) => t.cat === "baggage").value = "ящик консервов";
  const before = r.resources.food;
  const authored = engine.supplyOf(r);
  note(authored.food === 5, `в картах смены +${authored.food} еды (ещё не в бункере)`);
  engine.skipPhase(r.code, r.hostId); // интро -> раскрытие
  const beforeReveal = r.resources.food;
  const index = r.players[0].traits.findIndex((t) => t.value === "ящик консервов");
  engine.revealTrait(r.code, r.hostId, index);
  note(
    r.resources.food === beforeReveal + 5,
    `после вскрытия карты: еда ${beforeReveal} → ${r.resources.food}`,
  );
  note(beforeReveal <= before, "на старте припасы не начисляются");
  const line = r.messages.map((m) => m.text).find((t) => t.includes("вскрывает"));
  note(/еда \+5/.test(line || ""), `в ленте: «${line}»`);
  const revealMsg = r.messages.filter((m) => m.kind === "reveal").at(-1);
  note(
    revealMsg.impact?.kind === "gain",
    `вскрытие подсвечено зелёным (${revealMsg.impact?.label})`,
  );
  const snapshot = engine.serializeFor(r, r.players[0]);
  const baggage = snapshot.players[0].traitSlots.find((slot) => slot.cat === "baggage");
  note(baggage.impact?.kind === "gain", "стол раскрытий: у карты зелёный эффект");
}

// ---------- 6. расход пишется в чат с модификаторами ----------
{
  const r = room(5);
  neutralise(r);
  r.players[0].traits.find((t) => t.cat === "profession").value = "повар";
  engine.skipPhase(r.code, r.hostId); // интро -> день
  const line = r.messages.map((m) => m.text).find((t) => t.startsWith("Расход бункера"));
  note(/еда −2\.5/.test(line || ""), `в ленте расход: «${line}»`);
  note(/кухня/.test(line || ""), "в ленте есть пояснение модификатора");
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

  // Баланс колоды: экстремумы не должны занимать четверть пула.
  const body = content.TRAITS.find((t) => t.key === "body").values;
  const health = content.TRAITS.find((t) => t.key === "health").values;
  const count = (list, word) => list.filter((v) => v.toLowerCase().includes(word)).length;
  note(
    count(body, "ожирение") <= 3,
    `ожирений в колоде: ${count(body, "ожирение")} / ${body.length}`,
  );
  note(
    count(health, "тяжёл") <= 3,
    `тяжёлых болезней: ${count(health, "тяжёл")} / ${health.length}`,
  );
  note(count(body, "норма") >= 10, `«норма» — большинство: ${count(body, "норма")}`);
  note(
    count(health, "абсолютно здоров") >= 4,
    `здоровых карт: ${count(health, "абсолютно здоров")}`,
  );
}

// ---------- 8. цена изгнания в голосовании ----------
{
  const r = room(5);
  r.state = "vote";
  const target = r.players[1];
  const body = target.traits.find((t) => t.cat === "body");
  body.value = "182 см · 119 кг · ожирение";
  body.revealed = false;
  const first = engine.serializeFor(r, r.players[0]);
  const cost1 = first.players.find((p) => p.id === target.id).leaveCost;
  note(Boolean(cost1), `цена изгнания считается (${JSON.stringify(cost1)})`);
  const second = engine.serializeFor(r, r.players[0]);
  const cost2 = second.players.find((p) => p.id === target.id).leaveCost;
  note(cost2.food === cost1.food, "скрытая карта не меняет цену изгнания");
  body.revealed = true;
  const third = engine.serializeFor(r, r.players[0]);
  const cost3 = third.players.find((p) => p.id === target.id).leaveCost;
  note(
    cost3.food < cost1.food,
    `после раскрытия ожирения экономия больше (${cost1.food} → ${cost3.food})`,
  );
}

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nхарактеристики: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
