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
//   BUNKER_AI_SESSION=<id>   (необязательно; для Go-шлюза OpenCode)
//   BUNKER_AI_REASONING=none|low|medium|high  (необязательно)
//
// Reasoning-модели (DeepSeek V4) по умолчанию тратят max_tokens на размышления
// и возвращают пустой content с finish_reason=length. BUNKER_AI_REASONING=none
// отключает это на шлюзах, которые поддерживают reasoning_effort; для моделей
// без рассуждений параметр не нужен и не отправляется.
//
// OpenCode Go требует заголовок x-opencode-session: без него 400
// MissingSessionID. Сессия стабильна на процесс — этого достаточно для
// маршрутизации; разные комнаты всё равно ходят одним потоком вызовов.
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
// Шлюз OpenCode Go просит стабильный id сессии; остальным провайдерам
// заголовок не нужен и может быть лишним.
const IS_OPENCODE = BASE.includes("opencode.ai");
// Сессия — на один вызов, а не на процесс: при параллельной генерации
// (несколько комнат, лобби + событие) общий id путал маршрутизацию Go-шлюза,
// и часть ответов обрывалась на finish_reason=length.
const SESSION_ID = process.env.BUNKER_AI_SESSION || "";
const REASONING = process.env.BUNKER_AI_REASONING || "";

export const aiMode = MODE;
export const aiEnabled = () => MODE === "live" || MODE === "mock";

type Json = Record<string, unknown>;

// Один запрос к модели. Никогда не бросает: на любую ошибку возвращает null,
// вызывающая сторона откатывается на статичное поведение.
// retry=true — ответ оборван по max_tokens (finish_reason=length): имеет смысл
// повторить с большим бюджетом, потому что часть токенов ушла на reasoning.
async function requestJson(
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ data: Json | null; retry: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`,
        // Go-шлюз просит идентифицировать клиента своим user-agent, а не SDK.
        "user-agent": "bunker9-game/2.0",
        ...(IS_OPENCODE
          ? { "x-opencode-session": SESSION_ID || `bunker9-${crypto.randomUUID()}` }
          : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.85,
        max_tokens: maxTokens,
        ...(REASONING ? { reasoning_effort: REASONING } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Тело ошибки объясняет причину (MissingSessionID, баланс, модель) —
      // без него в логах оставался только код.
      const body = await res.text().catch(() => "");
      console.warn(`[ai] ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      return { data: null, retry: false };
    }
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content;
    const reason = choice?.finish_reason;
    const truncated = reason === "length";
    if (typeof text !== "string" || !text.trim()) {
      console.warn(`[ai] пустой ответ (finish_reason=${reason ?? "?"}, max_tokens=${maxTokens})`);
      return { data: null, retry: truncated };
    }
    try {
      return { data: JSON.parse(text) as Json, retry: false };
    } catch {
      // Обрезанный по max_tokens JSON — самый частый сбой: видно по finish_reason.
      console.warn(
        `[ai] битый JSON (finish_reason=${reason ?? "?"}, ${text.length} симв., max_tokens=${maxTokens}): ${text.slice(0, 120)}…${text.slice(-60)}`,
      );
      return { data: null, retry: truncated };
    }
  } catch (error) {
    console.warn("[ai] вызов не удался:", (error as Error)?.message);
    return { data: null, retry: false };
  } finally {
    clearTimeout(timer);
  }
}

// GLM и DeepSeek иногда тратят заметную часть бюджета на reasoning и обрывают
// JSON на середине (finish_reason=length). Один повтор с удвоенным лимитом
// вытягивает такие ответы; обычные вызовы остаются в один запрос.
async function chatJson(system: string, user: string, maxTokens = 700): Promise<Json | null> {
  if (!aiEnabled()) return null;
  if (MODE === "mock") return mockAnswer(system, user);
  let budget = maxTokens;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, retry } = await requestJson(system, user, budget);
    if (data) return data;
    if (!retry || attempt === 1) return null;
    budget = Math.min(6000, maxTokens * 2);
    console.warn(`[ai] повтор с max_tokens=${budget}`);
  }
  return null;
}

const clean = (value: unknown, limit: number): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

// ---------- 1. Персонажи ----------

export type Persona = { values: string[] };

const PERSONA_SYSTEM = `Ты — генератор персонажей для игры «Бункер» (постапокалипсис, теснота, дефицит).
Верни строго JSON: {"players":[{"values":["...","...","...","...","...","...","...","..."]}]}
Порядок строго: ${TRAITS.map((t) => t.label).join(", ")}.
Формат значений:
1. Пол и возраст: «женщина · 34 года · чайлдфри». Если персонаж не чайлдфри —
   только пол и возраст, без пометки: «мужчина · 45 лет». Детей не упоминать.
2. Рост и вес: «175 см · 72 кг · норма» (последнее слово — норма, полнота, ожирение или худоба).
3. Здоровье: «астма · лёгкая» (степень: лёгкая, средняя или тяжёлая) либо «абсолютно здоров».
4. Профессия: «сварщик · 6 разряд», «медсестра · 2 категория».
5. Хобби: «радиодело · продвинуто» (уровень: любитель, уверенно, продвинуто или мастер).
6. Багаж: одна конкретная вещь, которую можно вскрыть.
7. Крупный багаж: одна крупная вещь или запас.
8. Спецвозможность: строго одно из «обмен», «НЗ», «разведка».
Значения конкретные и бытовые, 1–5 слов. Никаких повторов между игроками. Без кавычек
внутри значений, без имён и ролей, без тайных знаний о других. Язык — русский.
Распределение: на 5–8 игроков максимум одно «ожирение» и максимум одна «тяжёлая»
болезнь; большинство — «норма», «лёгкая» или «абсолютно здоров».`;

export async function generatePersonas(
  names: string[],
  catastrophe: string,
): Promise<Persona[] | null> {
  const data = await chatJson(
    PERSONA_SYSTEM,
    `Игроков: ${names.length}. Контекст катастрофы: ${catastrophe}. Позывные: ${names.join(", ")}.`,
    // 8 карт × N игроков: на 15 человек JSON длинный, плюс GLM иногда тратит
    // часть бюджета на reasoning. 3000 обрезало ответы, поэтому 4000.
    4000,
  );
  const list = Array.isArray(data?.players) ? (data.players as any[]) : null;
  if (!list || list.length < names.length) return null;
  const out: Persona[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const raw = list[i]?.values;
    if (!Array.isArray(raw) || raw.length < TRAITS.length) return null;
    out.push({ values: raw.slice(0, TRAITS.length).map((v) => clean(v, 60)) });
  }
  // Модель любит драматичные карты: ограничиваем экстремумы, чтобы в партии
  // не оказывалось по три ожирения и по три тяжёлых болезни. Для 5–8 игроков
  // максимум один экстремум, для 9–15 — два. Лишние меняем на соседнюю
  // ступень, сохраняя числа роста/веса.
  const limit = Math.max(1, Math.ceil(names.length / 8));
  const cap = (index: number, marker: string, replacement: string) => {
    let seen = 0;
    for (const persona of out) {
      const parts = persona.values[index].split("·").map((part) => part.trim());
      const last = (parts.at(-1) || "").toLowerCase();
      if (!last.includes(marker)) continue;
      seen += 1;
      if (seen <= limit) continue;
      parts[parts.length - 1] = replacement;
      persona.values[index] = parts.join(" · ");
    }
  };
  cap(1, "ожирение", "полнота");
  cap(2, "тяжёл", "средняя");
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
    2000,
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
  const data = await chatJson(RECAP_SYSTEM, `Лог партии:\n${log}`, 2500);
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

// ---------- 6. Сюжет партии ----------

const STORY_SYSTEM = `Ты — сценарист постапокалиптической игры «Бункер».
Придумай катастрофу и «правду о бункере» для одной партии.
Верни строго JSON: {"title":"...","premise":"...","threat":"..."}
Правила: title — 2–3 слова капсом без точки; premise — 2 предложения (75–110 слов
не нужно, 160–220 знаков), что произошло и почему они заперты; threat — короткая
деталь-угроза до 60 знаков, которая будет звучать в событиях.
Конкретика быта: вентиляция, вода, генератор, склад, радио, соседние отсеки.
Без ролей, без «заражённых», без имён игроков. Язык — русский.`;

export async function generateStory(): Promise<{
  title: string;
  premise: string;
  threat: string;
} | null> {
  const data = await chatJson(STORY_SYSTEM, "Придумай новую партию.", 2000);
  const title = clean(data?.title, 40);
  const premise = clean(data?.premise, 260);
  const threat = clean(data?.threat, 80);
  if (!title || !premise) return null;
  return { title, premise, threat };
}

// ---------- 4. Подсказки на обсуждении ----------

const HINTS_SYSTEM = `Ты — ведущий игры «Бункер». По публичной картине дня придумай 2–3 наводки
для обсуждения: конкретные вопросы к конкретным игрокам.
Верни строго JSON: {"hints":["...","..."]}
Правила: каждая наводка — одно предложение до 120 знаков, обращение по имени,
опирается только на раскрытые карты, молчание и запасы. Не выдумывай факты,
не упоминай скрытые значения карт. Язык — русский.`;

export async function generateHints(context: string): Promise<string[] | null> {
  const data = await chatJson(HINTS_SYSTEM, `Публичная картина дня: ${context}`, 2000);
  const list = Array.isArray(data?.hints) ? (data.hints as unknown[]) : null;
  if (!list) return null;
  const hints = list
    .map((h) => clean(h, 160))
    .filter(Boolean)
    .slice(0, 3);
  return hints.length ? hints : null;
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
          `ИИ-пол ${i + 1}`,
          `ИИ-тело ${i + 1}`,
          `ИИ-здоровье ${i + 1}`,
          `ИИ-профессия ${i + 1}`,
          `ИИ-хобби ${i + 1}`,
          `ИИ-багаж ${i + 1}`,
          `ИИ-крупный багаж ${i + 1}`,
          ["обмен", "НЗ", "разведка"][i % 3],
        ],
      })),
    };
  }
  if (system.includes("сценарист")) {
    return {
      title: `ИИ-СЮЖЕТ ${mockSeq}`,
      premise: "Тестовая катастрофа: наверху всё ещё плохо, а внизу уже тесно.",
      threat: "в вентиляции слышно чужое дыхание",
    };
  }
  if (system.includes("наводки")) {
    return {
      hints: [
        `ИИ-наводка ${mockSeq}: спросите про закрытую профессию`,
        `ИИ-наводка ${mockSeq}: кто молчит после изгнания?`,
      ],
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
