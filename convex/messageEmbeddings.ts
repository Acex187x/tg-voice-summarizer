import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const get = internalQuery({
  args: { id: v.id("messageEmbeddings") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const getByIds = internalQuery({
  args: { ids: v.array(v.id("messageEmbeddings")) },
  handler: async (ctx, { ids }) => {
    const out = [];
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row) out.push(row);
    }
    return out;
  },
});

export const findForMessage = internalQuery({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    return await ctx.db
      .query("messageEmbeddings")
      .withIndex("by_chat_message_chunk", (q) =>
        q.eq("chatId", chatId).eq("messageId", messageId),
      )
      .collect();
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
      .query("messageEmbeddings")
      .withIndex("by_chat_message_chunk", (idx) => {
        const base = idx.eq("chatId", chatId);
        return afterMessageId === undefined
          ? base
          : base.gt("messageId", afterMessageId);
      })
      .order("asc");
    return await q.take(Math.max(1, Math.min(limit, 100)));
  },
});

export const storeForMessage = internalMutation({
  args: {
    chatId: v.number(),
    chatMessageId: v.id("chatMessages"),
    messageId: v.number(),
    ts: v.number(),
    fromId: v.optional(v.number()),
    fromUsername: v.optional(v.string()),
    mediaKind: v.optional(v.string()),
    chunks: v.array(
      v.object({
        chunkIndex: v.number(),
        chunkText: v.string(),
        embedding: v.array(v.float64()),
      }),
    ),
    embeddingModel: v.string(),
    embeddingDimensions: v.number(),
    embeddingVersion: v.number(),
    contentHash: v.string(),
    embeddedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messageEmbeddings")
      .withIndex("by_chat_message_chunk", (q) =>
        q.eq("chatId", args.chatId).eq("messageId", args.messageId),
      )
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    for (const chunk of args.chunks) {
      await ctx.db.insert("messageEmbeddings", {
        chatId: args.chatId,
        chatMessageId: args.chatMessageId,
        messageId: args.messageId,
        ts: args.ts,
        fromId: args.fromId,
        fromUsername: args.fromUsername,
        mediaKind: args.mediaKind,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        embedding: chunk.embedding,
        embeddingModel: args.embeddingModel,
        embeddingDimensions: args.embeddingDimensions,
        embeddingVersion: args.embeddingVersion,
        contentHash: args.contentHash,
        embeddedAt: args.embeddedAt,
      });
    }
    await updateEmbeddingStatsForStore(ctx, args, existing.length);
    return args.chunks.length;
  },
});

async function updateEmbeddingStatsForStore(
  ctx: any,
  args: {
    chatId: number;
    messageId: number;
    chunks: Array<unknown>;
    embeddedAt: number;
    embeddingModel: string;
    embeddingVersion: number;
    embeddingDimensions: number;
  },
  existingChunkCount: number,
) {
  const stats = await ctx.db
    .query("chatIndexStats")
    .withIndex("by_chat", (q: any) => q.eq("chatId", args.chatId))
    .unique();
  if (!stats) return;
  const chunkDelta = args.chunks.length - existingChunkCount;
  const embeddedDelta = existingChunkCount === 0 && args.chunks.length > 0 ? 1 : 0;
  await ctx.db.patch(stats._id, {
    embeddedMessages: stats.embeddedMessages + embeddedDelta,
    embeddingChunks: Math.max(0, stats.embeddingChunks + chunkDelta),
    minEmbeddedMessageId:
      stats.minEmbeddedMessageId === undefined
        ? args.messageId
        : Math.min(stats.minEmbeddedMessageId, args.messageId),
    maxEmbeddedMessageId:
      stats.maxEmbeddedMessageId === undefined
        ? args.messageId
        : Math.max(stats.maxEmbeddedMessageId, args.messageId),
    lastEmbeddedAt:
      stats.lastEmbeddedAt === undefined
        ? args.embeddedAt
        : Math.max(stats.lastEmbeddedAt, args.embeddedAt),
    embeddingModel: args.embeddingModel,
    embeddingVersion: args.embeddingVersion,
    embeddingDimensions: args.embeddingDimensions,
    updatedAt: Date.now(),
  });
}

export const deleteForMessage = internalMutation({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    const existing = await ctx.db
      .query("messageEmbeddings")
      .withIndex("by_chat_message_chunk", (q) =>
        q.eq("chatId", chatId).eq("messageId", messageId),
      )
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    await updateEmbeddingStatsForDelete(ctx, chatId, existing.length);
    return existing.length;
  },
});

async function updateEmbeddingStatsForDelete(
  ctx: any,
  chatId: number,
  existingChunkCount: number,
) {
  if (existingChunkCount === 0) return;
  const stats = await ctx.db
    .query("chatIndexStats")
    .withIndex("by_chat", (q: any) => q.eq("chatId", chatId))
    .unique();
  if (!stats) return;
  await ctx.db.patch(stats._id, {
    embeddedMessages: Math.max(0, stats.embeddedMessages - 1),
    embeddingChunks: Math.max(0, stats.embeddingChunks - existingChunkCount),
    updatedAt: Date.now(),
  });
}
