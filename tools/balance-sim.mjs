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
  let nights = 0;

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
      for (const voter of voters) {
        const others = voters.filter((p) => p.id !== voter.id);
        if (!others.length) continue;
        let target;
        if (policy === "smart" && voter.role !== "infected") {
          const infected = others.filter((p) => p.role === "infected");
          target = infected.length ? pick(infected) : pick(others);
        } else {
          target = pick(others);
        }
        engine.castVote(code, voter.id, target.id);
      }
      const before = alive().length;
      engine.skipPhase(code, host.id);
      if (alive().length < before) exiles += 1;
      continue;
    }
    if (room.state === "night") {
      nights += 1;
      const aliveNow = alive();
      const infected = aliveNow.filter((p) => p.role === "infected");
      const doctor = aliveNow.find((p) => p.role === "doctor");
      for (const m of infected) {
        const targets = aliveNow.filter((p) => p.role !== "infected");
        if (targets.length) engine.nightAction(code, m.id, pick(targets).id);
      }
      if (doctor) {
        const targets = aliveNow.filter((p) => p.id !== room.lastHealTarget);
        if (targets.length && room.resources.meds > 0 && Math.random() > 0.3) {
          engine.nightAction(code, doctor.id, pick(targets).id);
        } else {
          engine.doctorSkip(code, doctor.id);
        }
      }
      const before = alive().length;
      engine.skipPhase(code, host.id);
      // смерть ночи — не кризис; кризис считаем по причине смерти
      for (const p of room.players) {
        if (!p.alive && p.death?.cause === "crisis") crisisDeaths += 1;
      }
      if (alive().length === before) {
        /* ночь без потерь */
      }
      continue;
    }
    break;
  }

  for (const p of room.players) {
    if (p.death?.cause === "crisis") crisisDeaths += 1;
  }
  return {
    winner: room.winner,
    day: room.day,
    turns: guard,
    crisisDeaths,
    exiles,
    nights,
    food0: room.resources.food === 0,
    energy0: room.resources.energy === 0,
  };
}

const round = (x) => Math.round(x * 10) / 10;
console.log(`партий на состав: ${GAMES}\n`);
console.log("N  | люди  | зараж. | ничья | дней | ходов | кризис-смертей | еда=0 | энерг=0");

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
      `${String(n).padStart(2)} | ${String(share("humans")).padStart(5)}% | ${String(share("infected")).padStart(5)}% | ${String(share("none")).padStart(5)}% | ${String(avg((r) => r.day)).padStart(4)} | ${String(avg((r) => r.turns)).padStart(5)} | ${String(crisisShare).padStart(14)}% | ${String(food0).padStart(5)}% | ${String(energy0).padStart(5)}%   ${policy}`,
    );
  }
}

process.exit(0);
