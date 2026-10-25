// Classifies pipeline failures so that (a) chat members see a short human
// message instead of a raw provider error, and (b) the admin only gets a
// DM for things they can act on — not for every rate-limit blip.

export type FailureKind =
  // Out of credits / bad key / model gone: needs the admin.
  | "actionable"
  // Rate limits, 5xx, timeouts, flaky provider bodies: retry later.
  | "transient"
  // Telegram refused an edit/send (message deleted, flood control).
  | "telegram"
  // Anything we haven't seen before.
  | "unknown";

export interface Failure {
  kind: FailureKind;
  // Groups identical failures for throttling: "openrouter:x-ai/grok-4.7:402".
  key: string;
}

export function classifyFailure(message: string): Failure {
  const status = message.match(/\b([1-5]\d\d)\b/)?.[1] ?? "";
  const model =
    message.match(/model=([\w./:-]+)/)?.[1] ??
    message.match(/\((?:provider=\w+ )?model=([^)]+)\)/)?.[1] ??
    "";
  const provider = message.match(/provider=(\w+)/)?.[1] ?? "";
  const where = [provider, model].filter(Boolean).join(":") || "pipeline";

  if (
    /is not set in Convex env|insufficient_quota|exceeded your current quota|billing|credits|Insufficient/i.test(
      message,
    ) ||
    ["401", "402", "403", "404"].includes(status)
  ) {
    return { kind: "actionable", key: `actionable:${where}:${status}` };
  }
  if (/Call to '\w+' failed|Telegram/i.test(message)) {
    return { kind: "telegram", key: `telegram:${status}` };
  }
  if (
    ["408", "409", "425", "429", "500", "502", "503", "504", "520", "524", "529"].includes(status) ||
    /timeout|timed out|aborted|ECONNRESET|fetch failed|no choices|empty response|provider error|overloaded|rate limit/i.test(
      message,
    )
  ) {
    return { kind: "transient", key: `transient:${where}` };
  }
  return { kind: "unknown", key: `unknown:${where}:${message.slice(0, 40)}` };
}

// What the chat sees in place of the summary. No internals, no stack.
export function userFacingFailureText(kind: FailureKind): string {
  return kind === "transient"
    ? "😵 Не получилось обработать — сервис перегружен. Тегни меня ответом на войс, попробую ещё раз."
    : "😵 Не получилось обработать это сообщение. Тегни меня ответом на войс, чтобы попробовать ещё раз.";
}

// Admin DM throttling. Actionable/unknown failures alert at most once per
// key per ALERT_COOLDOWN_MS; transient ones only when they pile up
// (TRANSIENT_ALERT_COUNT within an hour), which means a real outage.
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const ALERT_WINDOW_MS = 60 * 60 * 1000;
export const TRANSIENT_ALERT_COUNT = 5;

export function shouldAlert(
  kind: FailureKind,
  countInWindow: number,
  lastSentAt: number | undefined,
  now: number,
): boolean {
  if (kind === "telegram") return false;
  const cooledDown =
    lastSentAt === undefined || now - lastSentAt > ALERT_COOLDOWN_MS;
  if (!cooledDown) return false;
  if (kind === "transient") return countInWindow >= TRANSIENT_ALERT_COUNT;
  return true;
}
