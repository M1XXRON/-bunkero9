// Спецвозможности: НЗ, обмен, разведка. Движок напрямую, без сервера.
//
//   bun tools/ability-e2e.mjs
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
function room(n = 5) {
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

const special = (player) => player.traits.find((t) => t.cat === "special");
const indexOf = (player, cat) => player.traits.findIndex((t) => t.cat === cat);

// ---------- 1. у всех восемь карт и валидная спецвозможность ----------
{
  const r = room(6);
  note(r.players[0].traits.length === 8, `карт у игрока: ${r.players[0].traits.length}`);
  const vals = r.players.map((p) => special(p)?.value);
  const valid = vals.every((v) => content.SPECIALS[v.toLowerCase()]);
  note(valid, `спецвозможности из пула: ${vals.join(", ")}`);
}

// ---------- 2. НЗ: ресурсы сразу, повторно нельзя ----------
{
  const r = room(5);
  const p = r.players[0];
  special(p).value = "НЗ";
  const before = { ...r.resources };
  const result = engine.useAbility(r.code, p.id, { action: "start" });
  note(result.ok === true, "НЗ применяется одним действием");
  note(r.resources.food === before.food + 6, `еда ${before.food} → ${r.resources.food}`);
  note(
    r.resources.energy === before.energy + 4,
    `энергия ${before.energy} → ${r.resources.energy}`,
  );
  note(r.resources.meds === before.meds + 1, `медикаменты ${before.meds} → ${r.resources.meds}`);
  note(p.abilityUsed === true, "возможность помечена использованной");
  const line = r.messages.map((m) => m.text).find((t) => t.includes("вскрывает НЗ"));
  note(Boolean(line), `в ленте: «${line}»`);
  const again = engine.useAbility(r.code, p.id, { action: "start" });
  note(again.ok === false, `повтор отклонён: ${again.error}`);
}

// ---------- 2b. НЗ масштабируется по составу ----------
{
  const r = room(15);
  const p = r.players[0];
  special(p).value = "НЗ";
  const before = { ...r.resources };
  engine.useAbility(r.code, p.id, { action: "start" });
  note(r.resources.food === before.food + 15, `НЗ на 15: еда +${r.resources.food - before.food}`);
  note(
    r.resources.energy === before.energy + 5,
    `НЗ на 15: энергия +${r.resources.energy - before.energy}`,
  );
}

// ---------- 3. обмен: карты меняются местами вместе с публичностью ----------
{
  const r = room(5);
  const a = r.players[0];
  const b = r.players[1];
  special(a).value = "обмен";
  const idx = indexOf(a, "health");
  const aValue = a.traits[idx].value;
  const bValue = b.traits[idx].value;
  a.traits[idx].revealed = true;

  note(engine.useAbility(r.code, a.id, { action: "start" }).ok, "обмен начат");
  note(engine.useAbility(r.code, a.id, { action: "category", index: idx }).ok, "карта выбрана");
  const swapped = engine.useAbility(r.code, a.id, { action: "target", target: b.id });
  note(swapped.ok, "игрок выбран");
  note(a.traits[idx].value === bValue && b.traits[idx].value === aValue, "значения поменялись");
  note(
    a.traits[idx].revealed === false && b.traits[idx].revealed === true,
    "публичность уехала с картой",
  );
  note(a.abilityUsed === true, "обмен израсходован");
  const line = r.messages.map((m) => m.text).find((t) => t.includes("обменялись картами"));
  note(/Здоровье/.test(line || ""), `в ленте: «${line}»`);
}

// ---------- 4. разведка: приватное сообщение только владельцу ----------
{
  const r = room(5);
  const a = r.players[0];
  const b = r.players[2];
  special(a).value = "разведка";
  engine.useAbility(r.code, a.id, { action: "start" });
  const result = engine.useAbility(r.code, a.id, { action: "target", target: b.id });
  note(result.ok, "разведка применена");
  const forA = engine
    .serializeFor(r, a)
    .messages.map((m) => m.text)
    .join("\n");
  const forB = engine
    .serializeFor(r, b)
    .messages.map((m) => m.text)
    .join("\n");
  note(/Разведка ·/.test(forA), "владелец видит скрытые карты");
  note(!/Разведка ·/.test(forB), "цель не видит приватное сообщение");
  note(a.abilityUsed === true, "разведка израсходована");
}

// ---------- 5. ограничения: не днём, отмена, своя цель ----------
{
  const r = room(5);
  const a = r.players[0];
  special(a).value = "обмен";
  const idx = indexOf(a, "hobby");
  engine.useAbility(r.code, a.id, { action: "start" });
  engine.useAbility(r.code, a.id, { action: "category", index: idx });
  const self = engine.useAbility(r.code, a.id, { action: "target", target: a.id });
  note(self.ok === false, `обмен с собой отклонён: ${self.error}`);
  engine.useAbility(r.code, a.id, { action: "cancel" });
  note(r.ability === null, "отмена сбрасывает выбор");

  const state = r.state;
  r.state = "end";
  const atEnd = engine.useAbility(r.code, a.id, { action: "start" });
  r.state = state;
  note(atEnd.ok === false, `вне дня нельзя: ${atEnd.error}`);
}

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nспецвозможности: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
