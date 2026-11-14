// Аудит правил: голос за себя, хост после смерти, одинаковые позывные,
// антифлуд и лимит текста, состояние ботов после рестарта.
// Работает на движке напрямую — без сервера и таймеров.
//
//   bun tools/rules-e2e.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dir, "..");
const engine = require(join(ROOT, "src/engine.js"));

const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

const AVATARS = ["🦉", "🐺", "🦊", "🐻", "🦌", "🐍"];
let seq = 0;

function makeRoom(n) {
  seq += 1;
  const tag = `r${seq}`;
  const host = engine.createRoom({ name: `H0-${tag}`, avatar: "🦉", socketId: `${tag}-0` });
  const guests = [];
  for (let i = 1; i < n; i += 1) {
    const r = engine.joinRoom({
      code: host.room.code,
      name: `H${i}-${tag}`,
      avatar: AVATARS[i % AVATARS.length],
      socketId: `${tag}-${i}`,
    });
    guests.push(r.player);
  }
  return { room: host.room, host: host.player, guests };
}

const alive = (room) => room.players.filter((p) => p.alive);
const hostIdOf = (room) => room.hostId;

// ---------- 1. одинаковые позывные ----------
{
  const { room } = makeRoom(2);
  const dup = engine.joinRoom({ code: room.code, name: "H1-r1".toUpperCase(), avatar: "🦊" });
  note(
    dup.ok === false && /занят/i.test(dup.error || ""),
    "позывной проверяется без учёта регистра",
  );
  const other = engine.joinRoom({ code: room.code, name: "Новый", avatar: "🦊" });
  note(other.ok === true, "свободный позывной принимается");
}

// ---------- 2. голос за себя ----------
{
  const { room, host, guests } = makeRoom(5);
  engine.startGame(room, host.id);
  engine.skipPhase(room.code, host.id); // интро -> раскрытие
  engine.skipPhase(room.code, host.id); // раскрытие -> обсуждение
  engine.skipPhase(room.code, host.id); // обсуждение -> голосование
  note(room.state === "vote", `дошли до голосования (${room.state})`);
  const self = engine.castVote(room.code, host.id, host.id);
  note(self.ok === false && /за себя/i.test(self.error || ""), "голос за себя отклонён");
  const ok = engine.castVote(room.code, host.id, guests[0].id);
  note(ok.ok === true, "голос за другого принят");
}

// ---------- 3. хост после изгнания ----------
{
  const { room, host, guests } = makeRoom(5);
  engine.startGame(room, host.id);
  engine.skipPhase(room.code, host.id);
  engine.skipPhase(room.code, host.id);
  engine.skipPhase(room.code, host.id);
  for (const g of guests) engine.castVote(room.code, g.id, host.id);
  engine.skipPhase(room.code, host.id); // закрыть голосование -> изгнание хоста
  const hostPlayer = room.players.find((p) => p.id === host.id);
  note(hostPlayer.alive === false, "хост изгнан");
  note(hostIdOf(room) !== host.id, `хост перешёл другому (${hostIdOf(room) === host.id})`);
  const next = room.players.find((p) => p.id === room.hostId);
  note(Boolean(next && next.alive), "новый хост жив");
  const skip = engine.skipPhase(room.code, host.id);
  note(skip.ok === false && /хост/i.test(skip.error || ""), "изгнанный больше не управляет темпом");
  const skipNew = engine.skipPhase(room.code, room.hostId);
  note(skipNew.ok !== false, "новый хост может пропускать фазу");
}

// ---------- 4. чат: антифлуд и лимит ----------
{
  const { room, host, guests } = makeRoom(5);
  engine.startGame(room, host.id);
  engine.skipPhase(room.code, host.id);
  engine.skipPhase(room.code, host.id); // -> обсуждение (зал открыт)
  note(room.state === "discussion", `чат открыт в фазе ${room.state}`);
  const first = engine.sendChat(room.code, guests[0].id, "day", "первое");
  const flood = engine.sendChat(room.code, guests[0].id, "day", "второе сразу");
  note(first.ok === true, "первое сообщение принято");
  note(flood.ok === false && /быстро/i.test(flood.error || ""), "флуд отклонён");
  const long = "я".repeat(500);
  const longMsg = engine.sendChat(room.code, guests[1].id, "day", long);
  const sent = room.messages.filter((m) => m.kind === "chat").pop();
  note(
    longMsg.ok === true && sent.text.length <= 200,
    `длинный текст обрезан (${sent?.text.length})`,
  );
  const guestPlayer = room.players.find((p) => p.id === guests[0].id);
  guestPlayer.lastChatAt = 0;
  const again = engine.sendChat(room.code, guests[0].id, "day", "третье после паузы");
  note(again.ok === true, "после паузы сообщение проходит");
}

// ---------- 5. кризис сразу после голосования ----------
{
  const { room, host } = makeRoom(5);
  engine.startGame(room, host.id);
  engine.skipPhase(room.code, host.id); // интро -> раскрытие
  engine.skipPhase(room.code, host.id); // раскрытие -> обсуждение
  engine.skipPhase(room.code, host.id); // обсуждение -> голосование
  room.resources.food = 0;
  room.resources.meds = 0;
  engine.skipPhase(room.code, host.id); // голосование -> кризис -> следующий день
  const dead = room.players.find((p) => !p.alive && p.death?.cause === "crisis");
  note(Boolean(dead), `кризис забрал выжившего (${dead?.name || "никого"})`);
  const line = room.messages.map((m) => m.text).find((t) => t.includes("Ночь на пределе"));
  note(Boolean(line), `в ленте: «${line}»`);
  note(!room.messages.some((m) => m.text.startsWith("Кризис:")), "без дублирующей строки");
  note(room.state === "reveal" || room.state === "end", `сразу следующий день (${room.state})`);
}

// ---------- 5b. спасение после голосования и только с запасами ----------
{
  const { room, host } = makeRoom(5);
  engine.startGame(room, host.id);
  room.day = room.rescueDay;
  room.state = "vote";
  room.resources.food = 0;
  room.resources.energy = 5;
  room.resources.meds = 0;
  engine.skipPhase(room.code, host.id);
  note(room.winner === "none", `нулевая еда — спасения нет (${room.winner})`);
  note(
    room.messages.some((m) => m.text.includes("Спасение не пришло")),
    "в ленте объяснение, почему сигнал не ушёл",
  );
}
{
  const { room, host } = makeRoom(5);
  engine.startGame(room, host.id);
  room.day = room.rescueDay;
  room.state = "vote";
  room.resources.food = 5;
  room.resources.energy = 5;
  engine.skipPhase(room.code, host.id);
  note(room.winner === "survived", `с запасами — спасение (${room.winner})`);
}

// ---------- 6. боты после рестарта ----------
{
  const { room, host } = makeRoom(2);
  const bot = engine.joinRoom({ code: room.code, name: "Механик", avatar: "🐙", socketId: "bot" });
  bot.player.isBot = true;
  engine.startGame(room, host.id);
  const restored = engine.resumeRoom(JSON.parse(JSON.stringify(room)));
  const botRestored = restored.players.find((p) => p.isBot);
  const humanRestored = restored.players.find((p) => !p.isBot);
  note(botRestored?.connected === true, "бот после рестарта «на связи»");
  note(humanRestored?.connected === false, "человек после рестарта offline");
}

console.log(problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nправила: проверки прошли");
process.exit(problems.length ? 1 : 0);
