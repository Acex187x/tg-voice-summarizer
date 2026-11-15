import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { TRANSCRIBE_MODEL, TRANSCRIBE_PROMPT, TRANSCRIBE_TIMESTAMPS_MODEL } from "./models";
import { transcribeAudioWithTimestamps, transcribeVoice, withinMs } from "./openai";
import { downloadFile, getFilePath } from "./telegram";

// Admin-only (CLI `npx convex run`) transcription check on a stored file.
// Sends nothing to Telegram chats and writes nothing to the database.
// mode "reuse": the pre-fix pattern — one downloaded Blob uploaded twice;
// mode "pipeline": the production transcribeVoice.
export const transcribeFileCheck = internalAction({
  args: {
    fileId: v.string(),
    mode: v.union(v.literal("reuse"), v.literal("pipeline")),
    durationSec: v.optional(v.number()),
    mediaKind: v.optional(v.string()),
  },
  handler: async (_ctx, { fileId, mode, durationSec, mediaKind }) => {
    const filePath = await getFilePath(fileId);
    const blob = await downloadFile(filePath);
    const steps: Array<{ step: string; ms: number; result: string }> = [];
    const run = async (step: string, call: () => Promise<{ text: string }>) => {
      const t = Date.now();
      try {
        const r = await withinMs(call(), 150_000);
        steps.push({ step, ms: Date.now() - t, result: r === null ? "TIMEOUT(150s)" : JSON.stringify(r.text.slice(0, 80)) });
      } catch (err) {
        steps.push({ step, ms: Date.now() - t, result: `ERROR ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` });
      }
    };
    const filename = mediaKind === "video_note" ? "voice.mp4" : "voice.ogg";
    if (mode === "reuse") {
      await run("gpt-transcribe", () =>
        transcribeAudioWithTimestamps(blob, TRANSCRIBE_MODEL, filename, { prompt: TRANSCRIBE_PROMPT, timeoutMs: 60_000 }),
      );
      await run("whisper-1 same Blob", () =>
        transcribeAudioWithTimestamps(blob, TRANSCRIBE_TIMESTAMPS_MODEL, filename, { timeoutMs: 60_000 }),
      );
    } else {
      await run("transcribeVoice", () => transcribeVoice(blob, filePath, mediaKind, durationSec));
    }
    return { size: blob.size, type: blob.type, steps };
  },
});
