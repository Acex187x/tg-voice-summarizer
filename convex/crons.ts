import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Self-heal: re-register the Telegram webhook periodically. Cheap no-op when
// the URL hasn't changed; ensures the bot keeps working after deploys, env
// changes, or accidental webhook resets via @BotFather.
crons.interval(
  "ensure telegram webhook",
  { hours: 1 },
  internal.setup.ensureWebhook,
);

export default crons;
