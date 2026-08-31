import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { getMe, setMyCommands, setWebhook } from "./telegram";

// Idempotent webhook registration. Computes the webhook URL from
// CONVEX_SITE_URL (set automatically by Convex), generates a stable secret
// derived from the bot token, and only calls Telegram if the URL changed.
export const registerWebhook = internalAction({
  args: {},
  // Explicit return annotation breaks the otherwise-circular type inference
  // between this action and the api types it references via ctx.runQuery.
  handler: async (ctx): Promise<{ webhookUrl: string; registered: boolean }> => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) {
      throw new Error("CONVEX_SITE_URL is not set (Convex normally sets this automatically)");
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set in Convex env");
    }

    const webhookUrl = `${siteUrl.replace(/\/$/, "")}/telegram`;
    // Stable secret derived from the bot token. Re-deriving on every run
    // means we never need to persist the raw secret anywhere outside Convex.
    const secret = await deriveSecret(token);

    // Tell our HTTP handler what to expect.
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;

    // Always re-call setWebhook. It's idempotent on Telegram's side and
    // it's the only way to push changes to the `allowed_updates` list (or
    // the secret) — we tried caching this once and forgot to invalidate
    // when adding callback_query, which silently broke the DM picker.
    // The hourly cron pays one extra Telegram API call per run; trivial.
    await setWebhook({ url: webhookUrl, secret_token: secret });
    await ctx.runMutation(internal.botConfig.setWebhook, {
      webhookUrl,
      webhookSecret: secret,
    });

    // Command list. Settings commands are ephemeral (Bot API 10.2): the
    // command message itself is invisible in the chat and the bot can
    // answer ephemerally without admin rights.
    try {
      await setMyCommands([
        { command: "summary", description: "Summary переписки за период" },
        { command: "search", description: "Поиск по истории чата" },
        {
          command: "settings",
          description: "Настройки бота в этом чате",
          is_ephemeral: true,
        },
        {
          command: "reaction",
          description: "Сменить реакцию-триггер",
          is_ephemeral: true,
        },
        {
          command: "modal",
          description: "Выбрать модель суммаризации",
          is_ephemeral: true,
        },
        {
          command: "quiet",
          description: "Режим «по требованию» вкл/выкл",
          is_ephemeral: true,
        },
      ]);
    } catch (err) {
      console.warn("setMyCommands failed during registerWebhook", err);
    }

    // Always re-fetch the bot username — it's cheap and self-heals if it
    // changes (e.g. admin renames the bot at @BotFather).
    try {
      const me = await getMe();
      if (me.username) {
        await ctx.runMutation(internal.botConfig.setBotUsername, {
          username: me.username,
        });
      }
    } catch (err) {
      console.warn("getMe failed during registerWebhook", err);
    }

    return { webhookUrl, registered: true };
  },
});

// Cron-driven self-heal. Cheap call: usually no-op.
export const ensureWebhook = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!process.env.TELEGRAM_BOT_TOKEN) return; // not configured yet
    try {
      await ctx.runAction(internal.setup.registerWebhook, {});
    } catch (err) {
      console.error("ensureWebhook failed", err);
    }
  },
});

// SHA-256(token + "::tg-voice-summarizer-secret") truncated to 48 hex chars.
// Telegram allows A-Z a-z 0-9 _ - up to 256 chars.
async function deriveSecret(token: string): Promise<string> {
  const data = new TextEncoder().encode(`${token}::tg-voice-summarizer-secret`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}
