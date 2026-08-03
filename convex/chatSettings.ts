import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  DEFAULT_SUMMARIZE_MODEL_KEY,
  isSummarizeModelKey,
  type SummarizeModelKey,
} from "./models";
import {
  DEFAULT_CHAT_CONTEXT,
  DEFAULT_CHAT_DETAIL,
  DEFAULT_CHAT_MODE,
  type ContextKey,
  type Detail,
  type ModeKey,
} from "./prompts";

export interface ResolvedChatSettings {
  mode: ModeKey;
  context: ContextKey;
  detail: Detail;
  summarizeModelKey: SummarizeModelKey;
  quietMode: boolean;
}

// Resolves per-chat defaults. Rows in chatSettings override the hardcoded
// fallback from prompts.ts. Always returns a valid tuple.
export const getResolved = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }): Promise<ResolvedChatSettings> => {
    const row = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    const modelKey =
      row?.summarizeModel && isSummarizeModelKey(row.summarizeModel)
        ? row.summarizeModel
        : DEFAULT_SUMMARIZE_MODEL_KEY;
    return {
      mode: (row?.defaultMode as ModeKey | undefined) ?? DEFAULT_CHAT_MODE,
      context:
        (row?.defaultContext as ContextKey | undefined) ?? DEFAULT_CHAT_CONTEXT,
      detail: ((row?.defaultDetail as Detail | undefined) ??
        DEFAULT_CHAT_DETAIL) as Detail,
      summarizeModelKey: modelKey,
      quietMode: row?.quietMode === true,
    };
  },
});

async function getOrCreateRow(
  ctx: { db: any },
  chatId: number,
): Promise<{ _id: any } | null> {
  return await ctx.db
    .query("chatSettings")
    .withIndex("by_chat", (q: any) => q.eq("chatId", chatId))
    .unique();
}

export const set = internalMutation({
  args: {
    chatId: v.number(),
    defaultMode: v.string(),
    defaultContext: v.string(),
    defaultDetail: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await getOrCreateRow(ctx, args.chatId);
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

// /modal toggle. Stores the model KEY, not the raw id, so bumping the id
// in models.ts upgrades every chat.
export const setSummarizeModel = internalMutation({
  args: { chatId: v.number(), modelKey: v.string() },
  handler: async (ctx, { chatId, modelKey }) => {
    const existing = await getOrCreateRow(ctx, chatId);
    if (existing) {
      await ctx.db.patch(existing._id, { summarizeModel: modelKey });
    } else {
      await ctx.db.insert("chatSettings", {
        chatId,
        defaultMode: DEFAULT_CHAT_MODE,
        defaultContext: DEFAULT_CHAT_CONTEXT,
        defaultDetail: DEFAULT_CHAT_DETAIL,
        summarizeModel: modelKey,
      });
    }
  },
});

// /quiet toggle. Returns the new value.
export const toggleQuietMode = internalMutation({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    if (existing) {
      const next = existing.quietMode !== true;
      await ctx.db.patch(existing._id, { quietMode: next });
      return next;
    }
    await ctx.db.insert("chatSettings", {
      chatId,
      defaultMode: DEFAULT_CHAT_MODE,
      defaultContext: DEFAULT_CHAT_CONTEXT,
      defaultDetail: DEFAULT_CHAT_DETAIL,
      quietMode: true,
    });
    return true;
  },
});
