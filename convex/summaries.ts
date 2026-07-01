import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Cache for generated summaries. Keyed by (voice, mode, context, detail).
// Mode and context here are always CONCRETE keys, never "auto". Resolve
// "auto" via the router (convex/prompts.ts) before calling these functions.

export const findCached = internalQuery({
  args: {
    voiceMessageId: v.id("voiceMessages"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
  },
  handler: async (ctx, { voiceMessageId, mode, context, detail }) => {
    return await ctx.db
      .query("summaries")
      .withIndex("by_voice_settings", (q) =>
        q
          .eq("voiceMessageId", voiceMessageId)
          .eq("mode", mode)
          .eq("context", context)
          .eq("detail", detail),
      )
      .unique();
  },
});

export const store = internalMutation({
  args: {
    voiceMessageId: v.id("voiceMessages"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    // Defensive: if the row somehow already exists (concurrent inserts),
    // patch it instead of inserting a duplicate.
    const existing = await ctx.db
      .query("summaries")
      .withIndex("by_voice_settings", (q) =>
        q
          .eq("voiceMessageId", args.voiceMessageId)
          .eq("mode", args.mode)
          .eq("context", args.context)
          .eq("detail", args.detail),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { text: args.text });
      return existing._id;
    }
    return await ctx.db.insert("summaries", args);
  },
});
