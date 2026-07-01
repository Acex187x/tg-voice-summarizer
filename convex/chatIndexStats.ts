import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const statsArgs = {
  chatId: v.number(),
  messageTotal: v.number(),
  positiveMessages: v.number(),
  importedMessages: v.number(),
  liveMessages: v.number(),
  nonPositiveMessages: v.number(),
  minMessageId: v.optional(v.number()),
  maxMessageId: v.optional(v.number()),
  minPositiveMessageId: v.optional(v.number()),
  maxPositiveMessageId: v.optional(v.number()),
  firstTs: v.optional(v.number()),
  lastTs: v.optional(v.number()),
  firstDateMessageId: v.optional(v.number()),
  lastDateMessageId: v.optional(v.number()),
  embeddedMessages: v.number(),
  embeddingChunks: v.number(),
  minEmbeddedMessageId: v.optional(v.number()),
  maxEmbeddedMessageId: v.optional(v.number()),
  lastEmbeddedAt: v.optional(v.number()),
  embeddingModel: v.optional(v.string()),
  embeddingVersion: v.optional(v.number()),
  embeddingDimensions: v.optional(v.number()),
};

export const get = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    return await ctx.db
      .query("chatIndexStats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
  },
});

export const replace = internalMutation({
  args: statsArgs,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatIndexStats")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .unique();
    const patch = {
      ...args,
      rebuiltAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("chatIndexStats", patch);
  },
});
