// Балансовая симуляция: сотни партий без таймеров — движок дёргаем напрямую.
// Нужна, чтобы видеть перекосы на числах (кто выигрывает, сколько дней, как часто
// убивает кризис ресурсов), а не на глаз.
//
//   bun tools/balance-sim.mjs            # 120 партий на каждый состав
//   GAMES=300 bun tools/balance-sim.mjs
const require = (await import("node:module")).createRequire(import.meta.url);
const engine = require(new URL("../src/engine.js", import.meta.url).pathname);

const GAMES = Number(process.env.GAMES || 120);
const SIZES = (process.env.SIZES || "5,8,10,12,15").split(",").map(Number);
const AVATARS = ["🦉", "🐺", "🦊", "🐻", "🦌", "🐍", "🐙", "🦅"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function setup(n, tag) {
  const host = engine.createRoom({ name: `H0-${tag}`, avatar: "🦉", socketId: `${tag}-0` });
  for (let i = 1; i < n; i += 1) {
    engine.joinRoom({
      code: host.room.code,
      name: `H${i}-${tag}`,
      avatar: AVATARS[i % AVATARS.length],
      socketId: `${tag}-${i}`,
    });
  }
  engine.startGame(host.room, host.player.id);
  return host.room;
}

// policy: 'random' — все голосуют случайно; 'smart' — живые знают, кто заражён.
function playOne(n, policy, tag) {
  const room = setup(n, tag);
  const code = room.code;
  let guard = 0;
  let crisisDeaths = 0;
  let exiles = 0;

  while (room.state !== "end" && guard < 600) {
    guard += 1;
    const alive = () => room.players.filter((p) => p.alive);
    const host = room.players.find((p) => p.id === room.hostId) || alive()[0];

    if (room.state === "intro") {
      engine.skipPhase(code, host.id);
      continue;
    }
    if (room.state === "reveal") {
      const id = room.turn ? room.turn.order[room.turn.index] : null;
      const me = room.players.find((p) => p.id === id);
      if (!me || !me.alive) {
        engine.skipPhase(code, host.id);
        continue;
      }
      const idx = me.traits.findIndex((t) => !t.revealed);
      if (idx >= 0) engine.revealTrait(code, me.id, idx);
      engine.endTurn(code, me.id);
      continue;
    }
    if (room.state === "discussion") {
      engine.skipPhase(code, host.id);
      continue;
    }
    if (room.state === "vote") {
      const voters = alive();
      const deadBefore = new Set(room.players.filter((p) => !p.alive).map((p) => p.id));
      const daysLeft = room.rescueDay - room.day;
      const foodPerDay = voters.length;
      const mustSlim = policy === "smart" && room.resources.food < daysLeft * foodPerDay;
      const canSlim = voters.length - 1 >= room.crewMin;
      const expel = policy === "random" || (mustSlim && canSlim);
      // «умные» изгоняют слабейшего по раскрытым картам, случайные — кого попало
      const candidates = [...voters].sort(
        (a, b) =>
          a.traits.filter((t) => t.revealed).length - b.traits.filter((t) => t.revealed).length,
      );
      for (const voter of voters) {
        const others = voters.filter((p) => p.id !== voter.id);
        if (!others.length) continue;
        if (!expel) {
          engine.castVote(code, voter.id, "skip");
          continue;
        }
        const target =
          policy === "smart" ? candidates.find((p) => p.id !== voter.id) : pick(others);
        engine.castVote(code, voter.id, target.id);
      }
      engine.skipPhase(code, host.id); // голосование + кризис + следующий день
      for (const p of room.players) {
        if (!p.alive && !deadBefore.has(p.id)) {
          if (p.death?.cause === "crisis") crisisDeaths += 1;
          else if (p.death?.cause === "exile") exiles += 1;
        }
      }
      continue;
    }
    break;
  }

  return {
    winner: room.winner,
    day: room.day,
    turns: guard,
    crisisDeaths,
    exiles,
    food0: room.resources.food === 0,
    energy0: room.resources.energy === 0,
  };
}

const round = (x) => Math.round(x * 10) / 10;
console.log(`партий на состав: ${GAMES}\n`);
console.log("N  | спаслись | погибли | дней | ходов | еда=0 | энерг=0 | изгнаний");

for (const n of SIZES) {
  for (const policy of ["random", "smart"]) {
    const rows = [];
    for (let i = 0; i < GAMES; i += 1) {
      rows.push(
        playOne(n, policy, `${policy}-${n}-${i}-${Math.random().toString(36).slice(2, 6)}`),
      );
    }
    const share = (w) => round((rows.filter((r) => r.winner === w).length / rows.length) * 100);
    const avg = (f) => round(rows.reduce((s, r) => s + f(r), 0) / rows.length);
    const crisisShare = round((rows.filter((r) => r.crisisDeaths > 0).length / rows.length) * 100);
    const food0 = round((rows.filter((r) => r.food0).length / rows.length) * 100);
    const energy0 = round((rows.filter((r) => r.energy0).length / rows.length) * 100);
    console.log(
      `${String(n).padStart(2)} | ${String(share("survived")).padStart(8)}% | ${String(share("none")).padStart(7)}% | ${String(avg((r) => r.day)).padStart(4)} | ${String(avg((r) => r.turns)).padStart(5)} | ${String(food0).padStart(5)}% | ${String(energy0).padStart(6)}% | ${String(avg((r) => r.exiles)).padStart(8)}   ${policy}`,
    );
  }
}

process.exit(0);
