// Pure decision logic for the voice pipeline: what counts as noise, how
// informal a chat is, which router questions to ask and how to turn the
// answers into a concrete mode. No Convex or network imports — the
// offline eval harness (scripts/eval) runs exactly this code.

import type { DecisionQuestion, DecisionResult } from "./decisions";
import { choice, predicate } from "./decisions";
import {
  type Audience,
  buildShortVoiceCleanTextPrompt,
  buildSummaryPrompt,
  buildSummaryUserMessage,
  CONTEXTS,
  type Detail,
  formatTimecode,
  formatTimestampedTranscript,
  shortCleanupKeepsProfanity,
  type SummaryExtras,
  type TimedSegment,
  LONG_VOICE_SECTIONS_MIN_SEC,
  MODES,
  SPEECH_ACTS,
  type ContextKey,
  type ModeKey,
  type SpeechActKey,
} from "./prompts";

// ---- ASR noise ------------------------------------------------------------

// Whisper-family models hallucinate a small, very stable set of phrases on
// silence, music and room noise — mostly subtitle credits from their
// training data. A silent video note reliably comes back as "Thank you for
// watching." These never carry a message, so they're filtered without
// asking any model.
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^(thank you|thanks)( so much| very much)?( for watching| for listening)?( (the|this|my|our) video)?$/,
  /^(bye|bye bye|goodbye|you|oh|uh|um|hmm|ah|mm)$/,
  /^(please )?(subscribe|like and subscribe)( to (my|the|our) channel)?$/,
  /^(see you|see you next time|see you in the next video)$/,
  /^продолжение следует$/,
  /^(спасибо|дякую) за (просмотр|перегляд|внимание|увагу)$/,
  /^субтитры .*$/,
  /^редактор субтитров.*$/,
  /^корректор .*$/,
  /^(подписывайтесь|підписуйтесь) на (канал|наш канал)$/,
  /^sottotitoli .*amara.*$/,
  /^.*amara\.?org.*$/,
  /^ご視聴ありがとうございました$/,
  // CJK "thanks for watching / subscribe" credits.
  /(視聴|ご覧|チャンネル登録|시청|구독|收睇|收看|觀看|订阅|訂閱)/,
  /^(музыка|динамичная музыка|спокойная музыка|music|music outro|аплодисменты|смех)$/,
  /^add the content$/,
];

// Credits that never occur in a real chat voice. If one shows up in a
// short transcript, the rest is noise too ("Thank you so much for
// watching. Always be happy.").
const STRONG_CREDITS_RE =
  /(for watching|share this video|like the video|subscribe to|subscribe and|amara|subtitles by|субтитр|дякую за перегляд|спасибо за просмотр|продолжение следует|視聴|ご覧|チャンネル登録|시청|收睇|otter\.ai|transcribed by)/i;

// Lowercased, punctuation/emoji-stripped form used for pattern matching.
function normalizeForNoise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}♪]/gu, " ")
    .replace(/[^\p{L}\p{N}\s.]/gu, " ")
    .replace(/\.(?!org)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits on sentence punctuation so "Bye. Bye." or "Thank you. Bye." are
// recognised as hallucination-only too.
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map(normalizeForNoise)
    .filter((s) => s.length > 0);
}

function isHallucinationSentence(s: string): boolean {
  return HALLUCINATION_PATTERNS.some((re) => re.test(s));
}

// Returns a short reason when the transcript is certainly ASR noise, or
// null when it might be a real message (the model filter decides then).
export function detectAsrNoise(transcript: string): string | null {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return "пустая расшифровка";
  const letters = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (letters === 0) return "в расшифровке нет слов (эмодзи/символы)";
  const parts = sentences(trimmed);
  if (parts.length > 0 && parts.every(isHallucinationSentence)) {
    return "типичная галлюцинация распознавания на тишине";
  }
  if (trimmed.length <= 100 && STRONG_CREDITS_RE.test(trimmed)) {
    return "титры/«спасибо за просмотр» — галлюцинация распознавания";
  }
  // "Кс-кс-кс-кс" / "а-а-а-а": one syllable repeated with nothing else.
  const tokens = normalizeForNoise(trimmed).split(/[\s-]+/).filter(Boolean);
  if (tokens.length >= 3 && new Set(tokens).size === 1 && tokens[0].length <= 3) {
    return "повтор одного слога без смысла";
  }
  return null;
}

// Hallucinated credits also get glued onto the END of real voices
// ("…короче, вот так. Дякую за перегляд!"). Drop such trailing sentences
// so they don't leak into the summary.
export function stripAsrTail(transcript: string): string {
  const parts = transcript.trim().split(/(?<=[.!?…])\s+/);
  while (parts.length > 1 && isHallucinationSentence(normalizeForNoise(parts[parts.length - 1]))) {
    parts.pop();
  }
  return parts.join(" ");
}

// Probability threshold on the router's `is_noise` predicate. Kept high:
// a wrongly dropped real voice is worse than one extra junk reply.
// Calibrated on 140 stored transcripts: real ru/uk speech scored ≤ 0.4,
// hallucinations the rules missed scored 0.6–1.0.
export const NOISE_PROBABILITY_THRESHOLD = 0.8;

// ---- Router ---------------------------------------------------------------

export interface RouterInput {
  transcript: string;
  durationSec?: number | null;
  mediaKind?: string | null;
  replyContext?: string | null;
  audience: Audience;
}

// Modes the router may pick. "sections" is duration-driven, never routed.
const ROUTABLE_MODES: Exclude<ModeKey, "auto" | "sections">[] = [
  "cleanText",
  "brief",
  "bulletPoints",
  "keyPoints",
  "structured",
  "actionItems",
];

const MODE_ROUTER_HINTS: Record<(typeof ROUTABLE_MODES)[number], string> = {
  cleanText:
    "Короткая реплика или сообщение, которое лучше всего просто переписать текстом от лица автора (ответ, просьба, вопрос, короткая мысль). Выбирай для большинства войсов короче минуты.",
  brief:
    "Связный пересказ в 2–4 предложениях: история, вент, мнение, объяснение, обсуждение одной темы средней длины.",
  bulletPoints:
    "Несколько разрозненных фактов или мыслей примерно одного веса, которые удобно читать списком. Только если в войсе действительно 4+ отдельных пункта.",
  keyPoints:
    "Длинное рассуждение (обычно больше полутора минут) с 3+ самостоятельными тезисами, которые можно ранжировать.",
  structured:
    "Длинное сообщение с 2–4 явно разными темами, каждой из которых нужен свой подзаголовок.",
  actionItems:
    "Войс, основная цель которого — раздать или зафиксировать 2+ конкретные задачи/поручения/дедлайны (планёрка, список дел). НЕ выбирай для жалоб, мнений и разговоров, где задачи упомянуты вскользь.",
};

export function buildRouterInput(r: RouterInput): string {
  const meta: string[] = [];
  if (r.mediaKind) meta.push(`Тип: ${r.mediaKind === "video_note" ? "видеокружок" : r.mediaKind === "audio" ? "аудиофайл" : "голосовое"}`);
  if (r.durationSec) meta.push(`Длительность: ${Math.round(r.durationSec)} с`);
  meta.push(`Символов в расшифровке: ${r.transcript.length}`);
  const where: Record<Audience, string> = {
    group: "групповой чат",
    businessIncoming: "личная переписка, войс прислал собеседник владельцу",
    businessOutgoing: "личная переписка, войс записал сам владелец собеседнику",
    botDm: "личка с ботом",
    guest: "чат, куда бота позвали упоминанием",
  };
  meta.push(`Где: ${where[r.audience]}`);
  const reply = r.replyContext
    ? `\nКонтекст (на что отвечает войс, только для понимания):\n${r.replyContext}\n`
    : "";
  return `${meta.join(" · ")}\n${reply}\nРасшифровка (speech-to-text, возможны ошибки распознавания):\n"""\n${r.transcript}\n"""`;
}

export function buildRouterQuestions(): DecisionQuestion[] {
  return [
    {
      type: "predicate",
      name: "is_noise",
      instructions:
        "Верно ли, что в расшифровке НЕТ осмысленного сообщения от человека? Да — если это галлюцинация распознавания на тишине или музыке (титры, «спасибо за просмотр», фраза на чужом для чата языке на коротком беззвучном кружке), бессвязная каша из слогов, одни междометия или звуки. Нет — если есть хоть какое-то понятное намерение, даже короткое, грубое или обрывочное («да», «скинь ссылку», «ахахах это пиздец», ругань, пение со словами).",
    },
    {
      type: "choice",
      name: "mode",
      instructions:
        "Какой формат summary лучше всего передаст суть этого войса читателю, который не хочет его слушать? Учитывай длительность: дробящие форматы (списки, тезисы, задачи) для коротких реплик почти всегда хуже простого текста.",
      choices: ROUTABLE_MODES.map((key) => ({
        value: key,
        description: MODE_ROUTER_HINTS[key],
      })),
    },
    {
      type: "choice",
      name: "context",
      instructions: "Что это за сообщение по сути?",
      choices: Object.values(CONTEXTS).map((c) => ({
        value: c.key,
        description: c.description,
      })),
    },
    {
      type: "choice",
      name: "speech_act",
      instructions:
        "Какое главное намерение у автора войса по отношению к слушателям?",
      choices: Object.values(SPEECH_ACTS).map((s) => ({
        value: s.key,
        description: s.description,
      })),
    },
    {
      type: "predicate",
      name: "has_tasks",
      instructions:
        "Содержит ли войс как минимум две конкретные задачи, поручения или обязательства (кто-то должен что-то сделать), а не просто упоминание дел или жалобу?",
    },
  ];
}

export interface RoutedVoice {
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  speechAct: SpeechActKey;
  noiseProbability: number;
}

// Safety net on top of the router: the eval showed actionItems/keyPoints
// on 20–60 second replies were the worst-rated outputs (one thought split
// into "theses", invented "open questions"). Gate them on hard facts the
// router can't hallucinate.
export function gateMode(
  mode: Exclude<ModeKey, "auto">,
  facts: {
    durationSec?: number | null;
    transcriptLength: number;
    hasTasksProbability?: number | null;
  },
): Exclude<ModeKey, "auto"> {
  const dur = facts.durationSec ?? 0;
  const len = facts.transcriptLength;
  if (mode === "actionItems" && (facts.hasTasksProbability ?? 0) < 0.6) {
    return len > 1200 ? "keyPoints" : "brief";
  }
  if (mode === "keyPoints" && dur < 75 && len < 900) return "brief";
  if (mode === "bulletPoints" && dur < 45 && len < 600) return "brief";
  if (mode === "structured" && len < 1200) return "brief";
  return mode;
}

export function interpretRouterAnswers(
  result: DecisionResult,
  facts: { durationSec?: number | null; transcriptLength: number },
): RoutedVoice {
  const rawMode = choice(result, "mode")?.value;
  const rawContext = choice(result, "context")?.value;
  const rawAct = choice(result, "speech_act")?.value;
  const mode =
    rawMode && rawMode in MODES
      ? (rawMode as Exclude<ModeKey, "auto">)
      : "brief";
  const context =
    rawContext && rawContext in CONTEXTS
      ? (rawContext as Exclude<ContextKey, "auto">)
      : "thinkingOutLoud";
  const speechAct =
    rawAct && rawAct in SPEECH_ACTS ? (rawAct as SpeechActKey) : "inform";
  return {
    mode: gateMode(mode, {
      ...facts,
      hasTasksProbability: predicate(result, "has_tasks"),
    }),
    context,
    speechAct,
    noiseProbability: predicate(result, "is_noise") ?? 0,
  };
}

export function isLongVoice(durationSec?: number | null): boolean {
  return (durationSec ?? 0) >= LONG_VOICE_SECTIONS_MIN_SEC;
}

// ---- Chat-log router (for /summary) ---------------------------------------

export function buildChatLogRouterQuestions(): DecisionQuestion[] {
  return [
    {
      type: "choice",
      name: "mode",
      instructions:
        "Какой формат summary лучше всего передаст суть этой переписки читателю, который её пропустил?",
      choices: (["brief", "bulletPoints", "keyPoints", "structured", "actionItems"] as const).map(
        (key) => ({ value: key, description: MODES[key].description }),
      ),
    },
    {
      type: "choice",
      name: "context",
      instructions: "Что это за переписка по сути?",
      choices: Object.values(CONTEXTS).map((c) => ({
        value: c.key,
        description: c.description,
      })),
    },
  ];
}

// ---- Mode resolution ------------------------------------------------------

// Short transcripts are rewritten, not summarized (the best-rated path).
const SHORT_TRANSCRIPT_CLEAN_TEXT_MAX_CHARS = 320;

export function isShortTranscript(text: string): boolean {
  const len = Array.from(text.replace(/\s+/g, " ").trim()).length;
  return len > 0 && len <= SHORT_TRANSCRIPT_CLEAN_TEXT_MAX_CHARS;
}

// What "auto" resolves to for a voice. Hard rules first: short → cleanup,
// long → sections, the owner's outgoing business voice → first-person
// clean text (it may be delivered to the peer in his name); otherwise the
// router's (already gated) pick.
export function resolveAuto(args: {
  short: boolean;
  long: boolean;
  audience: Audience;
  routed: RoutedVoice | null;
}): {
  autoMode: Exclude<ModeKey, "auto">;
  autoContext: Exclude<ContextKey, "auto">;
} {
  const autoMode: Exclude<ModeKey, "auto"> = args.short
    ? "cleanText"
    : args.long
      ? "sections"
      : args.audience === "businessOutgoing"
        ? "cleanText"
        : (args.routed?.mode ?? "brief");
  return {
    autoMode,
    autoContext: args.routed?.context ?? "thinkingOutLoud",
  };
}

// The voice row fields that decide who reads the summary.
export interface AudienceFacts {
  chatId?: number;
  businessConnectionId?: string;
  businessOutgoing?: boolean;
  ackMessageId?: number;
  delivery?: string;
}

export function voiceAudience(voice: AudienceFacts): Audience {
  if (voice.businessConnectionId) {
    return voice.businessOutgoing ? "businessOutgoing" : "businessIncoming";
  }
  // Pipeline voices get a placeholder or a delivery plan; guest-mode
  // summons never do.
  const viaPipeline =
    voice.ackMessageId !== undefined || voice.delivery !== undefined;
  if ((voice.chatId ?? 0) > 0) return viaPipeline ? "botDm" : "guest";
  return viaPipeline ? "group" : "guest";
}

// "Ilya @Acex187x" → "Ilya".
export function firstName(name: string | null | undefined): string | null {
  const n = name?.replace(/@\w+/g, "").trim();
  return n ? n.split(/\s+/)[0] : null;
}

// ---- Summary request ------------------------------------------------------

export interface VoiceSummaryArgs {
  transcript: string;
  segments?: TimedSegment[] | null;
  durationSec?: number | null;
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
  chatStyleNotes?: string | null;
  chatLore?: string | null;
}

// System + user messages for one summary call. Shared by the Convex
// pipeline and the offline eval so both run the exact same prompt.
export function buildVoiceSummaryRequest(
  args: VoiceSummaryArgs,
  extras: SummaryExtras,
): { system: string; user: string; temperature: number; shortCleanup: boolean } {
  const shortCleanup =
    args.mode === "cleanText" && isShortTranscript(args.transcript);
  const system = shortCleanup
    ? buildShortVoiceCleanTextPrompt({
        keepProfanity: shortCleanupKeepsProfanity(
          args.chatStyleNotes ?? null,
          args.transcript,
        ),
      })
    : buildSummaryPrompt(
        args.mode,
        args.context,
        args.detail,
        args.chatStyleNotes ?? null,
        args.chatLore ?? null,
        extras,
        args.transcript,
      );
  // The sections mode needs timestamps to anchor topics to; other modes
  // get the plain transcript (timestamps would only burn tokens there).
  const useTimestamps =
    args.mode === "sections" && (args.segments?.length ?? 0) > 0;
  const transcriptBlock = useTimestamps
    ? formatTimestampedTranscript(args.segments!)
    : args.transcript;
  const durationLine =
    useTimestamps && args.durationSec
      ? `Длительность аудио: ${formatTimecode(args.durationSec)}\n`
      : "";
  return {
    system,
    user: buildSummaryUserMessage(transcriptBlock, {
      durationLine,
      // The short cleanup only rewrites the words; context can't help it.
      replyContext: shortCleanup ? null : extras.replyContext,
    }),
    temperature: shortCleanup ? 0.2 : 0.4,
    shortCleanup,
  };
}
