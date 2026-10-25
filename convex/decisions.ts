// Client for the OpenAI Decisions API (POST /v1/decisions, GPT-6 Luna).
//
// The Decisions API answers a fixed set of questions about one input with
// typed, probabilistic answers instead of generated text: a probability for
// a yes/no predicate, or a distribution over the choices we define. That's
// exactly the shape of the voice router (pick a mode, pick a context, is
// this real speech) — no JSON-mode prompt to babysit and no parser to
// harden against free-form drift.

import { DECISIONS_MODEL } from "./models";

const OPENAI_BASE = "https://api.openai.com/v1";

export interface DecisionChoice {
  value: string;
  description: string;
}

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | {
      type: "choice";
      name: string;
      instructions: string;
      choices: DecisionChoice[];
    };

export interface PredicateAnswer {
  type: "predicate";
  name: string;
  probability: number;
}

export interface ChoiceAnswer {
  type: "choice";
  name: string;
  choice: string;
  probabilities: Array<{ value: string; probability: number }>;
  confidence: number;
}

export interface RefusalAnswer {
  type: "refusal";
  name: string;
}

export type DecisionAnswer = PredicateAnswer | ChoiceAnswer | RefusalAnswer;

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
}

// One retry on transient failures. The router sits on the hot path of
// every voice, so a hard failure here falls back to deterministic defaults
// in the caller rather than failing the whole pipeline.
const DECISIONS_TIMEOUT_MS = 15_000;

export async function decide(
  input: string,
  questions: DecisionQuestion[],
): Promise<DecisionResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in Convex env");

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${OPENAI_BASE}/decisions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: DECISIONS_MODEL, input, questions }),
        signal: AbortSignal.timeout(DECISIONS_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(
          `Decisions API failed (model=${DECISIONS_MODEL}): ${res.status} ${body.slice(0, 300)}`,
        );
        // 4xx other than 429 won't get better on retry.
        if (res.status < 500 && res.status !== 429) throw err;
        lastError = err;
        continue;
      }
      const json = (await res.json()) as {
        answers?: DecisionAnswer[];
        usage?: { input_tokens?: number };
      };
      const answers: Record<string, DecisionAnswer> = {};
      for (const a of json.answers ?? []) answers[a.name] = a;
      return { answers, inputTokens: json.usage?.input_tokens ?? 0 };
    } catch (err) {
      lastError = err;
      if (
        err instanceof Error &&
        err.message.startsWith("Decisions API failed") &&
        !/: (429|5\d\d) /.test(err.message)
      ) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Decisions API failed: ${String(lastError)}`);
}

export function predicate(
  result: DecisionResult,
  name: string,
): number | null {
  const a = result.answers[name];
  return a?.type === "predicate" ? a.probability : null;
}

export function choice(
  result: DecisionResult,
  name: string,
): { value: string; confidence: number } | null {
  const a = result.answers[name];
  return a?.type === "choice"
    ? { value: a.choice, confidence: a.confidence }
    : null;
}
