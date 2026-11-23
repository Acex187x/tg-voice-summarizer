// Pulls recent voices from the Convex deployment into an eval dataset
// (the format scripts/eval/run-voice-eval.ts consumes), plus the summary
// the bot actually showed. Read-only: uses `npx convex data`.
//
//   CONVEX_DEPLOYMENT=dev:... node scripts/eval/build-prod-dataset.mjs \
//     --hours 24 --out /path/to/dataset.json
//
// The output contains chat transcripts — keep it out of the repo.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => {
      if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
      return acc;
    }, []),
);
const hours = Number(args.hours ?? 24);
const out = args.out;
if (!out) {
  console.error("usage: build-prod-dataset.mjs --hours 24 --out file.json");
  process.exit(1);
}

// The Convex CLI exits before a piped stdout is flushed, truncating big
// tables — so its output goes to a file instead of a pipe.
const scratch = mkdtempSync(join(tmpdir(), "voice-eval-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function table(name, limit = 8000) {
  const file = join(scratch, `${name}.jsonl`);
  const fd = openSync(file, "w");
  try {
    execFileSync(
      "npx",
      ["convex", "data", name, "--limit", String(limit), "--order", "desc", "--format", "jsonl"],
      { stdio: ["ignore", fd, "pipe"] },
    );
  } catch (err) {
    // Empty tables make the CLI exit non-zero.
    if (String(err.stderr ?? "").includes("no documents")) return [];
    throw err;
  } finally {
    closeSync(fd);
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
}

const since = Date.now() - hours * 3600 * 1000;
// Newest-first pages sized for a day or two of traffic (~50-150 voices/day).
// Reading 4000 rows of `summaries` hit Convex's "too many system
// operations" limit on 2026-11-16. A page that ends inside the window
// would silently drop rows, so that is an error, not a warning.
function recentRows(name, limit) {
  const rows = table(name, limit);
  const oldest = rows.at(-1)?._creationTime;
  if (rows.length === limit && oldest !== undefined && oldest >= since) {
    throw new Error(`${name}: ${limit} newest rows do not cover --hours ${hours}; raise the limit`);
  }
  return rows.filter((r) => r._creationTime >= since);
}
const voices = recentRows("voiceMessages", 1000);
const voiceIds = new Set(voices.map((v) => v._id));
// Summaries are created after their voice, so the window covers them too.
const summaries = recentRows("summaries", 1500).filter((s) => voiceIds.has(s.voiceMessageId));
const memory = new Map(table("chatMemory", 500).map((m) => [m.chatId, m.notes]));
const nicknames = new Map(
  table("chatNicknames", 2000).map((n) => [`${n.chatId}:${n.userId}`, n.nickname]),
);
const peers = new Map(
  table("businessChatSettings", 2000).map((b) => [`${b.connectionId}:${b.peerChatId}`, b.peerName]),
);
const settings = new Map(table("chatSettings", 2000).map((s) => [s.chatId, s]));

const items = voices.map((v) => {
  const shown = summaries.find(
    (s) =>
      s.voiceMessageId === v._id &&
      s.mode === v.displayedMode &&
      s.context === v.displayedContext &&
      s.detail === v.displayedDetail,
  );
  const st = settings.get(v.businessUserChatId ?? v.chatId) ?? {};
  return {
    id: v._id,
    createdAt: v._creationTime,
    chatId: v.chatId,
    chatTitle: v.chatTitle,
    fromName: v.forwardedFromName ?? v.fromName,
    forwarded: v.forwardedFromName !== undefined,
    nickname: v.fromId !== undefined ? (nicknames.get(`${v.chatId}:${v.fromId}`) ?? null) : null,
    businessConnectionId: v.businessConnectionId,
    businessOutgoing: v.businessOutgoing,
    peerName: v.businessConnectionId ? (peers.get(`${v.businessConnectionId}:${v.chatId}`) ?? null) : null,
    ackMessageId: v.ackMessageId,
    delivery: v.delivery,
    mediaKind: v.mediaKind,
    durationSec: v.durationSec,
    timings: v.timings ?? null,
    transcript: v.transcript ?? "",
    segments: v.transcriptSegments ?? null,
    chatStyleNotes: memory.get(v.chatId) ?? null,
    replyContext: v.replyContext ?? null,
    summarizeModelKey: st.summarizeModel ?? null,
    detail: shown?.detail ?? st.defaultDetail ?? 1,
    status: v.status,
    error: v.error ?? null,
    cancelled: v.cancelled ?? false,
    autoSpeechAct: v.autoSpeechAct ?? null,
    old_mode: shown?.mode ?? null,
    old_context: shown?.context ?? null,
    old_summary: shown?.text ?? null,
    summariesCount: summaries.filter((s) => s.voiceMessageId === v._id).length,
  };
});

writeFileSync(out, JSON.stringify(items, null, 1));
const count = (f) => items.filter(f).length;
console.log(
  JSON.stringify({
    hours,
    voices: items.length,
    done: count((i) => i.status === "done"),
    ignored: count((i) => i.status === "ignored"),
    error: count((i) => i.status === "error" && !i.cancelled),
    cancelled: count((i) => i.cancelled),
    resummarized: count((i) => i.summariesCount > 1),
    withReplyContext: count((i) => i.replyContext),
  }),
);
