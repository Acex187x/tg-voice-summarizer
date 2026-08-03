// Single source of truth for which LLM models the bot uses for each
// stage. To swap a model, edit this file and redeploy with `npx convex
// dev --once`. There is no admin UI and nothing in the database — that
// was an unnecessary knob and gets in the way.
//
// Three stages, three knobs:
//
//   TRANSCRIBE — audio → text. OpenAI only (Whisper or gpt-4o-transcribe);
//                no provider field, transcription always goes to OpenAI.
//
//   CLASSIFY   — used by:
//                  • the auto-router (mode/context resolution)
//                  • the /summary filter agent (range/all/ids/error)
//                Both are short JSON-mode calls, so a small fast model
//                is the right default here.
//
//   SUMMARIZE  — used for the actual summary text generation. This is the
//                heavy stage; pick whatever model produces the best
//                summaries for your taste/budget.

export type LlmProvider = "openai" | "openrouter";

// ---- Stage 1: transcription ----
export const TRANSCRIBE_MODEL = "whisper-1";

// ---- Stage 2: classifier (router + filter agent) ----
export const CLASSIFY_PROVIDER: LlmProvider = "openrouter";
export const CLASSIFY_MODEL = "x-ai/grok-4.3";

// ---- Stage 3: summarizer ----
// The summarizer is switchable per chat via the /modal command in the
// group. The catalog below is the full set of options; the per-chat pick
// is stored in chatSettings.summarizeModel (by KEY, so a model id bump
// here upgrades every chat automatically).
export const SUMMARIZE_PROVIDER: LlmProvider = "openrouter";

export const SUMMARIZE_MODEL_OPTIONS = {
  gemini: { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  grok: { id: "x-ai/grok-4.5", label: "Grok 4.5" },
} as const;
export type SummarizeModelKey = keyof typeof SUMMARIZE_MODEL_OPTIONS;
export const DEFAULT_SUMMARIZE_MODEL_KEY: SummarizeModelKey = "gemini";

export function isSummarizeModelKey(s: string): s is SummarizeModelKey {
  return s in SUMMARIZE_MODEL_OPTIONS;
}
export function summarizeModelId(key: SummarizeModelKey): string {
  return SUMMARIZE_MODEL_OPTIONS[key].id;
}

// Default model id — used when a chat has no explicit pick and by legacy
// call sites that don't thread a per-chat model through.
export const SUMMARIZE_MODEL =
  SUMMARIZE_MODEL_OPTIONS[DEFAULT_SUMMARIZE_MODEL_KEY].id;

// ---- Stage 4: embeddings (semantic search) ----
// OpenAI only. Convex vector indexes need a fixed dimensionality in schema.
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_VERSION = 1;
