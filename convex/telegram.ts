// Thin wrapper around grammY's Api client. We don't use the full Bot class
// because grammY's middleware model assumes a long-lived process — Convex
// actions are ephemeral and we want each invocation to have access to its own
// `ctx`. The Api class is stateless and uses native fetch, so it bundles into
// Convex's v8 runtime without trouble.

import { Api } from "grammy";

let cached: Api | null = null;
function api(): Api {
  if (cached) return cached;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in Convex env");
  cached = new Api(token);
  return cached;
}

type ParseMode = "Markdown" | "MarkdownV2" | "HTML";

async function rawTelegramMethod<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in Convex env");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };
  if (!res.ok || !json.ok) {
    throw new Error(
      `Telegram ${method} failed (${json.error_code ?? res.status}): ${json.description ?? res.statusText}`,
    );
  }
  return json.result as T;
}

// Inline-keyboard rows. Each entry is a callback button (data is returned
// in callback_query.data), a URL button, or a disabled button (Bot API
// 10.3 — renders as an inert grey button, used for section labels and
// already-active options). All variants accept the Bot API 9.4 styling
// fields: `style` colors the button, `icon_custom_emoji_id` shows a custom
// emoji before the text (requires bot-owner Premium or a Fragment
// username, so use sparingly).
export type InlineButtonStyle = "primary" | "success" | "danger";
interface InlineButtonBase {
  text: string;
  style?: InlineButtonStyle;
  icon_custom_emoji_id?: string;
}
export type InlineButton =
  | (InlineButtonBase & { callback_data: string })
  | (InlineButtonBase & { url: string })
  | (InlineButtonBase & { disabled: Record<string, never> });
export type InlineKeyboard = InlineButton[][];

interface SendOpts {
  replyToMessageId?: number;
  // External reply (Bot API 7.0): reply to a message living in ANOTHER
  // chat — the sent message gets a tappable quote header linking there.
  // Only meaningful together with replyToMessageId. Unlike same-chat
  // replies there is no allow_sending_without_reply escape hatch, so the
  // send FAILS if the target can't be referenced — callers must catch and
  // fall back to a plain send.
  replyToChatId?: number;
  parseMode?: ParseMode;
  inlineKeyboard?: InlineKeyboard;
}

// grammY's types don't know about style/icon/disabled yet, so the markup
// object is typed loosely on purpose.
function buildReplyMarkup(keyboard: InlineKeyboard | undefined): any {
  if (!keyboard) return undefined;
  return { inline_keyboard: keyboard };
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: SendOpts = {},
): Promise<{ message_id: number }> {
  return await api().sendMessage(chatId, text, {
    link_preview_options: { is_disabled: true },
    ...(opts.replyToMessageId !== undefined
      ? {
          reply_parameters: {
            message_id: opts.replyToMessageId,
            ...(opts.replyToChatId !== undefined
              ? // Cross-chat reply: allow_sending_without_reply is always
                // False for these per the API, so don't send it.
                { chat_id: opts.replyToChatId }
              : { allow_sending_without_reply: true }),
          },
        }
      : {}),
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    ...(opts.inlineKeyboard
      ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
      : {}),
  });
}

// Edits an existing bot message in place. Used to:
//   1. Replace the "Обрабатываю…" placeholder with progress hints.
//   2. Commit the final HTML message + inline keyboard.
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  opts: { parseMode?: ParseMode; inlineKeyboard?: InlineKeyboard } = {},
): Promise<void> {
  try {
    await api().editMessageText(chatId, messageId, text, {
      link_preview_options: { is_disabled: true },
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.inlineKeyboard
        ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
        : {}),
    });
  } catch (err) {
    // Ignore "message is not modified" — Telegram returns 400 if the new
    // text is identical to the existing one. Anything else propagates.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/message is not modified/i.test(msg)) throw err;
  }
}

// Edits only the inline keyboard of a bot message — useful for sub-picker
// navigation where the text stays the same but the buttons change.
export async function editMessageReplyMarkup(
  chatId: number,
  messageId: number,
  inlineKeyboard: InlineKeyboard | undefined,
): Promise<void> {
  try {
    await api().editMessageReplyMarkup(chatId, messageId, {
      ...(inlineKeyboard
        ? { reply_markup: buildReplyMarkup(inlineKeyboard)! }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/message is not modified/i.test(msg)) throw err;
  }
}

// Deletes a bot message. Tolerant of "message to delete not found" / "not
// modified" errors so callers can call it idempotently.
export async function deleteMessage(
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await api().deleteMessage(chatId, messageId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !/message to delete not found|message can't be deleted|not found/i.test(
        msg,
      )
    ) {
      console.warn("deleteMessage failed", msg);
    }
  }
}

// Acknowledges a callback_query. Required within ~10s of receiving one,
// otherwise the loading spinner on the user's button stays forever.
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  try {
    await api().answerCallbackQuery(callbackQueryId, {
      ...(text ? { text } : {}),
      show_alert: showAlert,
    });
  } catch (err) {
    // Old / already-answered callback queries throw — not actionable.
    console.warn(
      "answerCallbackQuery failed",
      err instanceof Error ? err.message : err,
    );
  }
}

// Bot API 10.0 guest mode. grammY may lag behind the newest Bot API types, so
// this uses the raw HTTP endpoint directly.
export async function answerGuestQuery(
  guestQueryId: string,
  result: Record<string, unknown>,
): Promise<{ message_id?: number; inline_message_id?: string }> {
  return await rawTelegramMethod("answerGuestQuery", {
    guest_query_id: guestQueryId,
    result,
  });
}

export async function editGuestMessageText(
  inlineMessageId: string,
  text: string,
  opts: { parseMode?: ParseMode; inlineKeyboard?: InlineKeyboard } = {},
): Promise<void> {
  try {
    await rawTelegramMethod("editMessageText", {
      inline_message_id: inlineMessageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.inlineKeyboard
        ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/message is not modified/i.test(msg)) throw err;
  }
}

// ---- Reactions (Bot API 7.0+) ---------------------------------------------

export interface ReactionSpec {
  type: "emoji" | "custom_emoji";
  value: string; // emoji char or custom_emoji_id
}

// Sets (or clears, when reaction is omitted) the bot's reaction on a
// message. Bots get one reaction per message. Plain emoji must be from
// Telegram's allowed reaction set; custom emoji work when the chat allows
// them (or the reaction is already present on the message). Note that
// automatically forwarded channel posts inherit the CHANNEL's allowed
// reactions, so this can legitimately fail there — callers treat that as
// soft. Returns whether Telegram accepted the reaction.
export async function setMessageReaction(
  chatId: number,
  messageId: number,
  reaction?: ReactionSpec,
): Promise<boolean> {
  try {
    await rawTelegramMethod("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: reaction
        ? [
            reaction.type === "emoji"
              ? { type: "emoji", emoji: reaction.value }
              : { type: "custom_emoji", custom_emoji_id: reaction.value },
          ]
        : [],
    });
    return true;
  } catch (err) {
    console.warn(
      "setMessageReaction failed",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// ---- Ephemeral messages (Bot API 10.2, params updated in 10.3) ------------

// Sends a message visible only to `receiverUserId` in a group chat.
// Conditions (per Bot API docs):
//   • any bot — within 15s of a callback query (pass callbackQueryId) or
//     of an incoming ephemeral message (pass replyToEphemeralMessageId);
//   • admin bot — to any non-bot member at any time, no trigger needed.
// Ephemeral messages have message_id 0; the real handle is
// ephemeral_message_id. Returns null on failure so callers can fall back
// to a regular send.
//
// IMPORTANT: Bot API 10.3 (2026-08-24) REMOVED the top-level
// receiver_user_id / callback_query_id parameters in favor of the
// ephemeral_message_parameters object. With the old parameters Telegram
// silently ignores the unknown fields and the "ephemeral" message goes out
// as a regular public message — that's the regression that broke the
// reaction → ephemeral-summary flow.
export async function sendEphemeralMessage(
  chatId: number,
  receiverUserId: number,
  text: string,
  opts: {
    callbackQueryId?: string;
    // Show the ephemeral message in place of the callback's source
    // message (only valid for callbacks from regular messages).
    replaceCallbackQueryMessage?: boolean;
    replyToEphemeralMessageId?: number;
    parseMode?: ParseMode;
    inlineKeyboard?: InlineKeyboard;
  } = {},
): Promise<{ ephemeral_message_id?: number } | null> {
  try {
    const result = await rawTelegramMethod<{
      message_id: number;
      ephemeral_message_id?: number;
    }>("sendMessage", {
      chat_id: chatId,
      ephemeral_message_parameters: {
        receiver_user_id: receiverUserId,
        ...(opts.callbackQueryId
          ? { callback_query_id: opts.callbackQueryId }
          : {}),
        ...(opts.replaceCallbackQueryMessage
          ? { replace_callback_query_message: true }
          : {}),
      },
      text,
      link_preview_options: { is_disabled: true },
      ...(opts.replyToEphemeralMessageId !== undefined
        ? {
            reply_parameters: {
              ephemeral_message_id: opts.replyToEphemeralMessageId,
            },
          }
        : {}),
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.inlineKeyboard
        ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
        : {}),
    });
    return { ephemeral_message_id: result.ephemeral_message_id };
  } catch (err) {
    console.warn(
      "sendEphemeralMessage failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export async function editEphemeralMessageText(
  chatId: number,
  receiverUserId: number,
  ephemeralMessageId: number,
  text: string,
  opts: { parseMode?: ParseMode; inlineKeyboard?: InlineKeyboard } = {},
): Promise<boolean> {
  try {
    await rawTelegramMethod("editEphemeralMessageText", {
      chat_id: chatId,
      receiver_user_id: receiverUserId,
      ephemeral_message_id: ephemeralMessageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.inlineKeyboard
        ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
        : {}),
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/message is not modified/i.test(msg)) return true;
    console.warn("editEphemeralMessageText failed", msg);
    return false;
  }
}

export async function deleteEphemeralMessage(
  chatId: number,
  receiverUserId: number,
  ephemeralMessageId: number,
): Promise<void> {
  try {
    await rawTelegramMethod("deleteEphemeralMessage", {
      chat_id: chatId,
      receiver_user_id: receiverUserId,
      ephemeral_message_id: ephemeralMessageId,
    });
  } catch (err) {
    console.warn(
      "deleteEphemeralMessage failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Registers the bot's command list. Commands marked ephemeral are
// invisible in the chat when sent (Bot API 10.2 BotCommand.is_ephemeral)
// and let the bot answer ephemerally without being an admin.
export async function setMyCommands(
  commands: Array<{
    command: string;
    description: string;
    is_ephemeral?: boolean;
  }>,
): Promise<void> {
  await rawTelegramMethod("setMyCommands", { commands });
}

// ---- Business mode (Bot API 7.2+) -----------------------------------------

// Sends a message INTO a managed private conversation on behalf of the
// connected business account (the peer sees it as coming from the owner,
// with the bot badge). Used for the per-conversation "auto-send transcript
// of my outgoing voices" toggle.
export async function sendBusinessMessage(
  businessConnectionId: string,
  chatId: number,
  text: string,
  opts: { replyToMessageId?: number; parseMode?: ParseMode } = {},
): Promise<{ message_id: number }> {
  return await rawTelegramMethod("sendMessage", {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(opts.replyToMessageId !== undefined
      ? {
          reply_parameters: {
            message_id: opts.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
  });
}

// "typing…" indicator while the Q&A model thinks.
export async function sendChatAction(
  chatId: number,
  action = "typing",
): Promise<void> {
  try {
    await rawTelegramMethod("sendChatAction", { chat_id: chatId, action });
  } catch {
    // cosmetic, ignore
  }
}

// ---- Rich messages (Bot API 10.1+) ----------------------------------------

// Rich messages allow up to 32768 UTF-8 chars; leave headroom the same way
// TG_TEXT_LIMIT does for classic messages.
export const RICH_TEXT_LIMIT = 32000;

// Sends a rich message with markdown content (GFM-compatible "Rich
// Markdown": headings, tables, <details> collapsible blocks, …). grammY
// doesn't know about Bot API 10.1 yet, so this goes through the raw HTTP
// endpoint. Callers should be prepared to fall back to classic HTML
// messages on error — old-client rendering of rich messages is
// undocumented and server-side validation is stricter than parse_mode.
export async function sendRichMarkdownMessage(
  chatId: number,
  markdown: string,
  opts: { replyToMessageId?: number; inlineKeyboard?: InlineKeyboard } = {},
): Promise<{ message_id: number }> {
  return await rawTelegramMethod("sendRichMessage", {
    chat_id: chatId,
    rich_message: { markdown },
    ...(opts.replyToMessageId !== undefined
      ? {
          reply_parameters: {
            message_id: opts.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
    ...(opts.inlineKeyboard
      ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
      : {}),
  });
}

// Edits an existing (plain or rich) bot message into a rich message.
// editMessageText accepts rich_message as an alternative to text.
export async function editIntoRichMarkdownMessage(
  chatId: number,
  messageId: number,
  markdown: string,
  opts: { inlineKeyboard?: InlineKeyboard } = {},
): Promise<void> {
  try {
    await rawTelegramMethod("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      rich_message: { markdown },
      ...(opts.inlineKeyboard
        ? { reply_markup: buildReplyMarkup(opts.inlineKeyboard)! }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/message is not modified/i.test(msg)) throw err;
  }
}

// Escapes text that goes into rich markdown as plain prose (transcripts).
// Rich markdown may contain arbitrary HTML, so raw < / & could be parsed
// as tags — and it's GFM, so spoken "*", "_", "#" etc. would otherwise
// turn into formatting. GFM honors backslash escapes.
export function escapeRichText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/([*_`[\]~|])/g, "\\$1")
    .replace(/^([#>+\-=])/gm, "\\$1");
}

// Converts our summary-markdown conventions into Rich Markdown. The `> `
// quote blocks that classic rendering turns into expandable blockquotes
// become collapsed <details> blocks here — same "expand for the long
// version" affordance, native to rich messages.
export function summaryMarkdownToRichMarkdown(
  md: string,
  detailsLabel = "Подробнее",
): string {
  const out: string[] = [];
  let quote: string[] | null = null;
  const flushQuote = () => {
    if (quote !== null) {
      out.push(
        `<details><summary>${detailsLabel}</summary>`,
        "",
        ...quote,
        "",
        "</details>",
      );
      quote = null;
    }
  };
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*>\s?(.*)$/);
    if (m) {
      (quote ??= []).push(m[1]);
    } else {
      flushQuote();
      out.push(line);
    }
  }
  flushQuote();
  return out.join("\n");
}

// Markdown-level counterpart of resolveMessageLinks: rewrites
// `[text](msg:12345)` targets into t.me deep links before the markdown is
// handed to sendRichMessage.
export function resolveMessageLinksMarkdown(
  md: string,
  chatId: number,
): string {
  const channelId = String(chatId).replace(/^-100/, "");
  return md.replace(
    /\]\(msg:(\d+)\)/g,
    (_m, msgId: string) => `](https://t.me/c/${channelId}/${msgId})`,
  );
}

// Looks up our own bot username via getMe so we can build deep-link URLs
// like t.me/<username>?start=… for group reply buttons.
export async function getMe(): Promise<{
  id: number;
  username: string | undefined;
  first_name: string;
}> {
  const me = await api().getMe();
  return { id: me.id, username: me.username, first_name: me.first_name };
}

// Telegram's hard text limit per message is 4096 chars; we leave some
// headroom for HTML wrappers (e.g. <blockquote expandable>…</blockquote>).
export const TG_TEXT_LIMIT = 4000;

// Splits text into chunks that fit Telegram's limit. Tries to break on
// double newlines (paragraph), then single newlines, then spaces, and only
// hard-cuts as a last resort. Doesn't try to keep HTML tags balanced —
// callers should split content where tags are unlikely to span (line
// boundaries are usually fine).
export function splitTextSafely(
  text: string,
  maxLen: number = TG_TEXT_LIMIT,
): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen; // no good boundary; hard-cut
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// Post-processing pass for splitHtmlSafely: makes every chunk
// independently well-formed HTML. A cut point chosen by splitTextSafely
// can land inside an inline tag pair (<b>, <i>, <a href>…), inside a tag
// itself, or inside an entity — any of which is a hard 400 from Telegram.
// Partial tags/entities at a cut are moved to the next chunk; tags left
// open at a chunk boundary are closed at its end and reopened (with their
// original attributes) at the start of the next chunk.
function repairHtmlChunks(chunks: string[]): string[] {
  const out: string[] = [];
  let carry: Array<{ name: string; open: string }> = [];
  let partial = "";
  for (const raw of chunks) {
    let chunk = partial + raw;
    partial = "";
    // Tag cut mid-way: a `<` after the last `>`.
    const lastLt = chunk.lastIndexOf("<");
    if (lastLt > chunk.lastIndexOf(">")) {
      partial = chunk.slice(lastLt);
      chunk = chunk.slice(0, lastLt);
    }
    // Entity cut mid-way: a short trailing `&…` run without its `;`.
    const entity = chunk.match(/&[a-zA-Z0-9#]{0,9}$/);
    if (entity) {
      partial = entity[0] + partial;
      chunk = chunk.slice(0, chunk.length - entity[0].length);
    }
    const prefix = carry.map((t) => t.open).join("");
    const stack = carry.slice();
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s[^<>]*)?)>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(chunk)) !== null) {
      const name = m[2].toLowerCase();
      if (m[1] !== "/") {
        stack.push({ name, open: m[0] });
      } else {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) {
            stack.splice(i, 1);
            break;
          }
        }
      }
    }
    const suffix = stack
      .slice()
      .reverse()
      .map((t) => `</${t.name}>`)
      .join("");
    out.push(prefix + chunk + suffix);
    carry = stack;
  }
  return out.filter((c) => c.trim().length > 0);
}

// Splits already-rendered Telegram HTML into chunks that fit the limit
// WITHOUT tearing <blockquote> tags apart (a torn tag is a hard 400 from
// the API). Text between quotes splits on the usual soft boundaries; a
// quote that fits goes into a chunk whole; an oversized quote is split by
// content and each part gets its own open/close tags. A final repair pass
// closes/reopens inline tags cut at chunk boundaries, so every emitted
// chunk is well-formed on its own.
export function splitHtmlSafely(
  html: string,
  maxLen: number = TG_TEXT_LIMIT,
): string[] {
  if (html.length <= maxLen) return [html];
  const OPEN = "<blockquote expandable>";
  const CLOSE = "</blockquote>";

  type Unit = { kind: "text" | "quote"; content: string };
  const units: Unit[] = [];
  const re = /<blockquote(?:\s+expandable)?>([\s\S]*?)<\/blockquote>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last)
      units.push({ kind: "text", content: html.slice(last, m.index) });
    units.push({ kind: "quote", content: m[1] });
    last = m.index + m[0].length;
  }
  if (last < html.length)
    units.push({ kind: "text", content: html.slice(last) });

  const chunks: string[] = [];
  let cur = "";
  const append = (piece: string) => {
    if (piece.length === 0) return;
    if (cur.length + piece.length <= maxLen) {
      cur += piece;
      return;
    }
    if (cur.trim().length > 0) chunks.push(cur.trimEnd());
    cur = piece.replace(/^\n+/, "");
  };
  for (const unit of units) {
    if (unit.kind === "text") {
      for (const part of splitTextSafely(unit.content, maxLen)) append(part);
    } else {
      const wrapped = `${OPEN}${unit.content}${CLOSE}`;
      if (wrapped.length <= maxLen) {
        append(wrapped);
      } else {
        const budget = maxLen - OPEN.length - CLOSE.length;
        for (const part of splitTextSafely(unit.content, budget)) {
          append(`${OPEN}${part}${CLOSE}`);
        }
      }
    }
  }
  if (cur.trim().length > 0) chunks.push(cur.trimEnd());
  return repairHtmlChunks(chunks.length > 0 ? chunks : [html.slice(0, maxLen)]);
}

// Custom emoji used as a loading spinner in status messages. Rendered via
// Telegram's <tg-emoji> HTML tag (Bot API 5.6+, available to any bot that
// is allowed to use premium/custom emoji). Non-premium users fall back to
// the inner plain-unicode character.
// https://core.telegram.org/bots/api#html-style
export const LOADING_CUSTOM_EMOJI_ID = "5325792861885570739";
export function loadingEmoji(fallback = "⏳"): string {
  return `<tg-emoji emoji-id="${LOADING_CUSTOM_EMOJI_ID}">${fallback}</tg-emoji>`;
}

// Replaces `msg:MESSAGE_ID` hrefs (emitted by markdownToTelegramHtml from
// the LLM's `[text](msg:12345)` links) with real Telegram deep-links. For
// private supergroups the format is `https://t.me/c/CHANNEL_ID/MSG_ID`
// where CHANNEL_ID is the numeric chat id with the `-100` prefix stripped.
export function resolveMessageLinks(html: string, chatId: number): string {
  const channelId = String(chatId).replace(/^-100/, "");
  return html.replace(
    /href="msg:(\d+)"/g,
    (_match, msgId: string) => `href="https://t.me/c/${channelId}/${msgId}"`,
  );
}

// HTML escape for the Telegram HTML parse mode. Telegram's HTML mode only
// recognizes a tiny set of tags, so escaping <, >, & is sufficient and we
// don't have to worry about ", '.
// https://core.telegram.org/bots/api#html-style
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Convert GitHub-flavored markdown (what LLMs naturally emit) into the
// limited HTML subset that Telegram understands. The pipeline:
//   1. Stash code blocks and inline code so later regexes can't mangle them.
//   2. HTML-escape what's left.
//   3. Re-apply formatting via regex (bold, italic, links, headings…).
//   4. Restore the stashed code.
//
// We deliberately don't try to render lists — Telegram HTML has no list
// tags, so `- foo` and `1. bar` are left as plain text, which renders fine.
//
// Telegram HTML reference: https://core.telegram.org/bots/api#html-style
export function markdownToTelegramHtml(text: string): string {
  const slots: string[] = [];
  const stash = (html: string): string => {
    const idx = slots.push(html) - 1;
    return `\u0000SLOT${idx}\u0000`;
  };

  // 1a. Triple-backtick code blocks. ``` lang\ncode\n``` and plain ```code```.
  let s = text.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const inner = escapeHtml(code.replace(/\n$/, ""));
      return stash(
        lang
          ? `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>`
          : `<pre>${inner}</pre>`,
      );
    },
  );

  // 1b. Inline code: `code`.
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  // 2. Escape any remaining HTML special chars in the non-code text.
  s = escapeHtml(s);

  // 3a. Bold: **text** and __text__.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<!\w)__([^_\n]+?)__(?!\w)/g, "<b>$1</b>");

  // 3b. Italic: *text* and _text_ — single tokens only, must not be inside
  // a word so we don't break `snake_case` identifiers in plain prose.
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<i>$1</i>");
  s = s.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "<i>$1</i>");

  // 3c. Strikethrough: ~~text~~.
  s = s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");

  // 3d. Links: [text](url). Telegram supports plain http/https hrefs.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

  // 3e. Headings: # … ###### become bold.
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, "<b>$1</b>");

  // 3f. Blockquotes: runs of consecutive `> `-prefixed lines (escaped to
  // `&gt;` by step 2) collapse into a single expandable blockquote. This
  // is how summary prompts mark "details the reader expands on demand".
  {
    const out: string[] = [];
    let quote: string[] | null = null;
    const flushQuote = () => {
      if (quote !== null) {
        out.push(`<blockquote expandable>${quote.join("\n")}</blockquote>`);
        quote = null;
      }
    };
    for (const line of s.split("\n")) {
      const m = line.match(/^\s*&gt;\s?(.*)$/);
      if (m) {
        (quote ??= []).push(m[1]);
      } else {
        flushQuote();
        out.push(line);
      }
    }
    flushQuote();
    s = out.join("\n");
  }

  // 4. Restore stashed code spans.
  s = s.replace(
    /\u0000SLOT(\d+)\u0000/g,
    (_m, idx: string) => slots[Number(idx)],
  );

  return s;
}

// Telegram caps text messages at 4096 chars. Split on a safe boundary so we
// don't get a 400 from the API on long summaries.
export async function sendLongMessage(
  chatId: number,
  text: string,
  opts: { replyToMessageId?: number } = {},
): Promise<{ message_id: number }> {
  const MAX = 4000;
  if (text.length <= MAX) return await sendMessage(chatId, text, opts);
  let first: { message_id: number } | undefined;
  for (let i = 0; i < text.length; i += MAX) {
    const chunk = text.slice(i, i + MAX);
    const reply = await sendMessage(chatId, chunk, i === 0 ? opts : {});
    if (!first) first = reply;
  }
  return first!;
}

export async function getFilePath(fileId: string): Promise<string> {
  const file = await api().getFile(fileId);
  if (!file.file_path)
    throw new Error("Telegram returned a file without a file_path");
  return file.file_path;
}

export async function downloadFile(filePath: string): Promise<Blob> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const res = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
  );
  if (!res.ok) {
    throw new Error(
      `Failed to download voice file: ${res.status} ${res.statusText}`,
    );
  }
  return await res.blob();
}

// Used by setup.ts for setWebhook / getWebhookInfo. Returns the raw result
// from grammY so callers can read whatever fields they need.
export async function setWebhook(opts: {
  url: string;
  secret_token: string;
}): Promise<boolean> {
  return await api().setWebhook(opts.url, {
    secret_token: opts.secret_token,
    // IMPORTANT: callback_query MUST be in this list, otherwise Telegram
    // silently drops inline-keyboard button presses (the DM picker stops
    // working). Re-run `npm run setup` whenever you change this list, the
    // change is only picked up by setWebhook.
    allowed_updates: [
      "message",
      "edited_message",
      "business_connection",
      "business_message",
      "edited_business_message",
      "guest_message",
      "callback_query",
      // Quiet mode: reaction on a voice → ephemeral summary. Telegram
      // only delivers these when the bot is a chat admin.
      "message_reaction",
    ] as any,
    drop_pending_updates: false,
  });
}

export async function getWebhookInfo(): Promise<{ url: string }> {
  const info = await api().getWebhookInfo();
  return { url: info.url ?? "" };
}
