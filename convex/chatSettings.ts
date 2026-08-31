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

export type DeliveryMode = "instant" | "onDemand";

export interface ChatReaction {
  type: "emoji" | "custom_emoji";
  value: string; // emoji char or custom_emoji_id
  display: string; // what to show in menus (emoji char in both cases)
}

export const DEFAULT_REACTION: ChatReaction = {
  type: "emoji",
  value: "👀",
  display: "👀",
};

export interface ResolvedChatSettings {
  mode: ModeKey;
  context: ContextKey;
  detail: Detail;
  summarizeModelKey: SummarizeModelKey;
  deliveryMode: DeliveryMode;
  skipLoadingMessage: boolean;
  channelVoicesInstant: boolean;
  reaction: ChatReaction;
  businessIncludeTranscript: boolean;
}

// Resolves per-chat defaults. Rows in chatSettings override the hardcoded
// fallback from prompts.ts. Always returns a valid tuple. Legacy rows that
// predate /settings only have quietMode — it maps to deliveryMode.
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
    const deliveryMode: DeliveryMode =
      row?.deliveryMode ?? (row?.quietMode === true ? "onDemand" : "instant");
    const reaction: ChatReaction =
      row?.reactionType && row?.reactionValue
        ? {
            type: row.reactionType,
            value: row.reactionValue,
            display: row.reactionDisplay ?? row.reactionValue,
          }
        : DEFAULT_REACTION;
    return {
      mode: (row?.defaultMode as ModeKey | undefined) ?? DEFAULT_CHAT_MODE,
      context:
        (row?.defaultContext as ContextKey | undefined) ?? DEFAULT_CHAT_CONTEXT,
      detail: ((row?.defaultDetail as Detail | undefined) ??
        DEFAULT_CHAT_DETAIL) as Detail,
      summarizeModelKey: modelKey,
      deliveryMode,
      skipLoadingMessage: row?.skipLoadingMessage === true,
      channelVoicesInstant: row?.channelVoicesInstant !== false,
      reaction,
      businessIncludeTranscript: row?.businessIncludeTranscript === true,
    };
  },
});

// Single partial-update mutation behind /settings, /reaction and the
// legacy /quiet and /modal commands. Creates the row with hardcoded
// defaults on first write to a chat.
export const update = internalMutation({
  args: {
    chatId: v.number(),
    defaultMode: v.optional(v.string()),
    defaultContext: v.optional(v.string()),
    defaultDetail: v.optional(v.number()),
    summarizeModel: v.optional(v.string()),
    deliveryMode: v.optional(
      v.union(v.literal("instant"), v.literal("onDemand")),
    ),
    skipLoadingMessage: v.optional(v.boolean()),
    channelVoicesInstant: v.optional(v.boolean()),
    reactionType: v.optional(
      v.union(v.literal("emoji"), v.literal("custom_emoji")),
    ),
    reactionValue: v.optional(v.string()),
    reactionDisplay: v.optional(v.string()),
    businessIncludeTranscript: v.optional(v.boolean()),
  },
  handler: async (ctx, { chatId, ...patch }) => {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    if (existing) {
      // deliveryMode is the source of truth now; keep the legacy flag in
      // sync so nothing that still reads quietMode disagrees.
      if (defined.deliveryMode !== undefined) {
        (defined as any).quietMode = defined.deliveryMode === "onDemand";
      }
      await ctx.db.patch(existing._id, defined);
      return;
    }
    await ctx.db.insert("chatSettings", {
      chatId,
      defaultMode: DEFAULT_CHAT_MODE,
      defaultContext: DEFAULT_CHAT_CONTEXT,
      defaultDetail: DEFAULT_CHAT_DETAIL,
      ...defined,
      ...(defined.deliveryMode !== undefined
        ? { quietMode: defined.deliveryMode === "onDemand" }
        : {}),
    });
  },
});

// Kept for callers that set all three defaults at once (/defaults).
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

// /modal toggle. Stores the model KEY, not the raw id, so bumping the id
// in models.ts upgrades every chat.
export const setSummarizeModel = internalMutation({
  args: { chatId: v.number(), modelKey: v.string() },
  handler: async (ctx, { chatId, modelKey }) => {
    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
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

// /quiet toggle — legacy alias for flipping deliveryMode. Returns the new
// "on-demand enabled" value.
export const toggleQuietMode = internalMutation({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    const current: DeliveryMode =
      existing?.deliveryMode ??
      (existing?.quietMode === true ? "onDemand" : "instant");
    const next: DeliveryMode = current === "onDemand" ? "instant" : "onDemand";
    if (existing) {
      await ctx.db.patch(existing._id, {
        deliveryMode: next,
        quietMode: next === "onDemand",
      });
    } else {
      await ctx.db.insert("chatSettings", {
        chatId,
        defaultMode: DEFAULT_CHAT_MODE,
        defaultContext: DEFAULT_CHAT_CONTEXT,
        defaultDetail: DEFAULT_CHAT_DETAIL,
        deliveryMode: next,
        quietMode: next === "onDemand",
      });
    }
    return next === "onDemand";
  },
});
