import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// Telegram webhook endpoint. We answer 200 immediately and process the
// update in a background internal action so the bot stays responsive.
http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const got = request.headers.get("x-telegram-bot-api-secret-token");
      if (got !== expectedSecret) {
        return new Response("forbidden", { status: 403 });
      }
    }

    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    await ctx.scheduler.runAfter(0, internal.bot.handleUpdate, { update });
    return new Response("ok", { status: 200 });
  }),
});

// Manually triggerable endpoint that re-registers the webhook with Telegram.
// Useful as a smoke test from a browser; the cron + the post-deploy script
// also call the same internal action.
http.route({
  path: "/setup",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const result = await ctx.runAction(internal.setup.registerWebhook, {});
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
