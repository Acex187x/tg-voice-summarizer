import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Registry of the bot's own Q&A answer messages. When a user replies to
// one of these, the bot resolves it back to the source voice / chat
// summary and answers the follow-up with the same context.

export const create = internalMutation({
  args: {
    chatId: v.number(),
    messageId: v.number(),
    voiceShortId: v.optional(v.string()),
    chatSummaryShortId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("qaMessages", args);
  },
});

export const findByMessage = internalQuery({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    return await ctx.db
      .query("qaMessages")
      .withIndex("by_chat_message", (q) =>
        q.eq("chatId", chatId).eq("messageId", messageId),
      )
      .first();
  },
});
