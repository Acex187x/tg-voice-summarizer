import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// 8 chars from 62-letter alphabet — same scheme as voiceMessages.shortId.
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

export const get = internalQuery({
  args: { id: v.id("chatSummaries") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const getByShortId = internalQuery({
  args: { shortId: v.string() },
  handler: async (ctx, { shortId }) => {
    return await ctx.db
      .query("chatSummaries")
      .withIndex("by_short_id", (q) => q.eq("shortId", shortId))
      .unique();
  },
});

// Finds the chat summary whose result lives in the given bot message.
// Used by reply-to-summary Q&A.
export const findByAckMessage = internalQuery({
  args: { chatId: v.number(), ackMessageId: v.number() },
  handler: async (ctx, { chatId, ackMessageId }) => {
    return await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat_ack", (q) =>
        q.eq("chatId", chatId).eq("ackMessageId", ackMessageId),
      )
      .first();
  },
});

// Creates the chat-summary request row. Selection (messageIds, ts range,
// username) is set later by patchSelection once the filter has run.
export const create = internalMutation({
  args: {
    chatId: v.number(),
    requesterId: v.number(),
    requestMessageId: v.number(),
    ackMessageId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("chatSummaries", {
      ...args,
      shortId: generateShortId(),
      startTs: 0,
      endTs: 0,
      messageIds: [],
      status: "pending",
    });
  },
});

export const setStatus = internalMutation({
  args: {
    id: v.id("chatSummaries"),
    status: v.union(
      v.literal("pending"),
      v.literal("filtering"),
      v.literal("routing"),
      v.literal("summarizing"),
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

export const patchSelection = internalMutation({
  args: {
    id: v.id("chatSummaries"),
    startTs: v.number(),
    endTs: v.number(),
    fromUsername: v.optional(v.string()),
    filterDescription: v.optional(v.string()),
    messageIds: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    await ctx.db.patch(id, patch);
  },
});

export const setAutoResolution = internalMutation({
  args: {
    id: v.id("chatSummaries"),
    autoMode: v.string(),
    autoContext: v.string(),
  },
  handler: async (ctx, { id, autoMode, autoContext }) => {
    await ctx.db.patch(id, { autoMode, autoContext });
  },
});

export const markCancelled = internalMutation({
  args: { id: v.id("chatSummaries") },
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

export const setDisplayed = internalMutation({
  args: {
    id: v.id("chatSummaries"),
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
