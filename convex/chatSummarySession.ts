import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const viewLiteral = v.union(
  v.literal("main"),
  v.literal("mode"),
  v.literal("context"),
  v.literal("detail"),
);

export const get = internalQuery({
  args: { userId: v.number(), chatSummaryShortId: v.string() },
  handler: async (ctx, { userId, chatSummaryShortId }) => {
    return await ctx.db
      .query("chatSummarySession")
      .withIndex("by_user_summary", (q) =>
        q.eq("userId", userId).eq("chatSummaryShortId", chatSummaryShortId),
      )
      .unique();
  },
});

export const upsert = internalMutation({
  args: {
    userId: v.number(),
    chatSummaryShortId: v.string(),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    pickerMessageId: v.optional(v.number()),
    view: viewLiteral,
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatSummarySession")
      .withIndex("by_user_summary", (q) =>
        q
          .eq("userId", args.userId)
          .eq("chatSummaryShortId", args.chatSummaryShortId),
      )
      .unique();
    const patch = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("chatSummarySession", patch);
  },
});
