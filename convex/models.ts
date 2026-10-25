// Single source of truth for which LLM models the bot uses for each
// stage. To swap a model, edit this file and redeploy with `npx convex
// dev --once`. There is no admin UI and nothing in the database — that
// was an unnecessary knob and gets in the way.
//
// Three stages, three knobs:
//
//   TRANSCRIBE — audio → text. OpenAI only; no provider field.
//
//   DECISIONS  — the voice router + noise filter. OpenAI Decisions API
//                (GPT-6 Luna): typed answers to fixed questions, no JSON
//                prompt to parse.
//
//   CLASSIFY   — remaining short chat calls: the /summary filter agent,
//                Q&A, the legacy JSON router fallback.
//
//   SUMMARIZE  — used for the actual summary text generation. This is the
//                heavy stage; pick whatever model produces the best
//                summaries for your taste/budget.

export type LlmProvider = "openai" | "openrouter";

// ---- Stage 1: transcription ----
// gpt-transcribe is more accurate and returns an empty text on silence
// instead of Whisper's "Thank you for watching." — but it has no
// timestamps. Long voices need segment timecodes for the sections mode,
// so they still go through whisper-1 (verbose_json). whisper-1 is also
// the fallback when gpt-transcribe errors.
export const TRANSCRIBE_MODEL = "gpt-transcribe";
export const TRANSCRIBE_TIMESTAMPS_MODEL = "whisper-1";
// Free-form context for gpt-transcribe (its `prompt` field).
export const TRANSCRIBE_PROMPT =
  "Голосовое сообщение из Telegram. Разговорная речь, чаще на русском или украинском, бывает суржик, сленг, мат и английские IT-термины.";

// ---- Stage 2: router + noise filter ----
export const DECISIONS_MODEL = "gpt-6-luna";

// ---- Stage 2b: other short chat calls ----
export const CLASSIFY_PROVIDER: LlmProvider = "openrouter";
export const CLASSIFY_MODEL = "openai/gpt-6-luna";

// ---- Stage 3: summarizer ----
// The summarizer is switchable per chat via the /modal command in the
// group. The catalog below is the full set of options; the per-chat pick
// is stored in chatSettings.summarizeModel (by KEY, so a model id bump
// here upgrades every chat automatically).
export const SUMMARIZE_PROVIDER: LlmProvider = "openrouter";

export const SUMMARIZE_MODEL_OPTIONS = {
  luna: { id: "openai/gpt-6-luna", label: "GPT-6 Luna" },
  gemini: { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  grok: { id: "x-ai/grok-4.7", label: "Grok 4.7" },
} as const;
export type SummarizeModelKey = keyof typeof SUMMARIZE_MODEL_OPTIONS;
export const DEFAULT_SUMMARIZE_MODEL_KEY: SummarizeModelKey = "luna";

export function isSummarizeModelKey(s: string): s is SummarizeModelKey {
  return s in SUMMARIZE_MODEL_OPTIONS;
}
export function summarizeModelId(key: SummarizeModelKey): string {
  return SUMMARIZE_MODEL_OPTIONS[key].id;
}

// Long voices (sections mode) always go to Grok: the eval scored it 4.2 vs
// 3.3 on per-topic fidelity, and a 10-minute voice can afford the extra
// latency (Grok's median is ~2.5x slower than Gemini's).
export const SECTIONS_MODEL_KEY: SummarizeModelKey = "grok";

// Default model id — used when a chat has no explicit pick and by legacy
// call sites that don't thread a per-chat model through.
export const SUMMARIZE_MODEL =
  SUMMARIZE_MODEL_OPTIONS[DEFAULT_SUMMARIZE_MODEL_KEY].id;

// ---- Stage 4: embeddings (semantic search) ----
// OpenAI only. Convex vector indexes need a fixed dimensionality in schema.
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_VERSION = 1;
