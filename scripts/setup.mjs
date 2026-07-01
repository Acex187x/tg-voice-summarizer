#!/usr/bin/env node
// One-shot setup script. Reads .env.local, pushes the bot-related variables
// into the Convex deployment env, deploys functions, then asks Convex to
// register the Telegram webhook. Idempotent — re-run any time you change
// secrets in .env.local.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const envPath = resolve(root, ".env.local");

if (!existsSync(envPath)) {
  console.error(
    "No .env.local found. Copy .env.local.example to .env.local and fill it in first.",
  );
  process.exit(1);
}

// Variables we want to push from .env.local up to the Convex deployment.
// CONVEX_* are managed by Convex itself and are intentionally excluded.
const PUSH_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "ADMIN_TELEGRAM_ID",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ALLOWED_CHAT_IDS",
];

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Strip trailing inline comments after a literal " #" (Convex's own
    // .env.local has these on the deployment line — we don't push that one
    // anyway, but be safe).
    const hashIdx = value.indexOf(" #");
    if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    out[key] = value;
  }
  return out;
}

const env = parseEnvFile(readFileSync(envPath, "utf8"));

const required = ["TELEGRAM_BOT_TOKEN", "ADMIN_TELEGRAM_ID", "OPENAI_API_KEY"];
const missing = required.filter((k) => !env[k]);
if (missing.length > 0) {
  console.error(`Missing required values in .env.local: ${missing.join(", ")}`);
  console.error("Open .env.local and fill them in, then run npm run setup again.");
  process.exit(1);
}

// `--prod` to target the production deployment, otherwise the script targets
// the dev deployment from .env.local (CONVEX_DEPLOYMENT). Pass it through to
// every Convex CLI invocation below.
const targetProd = process.argv.includes("--prod");
const prodFlag = targetProd ? ["--prod"] : [];
const targetLabel = targetProd ? "production" : "dev";

console.log(`→ Pushing env vars to Convex ${targetLabel} deployment...`);
for (const key of PUSH_KEYS) {
  const value = env[key];
  if (!value) continue;
  // We use stdin to pass the value so it never lands in the shell history.
  const proc = spawnSync("npx", ["convex", "env", "set", ...prodFlag, key], {
    input: value,
    cwd: root,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (proc.status !== 0) {
    console.error(`Failed to set ${key}`);
    process.exit(proc.status ?? 1);
  }
}

console.log("→ Deploying Convex functions...");
if (targetProd) {
  execSync("npx convex deploy", { cwd: root, stdio: "inherit" });
} else {
  // `dev --once` is the dev-deployment equivalent of `deploy`.
  execSync("npx convex dev --once", { cwd: root, stdio: "inherit" });
}

console.log("→ Registering Telegram webhook...");
execSync(`npx convex run ${prodFlag.join(" ")} setup:registerWebhook`.trim(), {
  cwd: root,
  stdio: "inherit",
});

console.log("\nDone. Open a chat with your bot in Telegram and send /help.");
