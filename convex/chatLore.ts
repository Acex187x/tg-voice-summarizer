import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const add = internalMutation({
  args: {
    chatId: v.number(),
    text: v.string(),
    addedById: v.optional(v.number()),
    addedByName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("chatLore", {
      ...args,
      addedAt: Date.now(),
    });
  },
});

export const allForChat = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    return await ctx.db
      .query("chatLore")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
  },
});

export const remove = internalMutation({
  args: { id: v.id("chatLore") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});
