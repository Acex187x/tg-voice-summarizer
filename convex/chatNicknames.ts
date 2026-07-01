import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const set = internalMutation({
  args: {
    chatId: v.number(),
    userId: v.number(),
    nickname: v.string(),
  },
  handler: async (ctx, { chatId, userId, nickname }) => {
    const existing = await ctx.db
      .query("chatNicknames")
      .withIndex("by_chat_user", (q) =>
        q.eq("chatId", chatId).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { nickname });
      return existing._id;
    }
    return await ctx.db.insert("chatNicknames", { chatId, userId, nickname });
  },
});

export const getForUser = internalQuery({
  args: { chatId: v.number(), userId: v.number() },
  handler: async (ctx, { chatId, userId }) => {
    return await ctx.db
      .query("chatNicknames")
      .withIndex("by_chat_user", (q) =>
        q.eq("chatId", chatId).eq("userId", userId),
      )
      .unique();
  },
});

// Returns all nicknames for a chat as a Map<userId, nickname> so the
// chat-log renderer can look them up efficiently.
export const allForChat = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    const rows = await ctx.db
      .query("chatNicknames")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    return rows;
  },
});

export const remove = internalMutation({
  args: { chatId: v.number(), userId: v.number() },
  handler: async (ctx, { chatId, userId }) => {
    const existing = await ctx.db
      .query("chatNicknames")
      .withIndex("by_chat_user", (q) =>
        q.eq("chatId", chatId).eq("userId", userId),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
