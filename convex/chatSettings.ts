import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  DEFAULT_CHAT_CONTEXT,
  DEFAULT_CHAT_DETAIL,
  DEFAULT_CHAT_MODE,
  type ContextKey,
  type Detail,
  type ModeKey,
} from "./prompts";

// Resolves per-chat defaults. Rows in chatSettings override the hardcoded
// fallback from prompts.ts. Always returns a valid triple.
export const getResolved = internalQuery({
  args: { chatId: v.number() },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ mode: ModeKey; context: ContextKey; detail: Detail }> => {
    const row = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    return {
      mode: (row?.defaultMode as ModeKey | undefined) ?? DEFAULT_CHAT_MODE,
      context:
        (row?.defaultContext as ContextKey | undefined) ?? DEFAULT_CHAT_CONTEXT,
      detail: ((row?.defaultDetail as Detail | undefined) ?? DEFAULT_CHAT_DETAIL) as Detail,
    };
  },
});

export const set = internalMutation({
  args: {
    chatId: v.number(),
    defaultMode: v.string(),
    defaultContext: v.string(),
    defaultDetail: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        defaultMode: args.defaultMode,
        defaultContext: args.defaultContext,
        defaultDetail: args.defaultDetail,
      });
    } else {
      await ctx.db.insert("chatSettings", args);
    }
  },
});
