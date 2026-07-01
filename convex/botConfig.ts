import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// botConfig now only stores runtime knobs that genuinely need to live in
// the database:
//   • webhook URL/secret cached for the cron self-heal
//   • bot username (fetched from getMe at registerWebhook time)
//   • debug mode (toggled via /debug in Telegram)
//
// Model selection (which provider/model for each pipeline stage) lives
// in `convex/models.ts` as plain TypeScript constants. Swap a model →
// edit that file → `npx convex dev --once`.

export const get = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("botConfig").first();
  },
});

export const getDebugMode = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const row = await ctx.db.query("botConfig").first();
    return row?.debugMode ?? false;
  },
});

async function ensureRow(ctx: any) {
  const existing = await ctx.db.query("botConfig").first();
  if (existing) return existing;
  const id = await ctx.db.insert("botConfig", {});
  return await ctx.db.get(id);
}

export const setWebhook = internalMutation({
  args: {
    webhookUrl: v.string(),
    webhookSecret: v.string(),
  },
  handler: async (ctx, { webhookUrl, webhookSecret }) => {
    const row = await ensureRow(ctx);
    await ctx.db.patch(row._id, {
      webhookUrl,
      webhookSecret,
      webhookRegisteredAt: Date.now(),
    });
  },
});

export const setBotUsername = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const row = await ensureRow(ctx);
    await ctx.db.patch(row._id, { botUsername: username });
  },
});

export const getBotUsername = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | undefined> => {
    const row = await ctx.db.query("botConfig").first();
    return row?.botUsername;
  },
});

// Toggles debug mode and returns the new state, so the bot can echo the
// resulting value back to the admin without an extra query.
export const toggleDebugMode = internalMutation({
  args: { value: v.optional(v.boolean()) },
  handler: async (ctx, { value }): Promise<boolean> => {
    const row = await ensureRow(ctx);
    const next = value ?? !row.debugMode;
    await ctx.db.patch(row._id, { debugMode: next });
    return next;
  },
});
