import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const mediaKindLiteral = v.union(
  v.literal("text"),
  v.literal("photo"),
  v.literal("video"),
  v.literal("voice"),
  v.literal("audio"),
  v.literal("video_note"),
  v.literal("document"),
  v.literal("sticker"),
  v.literal("other"),
);

// Insert one observed message. Idempotent on (chatId, messageId) — if a
// row already exists we just patch the new fields. Telegram occasionally
// sends edited_message updates that overlap with prior message updates,
// so this protects us from duplicate inserts.
export const upsert = internalMutation({
  args: {
    chatId: v.number(),
    messageId: v.number(),
    ts: v.number(),
    fromId: v.optional(v.number()),
    fromFirstName: v.optional(v.string()),
    fromLastName: v.optional(v.string()),
    fromUsername: v.optional(v.string()),
    text: v.optional(v.string()),
    mediaKind: v.optional(mediaKindLiteral),
    voiceShortId: v.optional(v.string()),
    replyToMessageId: v.optional(v.number()),
    importedFromDump: v.optional(v.boolean()),
    importSource: v.optional(v.string()),
    importedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_message", (q) =>
        q.eq("chatId", args.chatId).eq("messageId", args.messageId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      await updateStatsForExistingMessage(ctx, existing, args);
      return existing._id;
    }
    const id = await ctx.db.insert("chatMessages", args);
    await updateStatsForNewMessage(ctx, args);
    return id;
  },
});

async function updateStatsForNewMessage(ctx: any, msg: {
  chatId: number;
  messageId: number;
  ts: number;
  importedFromDump?: boolean;
}) {
  const existing = await ctx.db
    .query("chatIndexStats")
    .withIndex("by_chat", (q: any) => q.eq("chatId", msg.chatId))
    .unique();
  const isPositive = msg.messageId > 0;
  const isImported = msg.importedFromDump === true;
  const patch = {
    messageTotal: (existing?.messageTotal ?? 0) + 1,
    positiveMessages: (existing?.positiveMessages ?? 0) + (isPositive ? 1 : 0),
    importedMessages: (existing?.importedMessages ?? 0) + (isImported ? 1 : 0),
    liveMessages: (existing?.liveMessages ?? 0) + (isImported ? 0 : 1),
    nonPositiveMessages: (existing?.nonPositiveMessages ?? 0) + (isPositive ? 0 : 1),
    minMessageId:
      existing?.minMessageId === undefined
        ? msg.messageId
        : Math.min(existing.minMessageId, msg.messageId),
    maxMessageId:
      existing?.maxMessageId === undefined
        ? msg.messageId
        : Math.max(existing.maxMessageId, msg.messageId),
    minPositiveMessageId: isPositive
      ? existing?.minPositiveMessageId === undefined
        ? msg.messageId
        : Math.min(existing.minPositiveMessageId, msg.messageId)
      : existing?.minPositiveMessageId,
    maxPositiveMessageId: isPositive
      ? existing?.maxPositiveMessageId === undefined
        ? msg.messageId
        : Math.max(existing.maxPositiveMessageId, msg.messageId)
      : existing?.maxPositiveMessageId,
    firstTs:
      existing?.firstTs === undefined ? msg.ts : Math.min(existing.firstTs, msg.ts),
    lastTs:
      existing?.lastTs === undefined ? msg.ts : Math.max(existing.lastTs, msg.ts),
    firstDateMessageId:
      existing?.firstTs === undefined || msg.ts < existing.firstTs
        ? msg.messageId
        : existing?.firstDateMessageId,
    lastDateMessageId:
      existing?.lastTs === undefined || msg.ts > existing.lastTs
        ? msg.messageId
        : existing?.lastDateMessageId,
    updatedAt: Date.now(),
  };
  if (existing) {
    await ctx.db.patch(existing._id, patch);
  } else {
    await ctx.db.insert("chatIndexStats", {
      chatId: msg.chatId,
      ...patch,
      embeddedMessages: 0,
      embeddingChunks: 0,
    });
  }
}

async function updateStatsForExistingMessage(
  ctx: any,
  existingMessage: any,
  next: { chatId: number; messageId: number; ts: number; importedFromDump?: boolean },
) {
  const stats = await ctx.db
    .query("chatIndexStats")
    .withIndex("by_chat", (q: any) => q.eq("chatId", next.chatId))
    .unique();
  if (!stats) return;
  const wasImported = existingMessage.importedFromDump === true;
  const isImported = next.importedFromDump === true;
  const importDelta = (isImported ? 1 : 0) - (wasImported ? 1 : 0);
  await ctx.db.patch(stats._id, {
    importedMessages: stats.importedMessages + importDelta,
    liveMessages: stats.liveMessages - importDelta,
    firstTs: Math.min(stats.firstTs ?? next.ts, next.ts),
    lastTs: Math.max(stats.lastTs ?? next.ts, next.ts),
    firstDateMessageId:
      stats.firstTs === undefined || next.ts < stats.firstTs
        ? next.messageId
        : stats.firstDateMessageId,
    lastDateMessageId:
      stats.lastTs === undefined || next.ts > stats.lastTs
        ? next.messageId
        : stats.lastDateMessageId,
    updatedAt: Date.now(),
  });
}

// Fetches messages by an explicit list of message_ids. Used when the
// filter agent picks specific IDs by semantic match. Convex doesn't
// support `IN` queries, so we do parallel point-lookups via the
// by_chat_message index — fine for the small ID lists the LLM returns.
export const getByIds = internalQuery({
  args: { chatId: v.number(), messageIds: v.array(v.number()) },
  handler: async (ctx, { chatId, messageIds }) => {
    const out = [];
    for (const messageId of messageIds) {
      const row = await ctx.db
        .query("chatMessages")
        .withIndex("by_chat_message", (q) =>
          q.eq("chatId", chatId).eq("messageId", messageId),
        )
        .unique();
      if (row) out.push(row);
    }
    return out;
  },
});

export const lexicalSearch = internalQuery({
  args: {
    chatId: v.number(),
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { chatId, query, limit }) => {
    return await ctx.db
      .query("chatMessages")
      .withSearchIndex("search_text", (q) =>
        q.search("text", query).eq("chatId", chatId),
      )
      .take(Math.max(1, Math.min(limit, 80)));
  },
});

export const contextAroundIds = internalQuery({
  args: {
    chatId: v.number(),
    messageIds: v.array(v.number()),
    before: v.number(),
    after: v.number(),
  },
  handler: async (ctx, { chatId, messageIds, before, after }) => {
    const out = [];
    const beforeLimit = Math.max(0, Math.min(before, 30));
    const afterLimit = Math.max(0, Math.min(after, 30));
    for (const messageId of messageIds.slice(0, 20)) {
      const target = await ctx.db
        .query("chatMessages")
        .withIndex("by_chat_message", (q) =>
          q.eq("chatId", chatId).eq("messageId", messageId),
        )
        .unique();
      if (!target) continue;
      const beforeRows = beforeLimit
        ? await ctx.db
            .query("chatMessages")
            .withIndex("by_chat_ts", (q) => q.eq("chatId", chatId).lt("ts", target.ts))
            .order("desc")
            .take(beforeLimit)
        : [];
      const afterRows = afterLimit
        ? await ctx.db
            .query("chatMessages")
            .withIndex("by_chat_ts", (q) => q.eq("chatId", chatId).gt("ts", target.ts))
            .order("asc")
            .take(afterLimit)
        : [];
      const replyTo =
        target.replyToMessageId !== undefined
          ? await ctx.db
              .query("chatMessages")
              .withIndex("by_chat_message", (q) =>
                q.eq("chatId", chatId).eq("messageId", target.replyToMessageId!),
              )
              .unique()
          : null;
      out.push({
        targetId: messageId,
        replyTo,
        messages: [...beforeRows.reverse(), target, ...afterRows],
      });
    }
    return out;
  },
});

export const statsBatchByMessageId = internalQuery({
  args: {
    chatId: v.number(),
    afterMessageId: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, { chatId, afterMessageId, limit }) => {
    const q = ctx.db
      .query("chatMessages")
      .withIndex("by_chat_message", (idx) => {
        const base = idx.eq("chatId", chatId);
        return afterMessageId === undefined
          ? base
          : base.gt("messageId", afterMessageId);
      })
      .order("asc");
    return await q.take(Math.max(1, Math.min(limit, 500)));
  },
});

export const get = internalQuery({
  args: { id: v.id("chatMessages") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const findByMessage = internalQuery({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    return await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_message", (q) =>
        q.eq("chatId", chatId).eq("messageId", messageId),
      )
      .unique();
  },
});

// Records a back-reference from a chat message row to its voice
// transcript shortId. Used after a voice arrives — we first insert the
// chatMessages row (without the shortId yet, since voiceMessages.shortId
// is generated in a separate mutation), then patch it once we have it.
export const linkVoiceShortId = internalMutation({
  args: {
    chatId: v.number(),
    messageId: v.number(),
    voiceShortId: v.string(),
  },
  handler: async (ctx, { chatId, messageId, voiceShortId }) => {
    const existing = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_message", (q) =>
        q.eq("chatId", chatId).eq("messageId", messageId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { voiceShortId });
    }
  },
});

// Returns messages in [startTs, endTs] (inclusive on both ends), ordered
// by ts ascending. Optionally filtered by username.
export const range = internalQuery({
  args: {
    chatId: v.number(),
    startTs: v.number(),
    endTs: v.number(),
    fromUsername: v.optional(v.string()),
  },
  handler: async (ctx, { chatId, startTs, endTs, fromUsername }) => {
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_ts", (q) =>
        q.eq("chatId", chatId).gte("ts", startTs).lte("ts", endTs),
      )
      .collect();
    if (fromUsername) {
      const lc = fromUsername.toLowerCase();
      return rows.filter((r) => r.fromUsername?.toLowerCase() === lc);
    }
    return rows;
  },
});

// Returns the latest N messages for a chat (descending by ts), used by
// the gap-based "last session" detector and as a fallback when the
// filter agent returns an empty time range.
export const latest = internalQuery({
  args: { chatId: v.number(), limit: v.number() },
  handler: async (ctx, { chatId, limit }) => {
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_ts", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(limit);
    return rows;
  },
});

export const forBackfill = internalQuery({
  args: {
    chatId: v.number(),
    afterTs: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, { chatId, afterTs, limit }) => {
    const q = ctx.db
      .query("chatMessages")
      .withIndex("by_chat_ts", (idx) => {
        const base = idx.eq("chatId", chatId);
        return afterTs === undefined ? base : base.gt("ts", afterTs);
      })
      .order("asc");
    return await q.take(limit);
  },
});

// True if we have ANY message stored for this chat. Used by the /summary
// pipeline to give a helpful error when the bot has been added but
// hasn't accumulated any history yet.
export const hasAnyForChat = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    const row = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_ts", (q) => q.eq("chatId", chatId))
      .first();
    return row !== null;
  },
});
