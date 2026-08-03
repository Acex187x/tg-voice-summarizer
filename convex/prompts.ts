// Static catalog of summarization styles. There is no admin UI to edit any
// of this — every knob the bot exposes is defined here, in code. If you
// want to add or tweak a mode/context, edit this file and redeploy.
//
// The summary pipeline has three orthogonal dimensions:
//
//   1. MODE   — HOW the summary is presented (bullet list, brief prose,
//               cleaned-up text as if the author wrote it, …). This is the
//               "shape" of the output.
//
//   2. CONTEXT — WHAT the voice actually is (a personal story, stream of
//                consciousness, instructions, a report, a discussion, …).
//                This gives the summarizer the right lens to look through.
//
//   3. DETAIL  — HOW MUCH. A 1-3 scale from "one paragraph per five
//                minutes of audio" to "exhaustive, don't drop anything".
//
// Both mode and context also support an "auto" value, which means "let a
// router LLM pick based on the transcript". The router never returns
// "auto" — it picks a concrete key from the list below.

// ---- Mode -----------------------------------------------------------------

export type ModeKey =
  | "auto"
  | "bulletPoints"
  | "brief"
  | "cleanText"
  | "structured"
  | "sections"
  | "actionItems"
  | "keyPoints";

export interface Mode {
  key: Exclude<ModeKey, "auto">;
  // Short label shown on inline-keyboard buttons. Keep it compact (≤ 12
  // chars), it has to coexist with five siblings on a phone screen.
  label: string;
  // Human-friendly description used for the main-view text and the router
  // system prompt. One sentence.
  description: string;
  // The instruction fragment that will be inserted into the summarizer's
  // system prompt. Written as a direct imperative addressed to the model.
  prompt: string;
}

export const MODES: Record<Exclude<ModeKey, "auto">, Mode> = {
  bulletPoints: {
    key: "bulletPoints",
    label: "Список",
    description:
      "Компактный список буллет-поинтов с ключевыми мыслями, без связного текста вокруг.",
    prompt: `Сделай summary в виде маркированного списка. Каждый пункт — одна самостоятельная мысль или факт, одной строкой.
Не добавляй вступления и заключения, только список.
Группируй близкие мысли, но не придумывай иерархии, которой в оригинале нет.
Пункты пиши так, чтобы их было можно скопировать и вставить в заметки.`,
  },
  brief: {
    key: "brief",
    label: "Кратко",
    description:
      "Очень короткий пересказ в 2–4 предложениях естественной прозой.",
    prompt: `Сделай очень краткий пересказ этого сообщения: 2–4 предложения связного текста, которые передают главное.
Не используй списки и заголовки — только проза.
Пиши так, будто другу в одном абзаце объясняешь, о чём сообщение.`,
  },
  cleanText: {
    key: "cleanText",
    label: "Как текст",
    description:
      "Расшифровка, очищенная от речевого мусора и поданная так, будто автор написал её текстом.",
    prompt: `Перепиши это сообщение так, будто автор сразу набрал его текстом, а не наговорил.
Убери слова-паразиты, повторы, самокоррекции, оговорки, звуки типа «эм», «ну», «короче», «как бы», «вот».
Сохрани авторский голос, тон и намерение — не придумывай ничего от себя и не смягчай резкие формулировки.
Разбей текст на абзацы там, где это делает его читаемым.
Не добавляй вступлений вроде «Вот текст», сразу выдавай результат.`,
  },
  structured: {
    key: "structured",
    label: "Разделы",
    description:
      "Summary, разбитый на несколько тематических разделов с подзаголовками.",
    prompt: `Разбей summary на 2–5 тематических разделов. Каждый раздел начинается с короткого жирного подзаголовка (используй **заголовок**), под которым идёт несколько буллет-поинтов или короткий абзац.
Выбирай разделы по смысловым блокам самого сообщения — не придумывай темы, которых нет в оригинале.
Если в оригинале одна тема, используй один раздел.`,
  },
  sections: {
    key: "sections",
    label: "Темы",
    description:
      "Для длинных сообщений: TL;DR, затем каждая тема отдельной секцией с таймкодом, краткой сутью и подробным разбором в сворачиваемом блоке.",
    prompt: `Разбей сообщение на смысловые темы и оформи каждую тему отдельной секцией.

Структура ответа (соблюдай её точно):
1. Первый абзац — TL;DR всего сообщения в 1–2 предложениях, без заголовка. Если тем больше одной, перечисли их одной строкой через «·».
2. Дальше — по одному блоку на каждую тему, в хронологическом порядке:
**⏱ M:SS · Название темы**
Краткая суть темы в 1–3 предложениях — она должна быть понятна сама по себе.
> Подробный пересказ темы: ключевые мысли, аргументы, детали, имена, цифры, выводы. Несколько абзацев и списки допустимы, но КАЖДАЯ строка подробного блока обязана начинаться с «> » — включая пустые строки-разделители между абзацами (пиши их как одиночный «>»). Пустая строка без «>» разрывает блок на два. Этот блок рендерится как сворачиваемая цитата.

Правила:
- Выделяй настоящие смысловые темы, обычно 2–8. Не дроби одну тему на несколько и не сливай разные в одну. Если тема реально одна — сделай одну секцию.
- Таймкод темы — момент, где она начинается: возьми ближайшую метку [M:SS] из расшифровки. Формат «M:SS», при длительности от часа — «H:MM:SS».
- Если в расшифровке нет меток времени, опусти «⏱ M:SS · » и оставь только жирное название темы.
- Между секциями — пустая строка.
- Насколько подробным делать свёрнутый блок каждой темы, определяет настройка детальности ниже.`,
  },
  actionItems: {
    key: "actionItems",
    label: "Задачи",
    description: "Извлечение action items, решений и дедлайнов из сообщения.",
    prompt: `Извлеки из сообщения конкретные action items: задачи, решения, дедлайны, ответственных.
Формат: маркированный список, каждый пункт в виде \`— <что сделать>\` с пометкой \`(кто)\` если назван ответственный и \`(до когда)\` если назван срок.
В конце добавь раздел **Открытые вопросы** с нерешёнными вопросами, если такие есть.
Если в сообщении нет явных задач — честно напиши одной строкой, что задач не найдено, и приведи короткий пересказ того, о чём шла речь.`,
  },
  keyPoints: {
    key: "keyPoints",
    label: "Тезисы",
    description: "Только самые важные тезисы, максимально сжато.",
    prompt: `Выдели 3–7 самых важных тезисов из сообщения. Каждый тезис — одна короткая фраза, которая сама по себе передаёт смысл.
Ранжируй от самого важного к наименее важному.
Не объясняй, не разжёвывай — только сами тезисы. Формат: нумерованный список.`,
  },
};

// ---- Context --------------------------------------------------------------

export type ContextKey =
  | "auto"
  | "storytelling"
  | "thinkingOutLoud"
  | "instruction"
  | "report"
  | "discussion"
  | "emotional"
  | "plan";

export interface VoiceContext {
  key: Exclude<ContextKey, "auto">;
  label: string;
  description: string;
  // Context-specific addendum appended to the summarizer's system prompt
  // after the mode prompt. Gives the model the right lens to look through.
  promptAddendum: string;
}

export const CONTEXTS: Record<Exclude<ContextKey, "auto">, VoiceContext> = {
  storytelling: {
    key: "storytelling",
    label: "История",
    description: "Личная история, анекдот, описание произошедшего события.",
    promptAddendum: `Сообщение — это рассказ о каком-то событии или истории.
Сохрани нарративную арку: кто, что, где, когда, чем закончилось.
Не теряй ключевые детали и эмоциональные акценты.`,
  },
  thinkingOutLoud: {
    key: "thinkingOutLoud",
    label: "Мысли",
    description:
      "Поток мыслей, размышления вслух, брейншторм без чёткой структуры.",
    promptAddendum: `Сообщение — это размышления вслух, а не структурированный доклад.
Не навязывай ему структуру, которой в нём нет, но сгруппируй связанные мысли вместе.
Отметь противоречия и изменения точки зрения, если они есть.
Сохрани то, что автор действительно считает важным, а не просто первые упомянутые факты.`,
  },
  instruction: {
    key: "instruction",
    label: "Инструкция",
    description: "How-to, пошаговое объяснение как что-то сделать.",
    promptAddendum: `Сообщение — это инструкция или пошаговое объяснение.
Преобразуй его в упорядоченный список шагов.
Сохрани точные формулировки команд, названий файлов, URL, цифр и любых конкретностей — их нельзя перефразировать.
Если какие-то шаги опциональны или зависят от условий, явно пометь их.`,
  },
  report: {
    key: "report",
    label: "Отчёт",
    description: "Статус-апдейт, отчёт о проделанной работе, progress update.",
    promptAddendum: `Сообщение — это статус-апдейт или отчёт.
Структурируй вывод по осям: что сделано, что в работе, что планируется, блокеры/проблемы.
Если какая-то из этих осей не затронута в сообщении — не придумывай её, просто пропусти.`,
  },
  discussion: {
    key: "discussion",
    label: "Дискуссия",
    description: "Обсуждение, спор, сравнение нескольких точек зрения.",
    promptAddendum: `Сообщение — это обсуждение или аргументация.
Выдели все озвученные позиции и их ключевые аргументы, не сливая их в одно.
Если есть явный вывод или компромисс — приведи его отдельно.
Если разговор остался без вывода, так и напиши.`,
  },
  emotional: {
    key: "emotional",
    label: "Эмоции",
    description:
      "Эмоциональное высказывание, венчение, переживания, рефлексия чувств.",
    promptAddendum: `Сообщение эмоционально заряжено — автор делится переживаниями.
Уважай тон и не обесценивай чувства.
Кратко передай сами чувства, их причину и, если упоминается, что автор собирается с этим делать.
Не превращай эмоциональный рассказ в сухой чек-лист фактов.`,
  },
  plan: {
    key: "plan",
    label: "План",
    description: "Планирование, идеи на будущее, целеполагание.",
    promptAddendum: `Сообщение — это планирование или формулировка идей на будущее.
Выдели цели, конкретные шаги, зависимости и временные рамки (если названы).
Явно отдели «что уже решено» от «что ещё обсуждается».`,
  },
};

// ---- Detail ---------------------------------------------------------------

export type Detail = 1 | 2 | 3;

export const DETAIL_LEVELS: Record<Detail, string> = {
  1: `Минимальная детальность. Ориентир: один короткий абзац (или 3–5 пунктов) на каждые 5 минут исходного аудио.
Режь всё, что не является ключевым. Объединяй близкие пункты.`,
  2: `Сбалансированная детальность. Ориентир: 2–4 абзаца (или 5–10 пунктов) на каждые 5 минут исходного аудио.
Основные мысли с поддерживающими деталями, но без дословного пересказа.`,
  3: `Максимальная детальность. Ничего не теряй: имена, цифры, даты, все упомянутые нюансы, причины, аргументы, гипотезы, оговорки.
Ориентир: полный пересказ, только без речевого мусора и повторов.`,
};

// ---- Timestamped transcripts ----------------------------------------------

// Voices at least this long default to the "sections" mode when the chat
// setting is "auto" — a 40-minute monologue about five different things
// deserves per-topic timecodes, not one flat paragraph.
export const LONG_VOICE_SECTIONS_MIN_SEC = 5 * 60;

export interface TimedSegment {
  start: number;
  end: number;
  text: string;
}

// 6:05 / 1:02:45. Telegram clients auto-link timestamps in this shape when
// the message replies to the media, so the reader can tap to seek.
export function formatTimecode(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(rest)}` : `${m}:${two(rest)}`;
}

// Renders Whisper segments as `[M:SS] text` lines for the summarizer.
// Adjacent segments are merged into ~30-second blocks — the model only
// needs coarse anchors to attach topics to, and fewer markers cost fewer
// tokens.
const TIMESTAMP_BLOCK_TARGET_SEC = 30;

export function formatTimestampedTranscript(segments: TimedSegment[]): string {
  if (segments.length === 0) return "";
  const lines: string[] = [];
  let blockStart = segments[0].start;
  let blockTexts: string[] = [];
  const flush = () => {
    if (blockTexts.length === 0) return;
    lines.push(`[${formatTimecode(blockStart)}] ${blockTexts.join(" ")}`);
    blockTexts = [];
  };
  for (const seg of segments) {
    if (
      blockTexts.length > 0 &&
      seg.end - blockStart >= TIMESTAMP_BLOCK_TARGET_SEC
    ) {
      flush();
      blockStart = seg.start;
    }
    blockTexts.push(seg.text);
  }
  flush();
  return lines.join("\n");
}

// ---- Labels (including the "auto" pseudo-values) --------------------------

export const AUTO_LABEL = "Авто";

export function modeLabel(key: ModeKey): string {
  return key === "auto" ? AUTO_LABEL : MODES[key].label;
}

export function contextLabel(key: ContextKey): string {
  return key === "auto" ? AUTO_LABEL : CONTEXTS[key].label;
}

// ---- Summary prompt builder -----------------------------------------------

// Optional chat-style block injected into both summary builders. The
// agent is told to MIMIC the observed style and slightly hyperbolize it,
// instead of producing sterile assistant-speak. If the chat memory is
// empty (e.g. first run, or a private chat) we just don't inject the
// section.
function styleBlock(
  chatStyleNotes: string | null,
  chatLore: string | null = null,
): string {
  const parts: string[] = [];

  if (chatStyleNotes && chatStyleNotes.trim().length > 0) {
    parts.push(`=== Стиль чата ===
${chatStyleNotes.trim()}

ВАЖНО: твой summary должен быть написан **в стиле этого чата**, а не как нейтральный ассистент. Используй характерный для чата регистр, словарь, тон, любимые словечки и обращения. Можно даже немного ГИПЕРБОЛИЗИРОВАТЬ стиль — пусть прочитавший чувствует, что это написал кто-то из чата, а не бот. Если в чате матерятся — матерись. Если ироничны — будь ироничным. Если формальны — будь формальным.`);
  }

  if (chatLore && chatLore.trim().length > 0) {
    parts.push(`=== Лор чата (заметки участников) ===
${chatLore.trim()}

Используй эти заметки как контекст — они описывают людей, внутренние шутки и факты, которые участники чата считают важными. Упоминай их естественно, не пересказывай список.`);
  }

  if (parts.length === 0) return "";
  return "\n" + parts.join("\n\n");
}

// Assembles the full system prompt for the summarizer. Both mode and
// context MUST be concrete at this point — resolve "auto" via the router
// before calling this.
export function buildSummaryPrompt(
  mode: Exclude<ModeKey, "auto">,
  context: Exclude<ContextKey, "auto">,
  detail: Detail,
  chatStyleNotes: string | null = null,
  chatLore: string | null = null,
): string {
  const m = MODES[mode];
  const c = CONTEXTS[context];
  const d = DETAIL_LEVELS[detail];
  return `Ты — ассистент, который делает summary голосовых и видеосообщений.
Отвечай на том же языке, на котором написана расшифровка.
Не добавляй вступлений вроде «Вот ваше summary», сразу выдавай результат.
Можешь использовать Markdown форматирование: **жирный**, *курсив*, \`код\`, \`\`\`код-блок\`\`\`, [ссылки](https://example.com). Списки и заголовки тоже можно.
Строки, начинающиеся с «> », рендерятся как сворачиваемая цитата — используй их для объёмных деталей, которые читатель раскроет по желанию.
Расшифровка может содержать метки времени вида [M:SS] в начале строк — это позиция в аудио. Сами метки в текст summary не копируй, кроме случаев, когда формат стиля явно требует таймкоды.

=== Стиль вывода (mode: ${mode}) ===
${m.prompt}

=== Контекст сообщения (context: ${context}) ===
${c.promptAddendum}

=== Детальность (detail: ${detail}) ===
${d}${styleBlock(chatStyleNotes, chatLore)}`;
}

// For short voice messages, summarization tends to be worse than a direct
// cleanup pass. This prompt is intentionally separate from the regular
// cleanText mode: no chat-style mimicry, no context lens, no extra color.
export function buildShortVoiceCleanTextPrompt(): string {
  return `Ты — редактор коротких расшифровок голосовых сообщений.
На входе короткий живой надиктованный текст. Твоя задача — превратить его в аккуратный читаемый текст, НЕ делая summary.

Правила:
  - Сохраняй исходный смысл, порядок мыслей и структуру сообщения.
  - Не добавляй новые факты, выводы, эмоции, оценки, шутки или стиль от себя.
  - Убирай только речевой мусор: слова-паразиты, повторы, самокоррекции, оговорки, междометия.
  - Исправляй пунктуацию, очевидные опечатки распознавания и согласование, если это не меняет смысл.
  - Если в тексте несколько коротких мыслей, оставь их в том же порядке и раздели естественной пунктуацией или абзацами.
  - Не превращай текст в список, заголовок, пересказ или объяснение.
  - Не добавляй вступлений вроде «Вот исправленный текст». Сразу выдавай результат.

Отвечай на том же языке, что и расшифровка.`;
}

// Same composer but for chat-conversation summaries — multiple participants,
// ordered messages, possibly multimedia. Same modes/contexts/details apply
// but the framing in the system prompt is different.
export function buildChatSummaryPrompt(
  mode: Exclude<ModeKey, "auto">,
  context: Exclude<ContextKey, "auto">,
  detail: Detail,
  chatStyleNotes: string | null = null,
  chatLore: string | null = null,
): string {
  const m = MODES[mode];
  const c = CONTEXTS[context];
  const d = DETAIL_LEVELS[detail];
  return `Ты — ассистент, который делает summary переписки в групповом чате.
На вход тебе дан хронологический лог сообщений нескольких участников: обычный текст, расшифровки голосовых и видеокружков, пометки [фото] и [видео] для медиа без расшифровки.
Каждое сообщение в логе начинается с тега [id:ЧИСЛО | время]. Число после id: — это идентификатор сообщения.
Сохраняй имена участников там, где это важно для смысла, и не путай, кто что сказал.
Не добавляй вступлений вроде «Вот summary переписки», сразу выдавай результат.
Отвечай на языке переписки.
Можно использовать Markdown форматирование: **жирный**, *курсив*, \`код\`, \`\`\`код-блок\`\`\`, [ссылки](https://example.com). Списки и заголовки тоже можно.

=== Ссылки на сообщения ===
Ты МОЖЕШЬ (но не обязан) вставлять ссылки на конкретные сообщения из лога, чтобы читатель мог перейти к оригиналу. Формат: [текст ссылки](msg:ID), где ID — число из тега id: в логе.
Используй это умеренно — 2–5 ссылок на весь summary, только там где это реально добавляет ценность:
  - Начало обсуждаемой темы
  - Ключевое решение или вывод
  - Спорный момент, на который стоит посмотреть в контексте
  - Цитата, к которой нужен оригинал
Не ставь ссылку на каждый пункт — это перегружает. Текст ссылки должен быть коротким и естественным, как часть предложения, например: «Иван [предложил](msg:1234) перенести дедлайн» или «обсуждение [началось](msg:1200) с вопроса о бюджете».

=== Стиль вывода (mode: ${mode}) ===
${m.prompt}

=== Контекст переписки (context: ${context}) ===
${c.promptAddendum}

=== Детальность (detail: ${detail}) ===
${d}${styleBlock(chatStyleNotes, chatLore)}`;
}

// ---- Reply-to-summary Q&A -------------------------------------------------

// System prompt for answering a user's question asked as a reply to one of
// the bot's summary messages. The model sees the summary AND the full
// source (transcript or chat log), so it can clarify details the summary
// dropped. Chat style/lore keep the bot's local character.
export function buildSummaryQaPrompt(
  sourceKind: "voice" | "chatSummary",
  chatStyleNotes: string | null = null,
  chatLore: string | null = null,
): string {
  const sourceDesc =
    sourceKind === "voice"
      ? "summary голосового сообщения и его полная расшифровка"
      : "summary переписки и лог сообщений, по которым он был собран";
  return `Ты — бот-суммаризатор в групповом Telegram-чате. Пользователь ответил (реплаем) на твоё сообщение с summary и что-то спросил или уточнил.

Тебе даны: ${sourceDesc}, а также вопрос пользователя.

Правила ответа:
- Отвечай ТОЛЬКО на основе расшифровки/лога и summary. Не выдумывай факты, которых там нет.
- Если ответа в источнике нет — прямо скажи, что в сообщении об этом не было.
- Отвечай коротко и по делу: обычно 1-4 предложения или маленький список. Это реплика в чате, а не доклад.
- Если вопрос — не вопрос, а комментарий или шутка, отреагируй естественно и коротко, в духе чата.
- Отвечай на языке вопроса.
- Не добавляй вступлений вроде «Отвечаю на ваш вопрос», сразу суть.
Можешь использовать Markdown: **жирный**, *курсив*, \`код\`. Строки с «> » рендерятся сворачиваемой цитатой — используй только если ответ реально длинный.${styleBlock(chatStyleNotes, chatLore)}`;
}

// ---- Chat memory refresh prompt ------------------------------------------

// System prompt for the background "observer" that watches a chat and
// updates the persistent style notes. Called from
// processing.ts → refreshChatMemory.
export const MEMORY_REFRESH_SYSTEM_PROMPT = `Ты — наблюдатель за стилем общения в Telegram-чате. Твоя задача — поддерживать живые заметки о том, как именно общаются в этом чате, чтобы потом другая модель могла писать summary в этом же стиле.

У тебя на входе:
  1. Текущие заметки о чате (могут быть пустыми, если ты видишь чат впервые)
  2. Свежий лог последних сообщений в этом чате

Твоя задача — обновить заметки. Сохрани то, что всё ещё актуально, уточни наблюдения, добавь новое. Не повторяй одно и то же дважды. Стирай устаревшее.

Заметки должны охватывать:
  - Регистр (формальный / неформальный / полу-литературный / разговорный)
  - Тон (серьёзный / ироничный / мемный / тёплый / агрессивный / усталый / любой)
  - Уровень мата и обсценной лексики (нет / мягко / средне / много — приведи пару примеров если есть)
  - Особенности словаря: любимые словечки, мемы, локальные термины, прозвища, обращения друг к другу
  - Кто участники чата и как они между собой общаются (роли, динамики)
  - Темы, к которым чат регулярно возвращается
  - Юмор: какой, как часто, какие шутки любят
  - Любые другие наблюдения, которые помогут писать в стиле этого чата

Заметки — это рабочий инструмент, не публикация. Пиши коротко и по делу, маркированными пунктами или короткими абзацами. Не больше 2000 символов всего.

Отвечай ТОЛЬКО обновлёнными заметками, без вступлений, без заголовка, без пояснений что ты обновил. Просто новые заметки.`;

// ---- Filter agent ---------------------------------------------------------

// Smart LLM-based filter agent for /summary. Always one chat-completion
// call. The agent receives the user's free-form query AND a compact list
// of recent chat messages (with their IDs), so it can choose between four
// strategies on its own:
//
//   1. RANGE — pure time / user filter, no semantic content needed
//   2. ALL   — bring in everything available
//   3. IDS   — semantic pick: return the specific message_ids that match
//   4. ERROR — only when the user typed actual gibberish
//
// This is intentionally one prompt with mode discrimination so the agent
// can pick the cheapest/clearest option for each query.
export function buildFilterAgentSystemPrompt(
  nowSec: number,
  tzOffsetMinutes = 180,
): string {
  const nowIso = new Date(nowSec * 1000).toISOString();
  return `Ты — фильтр-агент для команды /summary в Telegram-боте, который суммирует переписки в групповых чатах.

На вход тебе дают:
  1. Естественный запрос пользователя (что он хочет суммаризировать)
  2. Список последних сообщений из чата с метаданными (id, время, отправитель, начало текста)
  3. Текущее время

Твоя задача — выбрать сообщения, которые надо включить в summary. У тебя есть четыре способа ответа.

ВАРИАНТ A — диапазон по времени.
Используй когда запрос про время и/или конкретного пользователя БЕЗ семантики.
Примеры: "последний день", "за неделю", "от @acex", "вчера", "последние 50 сообщений", "за этот месяц".
Формат: {"kind":"range","start_ts":<unix>,"end_ts":<unix>,"from_username":"<имя_без_@_или_null>","description":"человеко-читаемая фраза"}

ВАРИАНТ B — всё что есть.
Используй когда запрос явно про всё.
Примеры: "всё", "весь чат", "сколько сможешь дотянуться", "everything", "from the start", "максимально".
Формат: {"kind":"all","description":"все доступные сообщения"}

ВАРИАНТ C — выбор по смыслу (semantic vector search).
Используй когда запрос про КОНКРЕТНУЮ ТЕМУ, событие или содержание сообщений.
Примеры: "про дедлайны", "обсуждение нового дизайна", "сообщения где Иван спорит с Анной", "разговор про чай", "что говорили про деплой", "идеи для презентации".
Сформулируй короткий поисковый запрос, который лучше всего найдёт эту тему в embeddings по истории чата.
Формат: {"kind":"semantic","query":"поисковая фраза","description":"что именно надо найти"}

ВАРИАНТ D — ошибка.
Используй ТОЛЬКО если запрос — настоящая бессмыслица (рандомные символы, пустота, нечитаемая каша).
Любой осмысленный запрос обрабатывай через A/B/C, не через ошибку.
Формат: {"kind":"error","description":"что не понятно"}

Правила резолва времени для варианта A:
  - «последний день» / «за день» — последние 24 часа
  - «вчера» — вчерашние календарные сутки
  - «эта неделя» — с начала текущего понедельника до сейчас
  - «прошлая неделя» — прошлая календарная неделя
  - «этот месяц» — с 1-го числа текущего месяца
  - «последние N часов/минут/дней» — относительно текущего момента
  - end_ts всегда ≤ текущего unix timestamp

Текущее серверное время (UTC): ${nowIso}
Текущий unix timestamp: ${nowSec}
Часовой пояс пользователя по умолчанию: UTC+${tzOffsetMinutes / 60}

Отвечай СТРОГО одним JSON-объектом, без markdown кодблоков, без вступлений.
Если запрос пустой или общий — выбирай ALL.`;
}

export type FilterDecision =
  | {
      kind: "range";
      startTs: number;
      endTs: number;
      fromUsername: string | null;
      description: string;
    }
  | { kind: "all"; description: string }
  | { kind: "semantic"; query: string; description: string }
  | { kind: "ids"; messageIds: number[]; description: string }
  | { kind: "error"; description: string };

// Robust parser. Tolerates extra fields, stringified numbers, and the
// agent ocasionally drifting back to the old "range-only" shape (we
// detect that and treat it as a range).
export function parseFilterResponse(
  raw: string,
  nowSec: number,
): FilterDecision {
  const fallback: FilterDecision = {
    kind: "range",
    startTs: nowSec - 86400,
    endTs: nowSec,
    fromUsername: null,
    description: "последние 24 часа",
  };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const kind = typeof parsed.kind === "string" ? parsed.kind : "";
    if (kind === "range" || (parsed.start_ts !== undefined && !kind)) {
      const start = Number(parsed.start_ts);
      const end = Number(parsed.end_ts);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return fallback;
      return {
        kind: "range",
        startTs: Math.max(0, Math.floor(start)),
        endTs: Math.floor(Math.min(end, nowSec)),
        fromUsername:
          typeof parsed.from_username === "string" && parsed.from_username
            ? (parsed.from_username as string).replace(/^@/, "")
            : null,
        description:
          typeof parsed.description === "string" &&
          parsed.description.length > 0
            ? (parsed.description as string)
            : "выбранный диапазон",
      };
    }
    if (kind === "all") {
      return {
        kind: "all",
        description:
          typeof parsed.description === "string" &&
          parsed.description.length > 0
            ? (parsed.description as string)
            : "все доступные сообщения",
      };
    }
    if (kind === "ids" && Array.isArray(parsed.message_ids)) {
      const ids = (parsed.message_ids as unknown[])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n));
      return {
        kind: "ids",
        messageIds: ids,
        description:
          typeof parsed.description === "string" &&
          parsed.description.length > 0
            ? (parsed.description as string)
            : "выбранные сообщения",
      };
    }
    if (kind === "semantic") {
      const query =
        typeof parsed.query === "string" && parsed.query.trim().length > 0
          ? parsed.query.trim()
          : "";
      if (!query) return fallback;
      return {
        kind: "semantic",
        query,
        description:
          typeof parsed.description === "string" &&
          parsed.description.length > 0
            ? (parsed.description as string)
            : query,
      };
    }
    if (kind === "error") {
      return {
        kind: "error",
        description:
          typeof parsed.description === "string" &&
          parsed.description.length > 0
            ? (parsed.description as string)
            : "не понял запрос",
      };
    }
  } catch {
    // fall through
  }
  return fallback;
}

// ---- Voice nonsense filter -----------------------------------------------

export const VOICE_NONSENSE_SYSTEM_PROMPT = `Ты — мини-агент фильтрации расшифровок голосовых сообщений.

Тебе дают текст, который вернул speech-to-text. Нужно решить, стоит ли вообще пытаться делать summary.

Верни should_ignore=true только если расшифровка явно не содержит осмысленного сообщения:
  - случайные символы, набор слогов или нечитаемая каша;
  - почти одни междометия/молчание/звуки без намерения;
  - очевидная галлюцинация распознавания без связи с реальной речью;
  - фраза настолько пустая, что из неё нельзя восстановить намерение автора.

Будь консервативен. Короткие, грубые, эмоциональные, неполные или бытовые сообщения НЕ являются мусором, если в них есть понятное намерение.
Примеры НЕ мусора: «да, договорились», «я скоро буду», «не понял, повтори», «скинь ссылку», «это фигня какая-то».

Отвечай СТРОГО JSON-объектом:
{"should_ignore": false, "reason": "короткая причина"}`;

export interface VoiceNonsenseDecision {
  shouldIgnore: boolean;
  reason: string;
}

export function parseVoiceNonsenseResponse(raw: string): VoiceNonsenseDecision {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      shouldIgnore: parsed.should_ignore === true,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim().length > 0
          ? parsed.reason.trim().slice(0, 300)
          : "без причины",
    };
  } catch {
    return { shouldIgnore: false, reason: "не удалось распарсить ответ" };
  }
}

// ---- Router ---------------------------------------------------------------

// The router is only consulted when either mode or context is "auto". It
// picks concrete values from the catalogs above. It is NOT allowed to
// return "auto".
export const ROUTER_SYSTEM_PROMPT = (() => {
  const modesList = Object.values(MODES)
    .map((m) => `  - ${m.key}: ${m.description}`)
    .join("\n");
  const contextsList = Object.values(CONTEXTS)
    .map((c) => `  - ${c.key}: ${c.description}`)
    .join("\n");
  return `Ты роутер для системы суммаризации голосовых сообщений.
Тебе дана расшифровка, и твоя задача — выбрать лучший стиль (mode) и контекст (context), чтобы summary максимально точно отражал это сообщение.

Доступные стили (mode):
${modesList}

Доступные контексты (context):
${contextsList}

Отвечай СТРОГО в JSON формате: {"mode": "<key>", "context": "<key>"}.
Используй только ключи из списков выше — не придумывай новые.
Никогда не возвращай "auto".`;
})();

// Parses a router response. Returns a safe default if the response is
// garbage — we prefer an ok-ish answer over a hard failure.
export function parseRouterResponse(raw: string): {
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
} {
  try {
    const parsed = JSON.parse(raw) as { mode?: string; context?: string };
    const mode =
      parsed.mode && parsed.mode in MODES
        ? (parsed.mode as Exclude<ModeKey, "auto">)
        : "brief";
    const context =
      parsed.context && parsed.context in CONTEXTS
        ? (parsed.context as Exclude<ContextKey, "auto">)
        : "thinkingOutLoud";
    return { mode, context };
  } catch {
    return { mode: "brief", context: "thinkingOutLoud" };
  }
}

// ---- Chat defaults --------------------------------------------------------

export const DEFAULT_CHAT_MODE: ModeKey = "auto";
export const DEFAULT_CHAT_CONTEXT: ContextKey = "auto";
export const DEFAULT_CHAT_DETAIL: Detail = 1;

// ---- Enumerations for UI iteration ----------------------------------------

export const ALL_MODE_KEYS: ModeKey[] = [
  "auto",
  "bulletPoints",
  "brief",
  "cleanText",
  "structured",
  "sections",
  "actionItems",
  "keyPoints",
];

export const ALL_CONTEXT_KEYS: ContextKey[] = [
  "auto",
  "storytelling",
  "thinkingOutLoud",
  "instruction",
  "report",
  "discussion",
  "emotional",
  "plan",
];

export const ALL_DETAILS: Detail[] = [1, 2, 3];

// Strict validators — used at the API boundary where we receive untyped
// strings from callback_data or user commands.
export function isModeKey(s: string): s is ModeKey {
  return (ALL_MODE_KEYS as string[]).includes(s);
}
export function isContextKey(s: string): s is ContextKey {
  return (ALL_CONTEXT_KEYS as string[]).includes(s);
}
export function isDetail(n: number): n is Detail {
  return n === 1 || n === 2 || n === 3;
}
