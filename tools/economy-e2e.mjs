// Экономика: стартовые запасы и суточный расход растут с составом.
// Считаем на движке (без сервера и таймеров) и вычитаем припасы смены, чтобы
// характеристики не сбивали числа. Механику характеристик проверяет traits-e2e.
//
//   bun tools/economy-e2e.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const engine = require(join(import.meta.dir, "..", "src", "engine.js"));

const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

let seq = 0;
function makeRoom(n) {
  seq += 1;
  const host = engine.createRoom({ name: `E0-${seq}`, avatar: "🦉", socketId: `e${seq}-0` });
  for (let i = 1; i < n; i += 1) {
    engine.joinRoom({
      code: host.room.code,
      name: `E${i}-${seq}`,
      avatar: "🐺",
      socketId: `e${seq}-${i}`,
    });
  }
  engine.startGame(host.room, host.player.id);
  return host.room;
}

// нейтральные карты: убираем модификаторы, чтобы видеть базовые числа
function neutralise(target) {
  for (const player of target.players) {
    for (const trait of player.traits) trait.value = "абсолютно здоров";
  }
}

const base = (room) => {
  const supply = engine.supplyOf(room);
  return {
    food: Math.round((room.resources.food - supply.food) * 10) / 10,
    energy: Math.round((room.resources.energy - supply.energy) * 10) / 10,
    foodSupply: supply.food,
    energySupply: supply.energy,
  };
};

const small = makeRoom(5);
const big = makeRoom(15);

const smallBase = base(small);
const bigBase = base(big);
console.log(
  `  5 игроков: база ${JSON.stringify(smallBase)}, всего еды ${small.resources.food} (припасы +${smallBase.foodSupply})`,
);
console.log(
  ` 15 игроков: база ${JSON.stringify(bigBase)}, всего еды ${big.resources.food} (припасы +${bigBase.foodSupply})`,
);

note(smallBase.food === 26, `5 игроков: еда = (R−1)·5+6 (${smallBase.food})`);
note(bigBase.food === 96, `15 игроков: еда = (R−1)·15+6 (${bigBase.food})`);
note(
  big.resources.food > small.resources.food,
  `15 игроков: еды больше (${big.resources.food} > ${small.resources.food})`,
);
note(
  big.resources.meds > small.resources.meds,
  `15 игроков: медикаментов больше (${big.resources.meds} > ${small.resources.meds})`,
);

neutralise(small);
neutralise(big);
const smallCost = engine.dailyCost(small);
const bigCost = engine.dailyCost(big);
console.log(`  расход: 5 → ${JSON.stringify(smallCost)}, 15 → ${JSON.stringify(bigCost)}`);

note(smallCost.food === 5, `расход еды = живые (5 → −${smallCost.food})`);
note(bigCost.food === 15, `расход еды = живые (15 → −${bigCost.food})`);
note(smallCost.energy === 2, `расход энергии на 5 → −${smallCost.energy} (минимум 2)`);
note(bigCost.energy === 5, `расход энергии на 15 → −${bigCost.energy} (1 за каждые 3)`);

// Дни считаем по базовым запасам (без случайных припасов смены), иначе тест
// плавает: у кого-то в картах ящик консервов, у кого-то нет.
const smallDays = smallBase.energy / smallCost.energy;
const bigDays = bigBase.energy / bigCost.energy;
note(
  Math.abs(smallDays - bigDays) <= 2,
  `энергии хватает примерно одинаково: ${smallDays.toFixed(1)} и ${bigDays.toFixed(1)} дн.`,
);

const smallFoodDays = smallBase.food / smallCost.food;
const bigFoodDays = bigBase.food / bigCost.food;
note(
  Math.abs(smallFoodDays - bigFoodDays) <= 2,
  `еды хватает примерно одинаково: ${smallFoodDays.toFixed(1)} и ${bigFoodDays.toFixed(1)} дн.`,
);

// события масштабируются от состава (чистая функция движка)
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

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nэкономика: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
