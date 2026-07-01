import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const get = internalQuery({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    return await ctx.db
      .query("businessConnections")
      .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
      .unique();
  },
});

export const upsert = internalMutation({
  args: {
    connectionId: v.string(),
    userId: v.number(),
    userChatId: v.number(),
    isEnabled: v.boolean(),
    rights: v.optional(v.any()),
    connectedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("businessConnections")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .unique();
    const patch = {
      ...args,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("businessConnections", patch);
  },
});
