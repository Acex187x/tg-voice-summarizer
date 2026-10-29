// Offline eval for the voice pipeline. Runs the SAME router, noise filter
// and prompt builder as convex/processing.ts on a dataset of stored
// transcripts, against real APIs, and writes the outputs for judging.
//
//   npm run eval:voice -- summaries <dataset.json> <out.json> [gemini,grok]
//   npm run eval:voice -- noise <noise.json> <out.json>
//
// Needs OPENAI_API_KEY (Decisions API) and OPENROUTER_API_KEY in env.
// Datasets come from a Convex export and are NOT checked in.

import { readFileSync, writeFileSync } from "node:fs";
import { decide } from "../../convex/decisions";
import {
  SUMMARIZE_MODEL_OPTIONS,
  SUMMARIZE_PROVIDER,
  type SummarizeModelKey,
} from "../../convex/models";
import { chatComplete } from "../../convex/openai";
import type { Detail } from "../../convex/prompts";
import {
  buildRouterInput,
  buildRouterQuestions,
  buildVoiceSummaryRequest,
  detectAsrNoise,
  firstName,
  interpretRouterAnswers,
  isFilterQuestion,
  isLongVoice,
  isShortTranscript,
  MUSIC_PROBABILITY_THRESHOLD,
  NOISE_PROBABILITY_THRESHOLD,
  resolveAuto,
  stripAsrTail,
  stripUnwantedAsides,
  voiceAudience,
} from "../../convex/voicePolicy";

interface EvalItem {
  id: string;
  chatId: number;
  fromName?: string | null;
  nickname?: string | null;
  businessConnectionId?: string;
  businessOutgoing?: boolean;
  peerName?: string | null;
  ackMessageId?: number;
  delivery?: string;
  mediaKind?: string | null;
  audioTrack?: string | null;
  durationSec?: number | null;
  transcript: string;
  segments?: Array<{ start: number; end: number; text: string }> | null;
  chatStyleNotes?: string | null;
  replyContext?: string | null;
  detail?: number;
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function route(item: EvalItem, transcript: string) {
  const short = isShortTranscript(transcript);
  const long = isLongVoice(item.durationSec);
  const audience = voiceAudience(item);
  const needsRouting = !short;
  const questions = buildRouterQuestions({
    audioFile: item.mediaKind === "audio",
  }).filter((q) => needsRouting || isFilterQuestion(q.name));
  const t0 = Date.now();
  const result = await decide(
    buildRouterInput({
      transcript,
      durationSec: item.durationSec,
      mediaKind: item.mediaKind,
      audioTrack: item.audioTrack,
      replyContext: item.replyContext,
      audience,
    }),
    questions,
  );
  const routed = interpretRouterAnswers(result, {
    durationSec: item.durationSec,
    transcriptLength: transcript.length,
  });
  const { autoMode, autoContext } = resolveAuto({
    short,
    long,
    audience,
    routed: needsRouting ? routed : null,
  });
  return {
    audience,
    routed,
    mode: short ? ("cleanText" as const) : autoMode,
    context: autoContext,
    routerMs: Date.now() - t0,
    raw: result.answers,
  };
}

async function runSummaries(items: EvalItem[], models: SummarizeModelKey[]) {
  return await pool(items, 6, async (item, i) => {
    const transcript = stripAsrTail(item.transcript);
    const noise = detectAsrNoise(transcript);
    if (noise) {
      console.log(`[${i + 1}/${items.length}] ${item.id} ignored: ${noise}`);
      return { id: item.id, ignored: noise };
    }
    try {
      const r = await route(item, transcript);
      if (r.routed.noiseProbability >= NOISE_PROBABILITY_THRESHOLD) {
        console.log(`[${i + 1}/${items.length}] ${item.id} ignored by router`);
        return {
          id: item.id,
          ignored: `router is_noise=${r.routed.noiseProbability.toFixed(2)}`,
          noiseProbability: r.routed.noiseProbability,
        };
      }
      if (r.routed.musicProbability >= MUSIC_PROBABILITY_THRESHOLD) {
        console.log(`[${i + 1}/${items.length}] ${item.id} ignored as music`);
        return {
          id: item.id,
          ignored: `router is_music=${r.routed.musicProbability.toFixed(2)}`,
          musicProbability: r.routed.musicProbability,
        };
      }
      const extras = {
        audience: r.audience,
        speakerName:
          (item.chatId < 0 ? item.nickname : null) ?? firstName(item.fromName),
        peerName: firstName(item.peerName),
        replyContext: item.replyContext ?? null,
        speechAct: r.routed.speechAct,
        forwarded: false,
      };
      const req = buildVoiceSummaryRequest(
        {
          transcript,
          segments: item.segments,
          durationSec: item.durationSec,
          mode: r.mode,
          context: r.context,
          detail: (item.detail ?? 1) as Detail,
          chatStyleNotes: item.chatStyleNotes ?? null,
          chatLore: null,
        },
        extras,
      );
      const outputs: Record<string, { text: string; ms: number; model: string }> = {};
      for (const key of models) {
        const model = SUMMARIZE_MODEL_OPTIONS[key].id;
        const t0 = Date.now();
        let text = "";
        for (let attempt = 0; attempt < 2 && !text; attempt++) {
          try {
            text = await chatComplete({
              provider: SUMMARIZE_PROVIDER,
              model,
              system: req.system,
              user: req.user,
              temperature: req.temperature,
            });
          } catch (err) {
            console.warn(`  ${item.id} ${model} attempt ${attempt + 1}:`, String(err).slice(0, 200));
          }
        }
        outputs[key] = { text: stripUnwantedAsides(text), ms: Date.now() - t0, model };
      }
      console.log(
        `[${i + 1}/${items.length}] ${item.id} ${r.mode}/${r.context}/${r.routed.speechAct} noise=${r.routed.noiseProbability.toFixed(2)}`,
      );
      return {
        id: item.id,
        mode: r.mode,
        context: r.context,
        speechAct: r.routed.speechAct,
        noiseProbability: r.routed.noiseProbability,
        audience: r.audience,
        routerMs: r.routerMs,
        shortCleanup: req.shortCleanup,
        outputs,
      };
    } catch (err) {
      console.warn(`[${i + 1}/${items.length}] ${item.id} FAILED`, String(err));
      return { id: item.id, error: String(err) };
    }
  });
}

async function runNoise(items: EvalItem[]) {
  return await pool(items, 8, async (item) => {
    const transcript = stripAsrTail(item.transcript);
    const rule = detectAsrNoise(transcript);
    if (rule) return { id: item.id, rule, noiseProbability: null };
    const r = await route(item, transcript);
    return {
      id: item.id,
      rule: null,
      noiseProbability: r.routed.noiseProbability,
      musicProbability: r.routed.musicProbability,
    };
  });
}

async function main() {
  const [cmd, input, output, modelArg] = process.argv.slice(2);
  const items = JSON.parse(readFileSync(input, "utf8")) as EvalItem[];
  const result =
    cmd === "noise"
      ? await runNoise(items)
      : await runSummaries(
          items,
          (modelArg?.split(",") ?? ["gemini", "grok"]) as SummarizeModelKey[],
        );
  writeFileSync(output, JSON.stringify(result, null, 1));
  console.log(`wrote ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
