// ИИ-слой: один клиент к OpenAI-совместимому API и три генератора.
//
// Всё опционально и с фолбэком: без ключа (BUNKER_AI_KEY) игра работает как
// раньше — статичные события, карты из content.js, финал без разбора.
//
//   BUNKER_AI=live|mock|off   (default: live при наличии ключа, иначе off)
//   BUNKER_AI_KEY=...
//   BUNKER_AI_URL=https://api.openai.com/v1
//   BUNKER_AI_MODEL=gpt-4o-mini
//   BUNKER_AI_TIMEOUT_MS=12000
//
// mock — детерминированные ответы без сети: на нём гоняются тесты.
// content.js — CommonJS-пакет контента; берём только заголовки категорий.
const content = require("./content.js");
const TRAITS: { key: string; label: string }[] = content.TRAITS;

const KEY = process.env.BUNKER_AI_KEY ?? "";
const BASE = (process.env.BUNKER_AI_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const MODEL = process.env.BUNKER_AI_MODEL ?? "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.BUNKER_AI_TIMEOUT_MS ?? 12000);
const MODE = (process.env.BUNKER_AI ?? (KEY ? "live" : "off")).toLowerCase();

export const aiMode = MODE;
export const aiEnabled = () => MODE === "live" || MODE === "mock";

type Json = Record<string, unknown>;

// Один вызов модели. Никогда не бросает: на любую ошибку возвращает null,
// вызывающая сторона откатывается на статичное поведение.
async function chatJson(system: string, user: string, maxTokens = 700): Promise<Json | null> {
  if (!aiEnabled()) return null;
  if (MODE === "mock") return mockAnswer(system, user);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.85,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[ai] ${res.status} ${res.statusText}`);
      return null;
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    return JSON.parse(text) as Json;
  } catch (error) {
    console.warn("[ai] вызов не удался:", (error as Error)?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const clean = (value: unknown, limit: number): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

// ---------- 1. Персонажи ----------

export type Persona = { values: string[] };

const PERSONA_SYSTEM = `Ты — генератор персонажей для игры «Бункер» (постапокалипсис, теснота, дефицит).
Верни строго JSON: {"players":[{"values":["...","...","...","...","..."]}]}
Порядок строго: ${TRAITS.map((t) => t.label).join(", ")}.
Правила: значения 1–4 слова, конкретные и бытовые (профессия, диагноз, вещь в багаже,
странный факт, привычка). Никаких повторов между игроками. Без кавычек внутри значений,
без имён и ролей, без тайных знаний о других. Язык — русский.`;

export async function generatePersonas(
  names: string[],
  catastrophe: string,
): Promise<Persona[] | null> {
  const data = await chatJson(
    PERSONA_SYSTEM,
    `Игроков: ${names.length}. Контекст катастрофы: ${catastrophe}. Позывные: ${names.join(", ")}.`,
    900,
  );
  const list = Array.isArray(data?.players) ? (data.players as any[]) : null;
  if (!list || list.length < names.length) return null;
  const out: Persona[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const raw = list[i]?.values;
    if (!Array.isArray(raw) || raw.length < TRAITS.length) return null;
    out.push({ values: raw.slice(0, TRAITS.length).map((v) => clean(v, 60)) });
  }
  return out;
}

// ---------- 2. Событие дня ----------

export type AiEvent = { title: string; text: string; effects: Json };

const EVENT_SYSTEM = `Ты — ведущий игры «Бункер». Придумай событие нового дня.
Верни строго JSON: {"title":"...","text":"...","effects":{"food":0,"energy":0,"meds":0}}
Правила: title — 2–4 слова без точки; text — одно-два предложения, 120–200 знаков,
конкретная бытовая деталь бункера (вентиляция, генератор, склад, медотсек, крысы, вода).
effects: целые числа от -8 до 8, хотя бы одно не равно нулю; обычно 1–2 ресурса.
Не убивай людей напрямую, не упоминай роли и «заражённых». Язык — русский.`;

export async function generateEvent(context: string): Promise<AiEvent | null> {
  const data = await chatJson(
    EVENT_SYSTEM,
    `Состояние партии: ${context}. Придумай событие для следующего дня.`,
    400,
  );
  if (!data) return null;
  const title = clean(data.title, 60);
  const text = clean(data.text, 240);
  if (!title || !text) return null;
  const effects =
    data.effects && typeof data.effects === "object" ? (data.effects as Json) : { food: -2 };
  return { title, text, effects };
}

// ---------- 3. Разбор партии ----------

export type Recap = { title: string; paragraphs: string[]; verdict: string };

const RECAP_SYSTEM = `Ты — комментатор партий в «Бункер». По логу игры напиши короткий разбор.
Верни строго JSON: {"title":"...","paragraphs":["...","..."],"verdict":"..."}
Правила: title — 2–5 слов; 2–3 абзаца по 1–2 предложения (что решило партию, кто ошибся,
где был перелом); verdict — одна фраза-итог. Опирайся только на факты лога.
Без морализаторства и без выдуманных событий. Язык — русский.`;

export async function generateRecap(log: string): Promise<Recap | null> {
  const data = await chatJson(RECAP_SYSTEM, `Лог партии:\n${log}`, 800);
  if (!data) return null;
  const title = clean(data.title, 60);
  const paragraphs = Array.isArray(data.paragraphs)
    ? (data.paragraphs as unknown[])
        .map((p) => clean(p, 400))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const verdict = clean(data.verdict, 160);
  if (!title || !paragraphs.length) return null;
  return { title, paragraphs, verdict };
}

// ---------- mock ----------

let mockSeq = 0;

function mockAnswer(system: string, user: string): Json {
  mockSeq += 1;
  if (system.includes("персонажей")) {
    const names = (user.match(/Позывные: ([^.]+)\./)?.[1] ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const count = Math.max(1, names.length);
    return {
      players: Array.from({ length: count }, (_, i) => ({
        values: [
          `ИИ-профессия ${i + 1}`,
          `ИИ-здоровье ${i + 1}`,
          `ИИ-багаж ${i + 1}`,
          `ИИ-факт ${i + 1}`,
          `ИИ-привычка ${i + 1}`,
        ],
      })),
    };
  }
  if (system.includes("событие")) {
    return {
      title: `ИИ-событие ${mockSeq}`,
      text: "Проверка связи: событие пришло от модели и применилось к запасам бункера.",
      effects: { food: -1, energy: 1 },
    };
  }
  return {
    title: "ИИ-разбор",
    paragraphs: [
      "Команда дошла до спасения, но потеряла половину состава.",
      "Решающим стал день второй.",
    ],
    verdict: "Разбор сгенерирован в тестовом режиме.",
  };
}
