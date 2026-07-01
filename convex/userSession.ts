import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const viewLiteral = v.union(
  v.literal("main"),
  v.literal("mode"),
  v.literal("context"),
  v.literal("detail"),
);

export const get = internalQuery({
  args: { userId: v.number(), voiceShortId: v.string() },
  handler: async (ctx, { userId, voiceShortId }) => {
    return await ctx.db
      .query("userSession")
      .withIndex("by_user_voice", (q) =>
        q.eq("userId", userId).eq("voiceShortId", voiceShortId),
      )
      .unique();
  },
});

export const upsert = internalMutation({
  args: {
    userId: v.number(),
    voiceShortId: v.string(),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    pickerMessageId: v.optional(v.number()),
    view: viewLiteral,
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userSession")
      .withIndex("by_user_voice", (q) =>
        q.eq("userId", args.userId).eq("voiceShortId", args.voiceShortId),
      )
      .unique();
    const patch = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("userSession", patch);
  },
});
