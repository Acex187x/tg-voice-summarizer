import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Persistent style notes per chat. One row per chatId; the
// refreshChatMemory action overwrites `notes` in place over time as new
// messages give the LLM more material to refine its observations from.

export const get = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    return await ctx.db
      .query("chatMemory")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
  },
});

export const upsert = internalMutation({
  args: { chatId: v.number(), notes: v.string() },
  handler: async (ctx, { chatId, notes }) => {
    const existing = await ctx.db
      .query("chatMemory")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        notes,
        lastUpdatedAt: Date.now(),
        updateCount: (existing.updateCount ?? 0) + 1,
      });
      return existing._id;
    }
    return await ctx.db.insert("chatMemory", {
      chatId,
      notes,
      lastUpdatedAt: Date.now(),
      updateCount: 1,
    });
  },
});
