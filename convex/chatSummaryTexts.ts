import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Cache for generated chat-summary text. Keyed by (chatSummaryId, mode,
// context, detail). The mode and context here are always concrete keys
// (never "auto") — same convention as the voice `summaries` cache.
//
// The chatSummaryId is what makes this aggressive cache work as the user
// asked: the message-selection is frozen on chatSummaries (messageIds is
// immutable after creation), so as long as the user keeps the same
// request, every (mode, context, detail) tuple they try is cached
// independently and re-using one is instant.

export const findCached = internalQuery({
  args: {
    chatSummaryId: v.id("chatSummaries"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
  },
  handler: async (ctx, { chatSummaryId, mode, context, detail }) => {
    return await ctx.db
      .query("chatSummaryTexts")
      .withIndex("by_settings", (q) =>
        q
          .eq("chatSummaryId", chatSummaryId)
          .eq("mode", mode)
          .eq("context", context)
          .eq("detail", detail),
      )
      .unique();
  },
});

export const store = internalMutation({
  args: {
    chatSummaryId: v.id("chatSummaries"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatSummaryTexts")
      .withIndex("by_settings", (q) =>
        q
          .eq("chatSummaryId", args.chatSummaryId)
          .eq("mode", args.mode)
          .eq("context", args.context)
          .eq("detail", args.detail),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { text: args.text });
      return existing._id;
    }
    return await ctx.db.insert("chatSummaryTexts", args);
  },
});
