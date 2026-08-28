import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// 8 chars from 62-letter alphabet → 62^8 ≈ 2.18e14 possibilities. Plenty
// of room before collisions matter for our scale, and short enough to
// comfortably fit inside Telegram's 64-byte callback_data limit.
const SHORT_ID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateShortId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
  }
  return out;
}

const mediaKindLiteral = v.union(
  v.literal("voice"),
  v.literal("audio"),
  v.literal("video_note"),
);

export const findByMessage = internalQuery({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    return await ctx.db
      .query("voiceMessages")
      .withIndex("by_chat_message", (q) =>
        q.eq("chatId", chatId).eq("messageId", messageId),
      )
      .unique();
  },
});

export const get = internalQuery({
  args: { id: v.id("voiceMessages") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

// Finds the voice whose summary lives in the given bot message (the ack
// message that got edited into the final summary). Used by reply-to-summary
// Q&A.
export const findByAckMessage = internalQuery({
  args: { chatId: v.number(), ackMessageId: v.number() },
  handler: async (ctx, { chatId, ackMessageId }) => {
    return await ctx.db
      .query("voiceMessages")
      .withIndex("by_chat_ack", (q) =>
        q.eq("chatId", chatId).eq("ackMessageId", ackMessageId),
      )
      .first();
  },
});

export const getByShortId = internalQuery({
  args: { shortId: v.string() },
  handler: async (ctx, { shortId }) => {
    return await ctx.db
      .query("voiceMessages")
      .withIndex("by_short_id", (q) => q.eq("shortId", shortId))
      .unique();
  },
});

export const create = internalMutation({
  args: {
    chatId: v.number(),
    chatTitle: v.optional(v.string()),
    messageId: v.number(),
    fromId: v.optional(v.number()),
    fromName: v.optional(v.string()),
    fileId: v.string(),
    mediaKind: v.optional(mediaKindLiteral),
    durationSec: v.optional(v.number()),
    ackMessageId: v.optional(v.number()),
    businessConnectionId: v.optional(v.string()),
    businessUserChatId: v.optional(v.number()),
    delivery: v.optional(
      v.union(
        v.literal("instant"),
        v.literal("instantSilent"),
        v.literal("onDemand"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("voiceMessages", {
      ...args,
      shortId: generateShortId(),
      status: "pending",
    });
  },
});

// Upgrades the delivery plan mid-flight (bot-mention reply on a voice
// that's still processing forces a public "instant" post). The pipeline
// re-reads the row before committing the final message.
export const setDelivery = internalMutation({
  args: {
    id: v.id("voiceMessages"),
    delivery: v.union(
      v.literal("instant"),
      v.literal("instantSilent"),
      v.literal("onDemand"),
    ),
  },
  handler: async (ctx, { id, delivery }) => {
    await ctx.db.patch(id, { delivery });
  },
});

export const setStatus = internalMutation({
  args: {
    id: v.id("voiceMessages"),
    status: v.union(
      v.literal("pending"),
      v.literal("transcribing"),
      v.literal("routing"),
      v.literal("summarizing"),
      v.literal("ignored"),
      v.literal("done"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, error }) => {
    await ctx.db.patch(id, {
      status,
      ...(error !== undefined ? { error } : {}),
    });
  },
});

export const setTranscript = internalMutation({
  args: {
    id: v.id("voiceMessages"),
    transcript: v.string(),
    segments: v.optional(
      v.array(
        v.object({
          start: v.number(),
          end: v.number(),
          text: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, { id, transcript, segments }) => {
    await ctx.db.patch(id, {
      transcript,
      ...(segments && segments.length > 0
        ? { transcriptSegments: segments }
        : {}),
    });
  },
});

// Stores the router's auto→concrete resolution so we don't re-run the
// router on every cache miss.
export const setAutoResolution = internalMutation({
  args: {
    id: v.id("voiceMessages"),
    autoMode: v.string(),
    autoContext: v.string(),
  },
  handler: async (ctx, { id, autoMode, autoContext }) => {
    await ctx.db.patch(id, { autoMode, autoContext });
  },
});

// Records which summary is currently shown in the source chat message.
// Used by "apply to chat" — when an author picks different settings in
// the DM picker and wants to update the chat display.
export const setDisplayed = internalMutation({
  args: {
    id: v.id("voiceMessages"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
  },
  handler: async (ctx, { id, mode, context, detail }) => {
    await ctx.db.patch(id, {
      displayedMode: mode,
      displayedContext: context,
      displayedDetail: detail,
    });
  },
});

// Marks the voice as cancelled by user. Used by both:
//   • the cancel button on the in-flight loading ack (the pipeline polls
//     this flag between stages and bails out)
//   • the delete button on the finished summary message (purely cosmetic
//     in that case — the row is already done)
//
// We deliberately don't downgrade a finished row's status to "error",
// because that would screw up later picker / apply-to-chat operations
// against the same voice. Just set the cancelled flag.
export const markCancelled = internalMutation({
  args: { id: v.id("voiceMessages") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    if (row.status === "done") {
      await ctx.db.patch(id, { cancelled: true });
    } else {
      await ctx.db.patch(id, { cancelled: true, status: "error" });
    }
  },
});

export const setTimings = internalMutation({
  args: {
    id: v.id("voiceMessages"),
    timings: v.object({
      transcribeMs: v.optional(v.number()),
      routerMs: v.optional(v.number()),
      summarizeMs: v.optional(v.number()),
      totalMs: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { id, timings }) => {
    await ctx.db.patch(id, { timings });
  },
});
