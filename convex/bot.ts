import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { TRANSCRIBE_MODEL } from "./models";
import { transcribeAudio } from "./openai";
import {
  buildChatLogFor,
  buildChatSummaryButton,
  buildOpenInBotKeyboard,
  commitFinal,
  getOrGenerateChatSummary,
  getOrGenerateSummary,
  getOrGenerateSummaryStreaming,
  renderChatSummaryFinal,
  renderFinal,
  resolveVoiceSettings,
} from "./processing";
import {
  ALL_CONTEXT_KEYS,
  ALL_DETAILS,
  ALL_MODE_KEYS,
  AUTO_LABEL,
  CONTEXTS,
  contextLabel,
  DETAIL_LEVELS,
  isContextKey,
  isDetail,
  isModeKey,
  MODES,
  modeLabel,
  type ContextKey,
  type Detail,
  type ModeKey,
} from "./prompts";
import {
  answerGuestQuery,
  answerCallbackQuery,
  deleteMessage,
  downloadFile,
  editGuestMessageText,
  editMessageReplyMarkup,
  editMessageText,
  escapeHtml,
  getFilePath,
  loadingEmoji,
  markdownToTelegramHtml,
  resolveMessageLinks,
  sendMessage,
  splitTextSafely,
  TG_TEXT_LIMIT,
  type InlineKeyboard,
} from "./telegram";

// Minimal Telegram update typing — only the fields we read.
type TgUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};
type TgChat = { id: number; type: string; title?: string; username?: string };
type TgBusinessConnection = {
  id: string;
  user?: TgUser;
  user_chat_id: number;
  date: number;
  rights?: unknown;
  is_enabled: boolean;
};
type TgVoice = { file_id: string; duration: number };
type TgAudio = { file_id: string; duration: number };
type TgVideoNote = { file_id: string; duration: number; length?: number };
type TgPhotoSize = { file_id: string };
type TgVideo = { file_id: string };
type TgDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};
type TgSticker = { file_id: string };
type TgMessage = {
  message_id: number;
  date?: number;
  business_connection_id?: string;
  guest_query_id?: string;
  guest_bot_caller_user?: TgUser;
  guest_bot_caller_chat?: TgChat;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  voice?: TgVoice;
  audio?: TgAudio;
  video_note?: TgVideoNote;
  photo?: TgPhotoSize[];
  video?: TgVideo;
  document?: TgDocument;
  sticker?: TgSticker;
  reply_to_message?: TgMessage;
};
type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};
type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  business_connection?: TgBusinessConnection;
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  guest_message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

// ---- Env helpers ----------------------------------------------------------

function getAdminId(): number | null {
  const raw = process.env.ADMIN_TELEGRAM_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getAllowedChatIds(): Set<number> | null {
  const raw = process.env.ALLOWED_CHAT_IDS;
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? new Set(ids) : null;
}

// ---- Help text -----------------------------------------------------------

const HELP_TEXT = `Команды админа:

/defaults — показать/изменить дефолтные настройки summary для этого чата
/debug [on|off] — дебаг-режим
/whoami — ваш Telegram ID и ID этого чата
/summarize — ответьте этой командой на голосовое или видеокружок, чтобы пересобрать summary
/search <запрос> — найти сообщения в истории чата по смыслу
/ask <вопрос> — коротко ответить на вопрос по истории чата с доказательными ссылками
/importdump — загрузить Telegram JSON export (result.json) и проиндексировать историю
/indexstats — статистика покрытия БД и векторного индекса для этого чата
/indexstats rebuild — пересобрать сохранённые счётчики
/reindex — переиндексировать сохранённые сообщения этого чата
/help — это сообщение

Стили, контексты, уровни детальности и LLM-модели заданы в коде:
  convex/prompts.ts — стили / контексты / промты
  convex/models.ts  — какие модели на каждом этапе пайплайна`;

// ---- Top-level update dispatcher ------------------------------------------

export const handleUpdate = internalAction({
  args: { update: v.any() },
  handler: async (ctx, { update }) => {
    const u = update as TgUpdate;

    // 1. Inline-keyboard button presses — the picker lives here. These are
    //    allowed for any user (non-admin included) because the group-chat
    //    "Открыть в боте" button leads non-authors into the DM picker.
    if (u.callback_query) {
      await handleCallback(ctx, u.callback_query);
      return;
    }

    if (u.business_connection) {
      await handleBusinessConnection(ctx, u.business_connection);
      return;
    }

    const businessMessage = u.business_message ?? u.edited_business_message;
    if (businessMessage) {
      await handleBusinessMessage(ctx, businessMessage);
      return;
    }

    if (u.guest_message) {
      await handleGuestMessage(ctx, u.guest_message);
      return;
    }

    const message = u.message ?? u.edited_message;
    if (!message) return;

    const adminId = getAdminId();
    const fromId = message.from?.id;
    const isAdmin = adminId !== null && fromId === adminId;
    const isPrivateChat = message.chat.type === "private";

    // 0. Persist every group message into chatMessages so /summary can
    //    pull a time range later. Voice/audio/video-note rows are linked
    //    to their voiceMessages.shortId once that exists. Also kick off
    //    a background memory refresh for the chat (the action itself
    //    self-deduplicates by lastUpdatedAt — so this is essentially
    //    free if we're inside the 6h window).
    if (!isPrivateChat) {
      const chatMessageId = await storeChatMessage(ctx, message);
      await ctx.scheduler.runAfter(0, internal.vectorSearch.indexChatMessage, {
        chatMessageId,
      });
      await ctx.scheduler.runAfter(0, internal.processing.refreshChatMemory, {
        chatId: message.chat.id,
      });
    }

    // 2. Voice / audio / video_note messages.
    const media = extractMedia(message);
    if (media) {
      if (isPrivateChat) {
        // In the private chat with the bot, only the admin gets new
        // voices processed. (Non-admins arrive here via /start deep links
        // and interact with the picker, not by sending their own voices.)
        if (!isAdmin) {
          await sendMessage(
            message.chat.id,
            "Этот бот работает только для администратора.",
            {},
          );
          return;
        }
        await handleVoice(ctx, message, media);
        return;
      }
      // Group / supergroup / channel: respect the allowlist.
      const allowed = getAllowedChatIds();
      if (allowed && !allowed.has(message.chat.id)) return;
      await handleVoice(ctx, message, media);
      return;
    }

    const commandText = message.text ?? message.caption;
    if (!commandText) return;

    // 3. /start with a deep-link payload — allowed for ANY user.
    //    Format: `/start v<shortId>` for a voice, `/start c<shortId>` for
    //    a chat summary.
    const startPayload = parseStartPayload(commandText);
    if (startPayload) {
      if (startPayload.startsWith("v")) {
        await handleVoiceDeepLink(ctx, message, startPayload.slice(1));
        return;
      }
      if (startPayload.startsWith("c")) {
        await handleChatSummaryDeepLink(ctx, message, startPayload.slice(1));
        return;
      }
    }

    // 3a. /summary (+ shortcuts /s, /sum) — anyone in a group can run it.
    if (
      !isPrivateChat &&
      /^\/(?:s|sum|summary)(?:@[\w_]+)?(?:\s|$)/i.test(commandText)
    ) {
      await handleSummaryCommand(ctx, message);
      return;
    }

    if (
      !isPrivateChat &&
      /^\/(?:search|ask)(?:@[\w_]+)?(?:\s|$)/i.test(commandText)
    ) {
      await handleSearchCommand(ctx, message, commandText);
      return;
    }

    if (/^\/importdump(?:@[\w_]+)?(?:\s|$)/i.test(commandText)) {
      if (!isAdmin) {
        if (isPrivateChat) {
          await sendMessage(
            message.chat.id,
            "Этот бот предназначен только для администратора.",
            {},
          );
        }
        return;
      }
      await handleImportDumpCommand(ctx, message);
      return;
    }

    if (!isPrivateChat && /^\/reindex(?:@[\w_]+)?(?:\s|$)/i.test(commandText)) {
      if (!isAdmin) return;
      await handleReindexCommand(ctx, message);
      return;
    }

    if (
      !isPrivateChat &&
      /^\/indexstats(?:@[\w_]+)?(?:\s|$)/i.test(commandText)
    ) {
      if (!isAdmin) return;
      await handleIndexStatsCommand(ctx, message, commandText);
      return;
    }

    // 3b. /name and /lore — admin only, group only.
    if (
      !isPrivateChat &&
      isAdmin &&
      /^\/name(?:@[\w_]+)?(?:\s|$)/i.test(commandText)
    ) {
      await handleNameCommand(ctx, message);
      return;
    }
    if (
      !isPrivateChat &&
      isAdmin &&
      /^\/lore(?:@[\w_]+)?(?:\s|$)/i.test(commandText)
    ) {
      await handleLoreCommand(ctx, message);
      return;
    }

    // 4. Admin-only commands.
    if (!isAdmin) {
      if (isPrivateChat) {
        await sendMessage(
          message.chat.id,
          "Этот бот предназначен только для администратора.",
          {},
        );
      }
      return;
    }

    await handleAdminText(ctx, message);
  },
});

function parseStartPayload(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "/start") return "";
  if (trimmed.startsWith("/start "))
    return trimmed.slice("/start ".length).trim();
  return null;
}

// Normalizes the three kinds of media we accept (voice, audio, video note).
interface MediaInfo {
  fileId: string;
  duration: number | undefined;
  kind: "voice" | "audio" | "video_note";
}
function extractMedia(message: TgMessage): MediaInfo | null {
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      duration: message.voice.duration,
      kind: "voice",
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      duration: message.audio.duration,
      kind: "audio",
    };
  }
  if (message.video_note) {
    return {
      fileId: message.video_note.file_id,
      duration: message.video_note.duration,
      kind: "video_note",
    };
  }
  return null;
}

// ---- Voice ingest ---------------------------------------------------------

async function handleBusinessConnection(
  ctx: { runMutation: any },
  connection: TgBusinessConnection,
): Promise<void> {
  await ctx.runMutation(internal.businessConnections.upsert, {
    connectionId: connection.id,
    userId: connection.user?.id ?? 0,
    userChatId: connection.user_chat_id,
    isEnabled: connection.is_enabled,
    rights: connection.rights,
    connectedAt: connection.date,
  });
}

async function handleBusinessMessage(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
): Promise<void> {
  const media = extractMedia(message);
  if (!media || !message.business_connection_id) return;
  const connection = await ctx.runQuery(internal.businessConnections.get, {
    connectionId: message.business_connection_id,
  });
  if (!connection || !connection.isEnabled) return;
  await handleVoice(ctx, message, media, {
    businessConnectionId: message.business_connection_id,
    businessUserChatId: connection.userChatId,
    privateResult: true,
  });
}

async function handleGuestMessage(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
): Promise<void> {
  const guestQueryId = message.guest_query_id;
  if (!guestQueryId) return;

  // In guest mode the user usually summons the bot by replying to a voice with
  // @botname. The guest update then contains the summon message, while the
  // actual voice lives in reply_to_message.
  const targetMessage = extractMedia(message)
    ? message
    : message.reply_to_message;
  const media = targetMessage ? extractMedia(targetMessage) : null;
  if (!targetMessage || !media) {
    await answerGuestWithText(
      guestQueryId,
      "Нужно вызвать бота ответом на голосовое, аудио или видеокружок.",
    );
    return;
  }

  let inlineMessageId: string | null = null;
  try {
    const sent = await answerGuestProcessing(guestQueryId);
    inlineMessageId = sent.inline_message_id ?? null;
  } catch (err) {
    console.warn(
      "failed to send guest processing placeholder",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await editGuestProgress(inlineMessageId, "Расшифровываю сообщение…");
    const voice = await getOrCreateGuestVoiceRecord(ctx, targetMessage, media);
    let transcript = voice.transcript;
    if (!transcript) {
      const filePath = await getFilePath(media.fileId);
      const audio = await downloadFile(filePath);
      transcript = await transcribeAudio(audio, TRANSCRIBE_MODEL, "voice.ogg");
      if (!transcript) throw new Error("Whisper returned empty transcript");
      await ctx.runMutation(internal.voiceMessages.setTranscript, {
        id: voice._id,
        transcript,
      });
    }

    await editGuestProgress(inlineMessageId, "Готовлю summary…");
    const settings = await resolveGuestVoiceSettings(ctx, voice, transcript);
    const memory = await ctx.runQuery(internal.chatMemory.get, {
      chatId: voice.chatId,
    });
    const loreRows = await ctx.runQuery(internal.chatLore.allForChat, {
      chatId: voice.chatId,
    });
    const lore =
      loreRows && loreRows.length > 0
        ? loreRows.map((r: any) => `- ${r.text}`).join("\n")
        : null;
    const summaryArgs = {
      transcript,
      mode: settings.mode,
      context: settings.context,
      detail: settings.detail,
      chatStyleNotes: memory?.notes ?? null,
      chatLore: lore,
    };
    const { text: summary } = inlineMessageId
      ? await getOrGenerateSummaryStreaming(
          ctx,
          voice._id,
          summaryArgs,
          createGuestSummaryStreamer(
            inlineMessageId,
            labelForMedia(media.kind),
          ),
        )
      : await getOrGenerateSummary(ctx, voice._id, summaryArgs);
    await ctx.runMutation(internal.voiceMessages.setDisplayed, {
      id: voice._id,
      mode: settings.mode,
      context: settings.context,
      detail: settings.detail,
    });
    await ctx.runMutation(internal.voiceMessages.setStatus, {
      id: voice._id,
      status: "done",
    });

    await finishGuestWithSummary(
      guestQueryId,
      inlineMessageId,
      summary,
      transcript,
      labelForMedia(media.kind),
    );
  } catch (err) {
    console.warn("guest summary failed", err);
    const msg = err instanceof Error ? err.message : String(err);
    await finishGuestWithText(
      guestQueryId,
      inlineMessageId,
      `Не удалось обработать голосовое: ${msg.slice(0, 500)}`,
    );
  }
}

async function getOrCreateGuestVoiceRecord(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
  media: MediaInfo,
): Promise<Doc<"voiceMessages">> {
  const existing = (await ctx.runQuery(internal.voiceMessages.findByMessage, {
    chatId: message.chat.id,
    messageId: message.message_id,
  })) as Doc<"voiceMessages"> | null;
  if (existing) return existing;

  const fromName =
    [
      message.from?.first_name,
      message.from?.username && `@${message.from.username}`,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const id = await ctx.runMutation(internal.voiceMessages.create, {
    chatId: message.chat.id,
    chatTitle: message.chat.title,
    messageId: message.message_id,
    fromId: message.from?.id,
    fromName,
    fileId: media.fileId,
    mediaKind: media.kind,
    durationSec: media.duration,
  });
  const created = (await ctx.runQuery(internal.voiceMessages.get, {
    id,
  })) as Doc<"voiceMessages"> | null;
  if (!created) throw new Error("Не удалось создать запись голосового");
  return created;
}

async function resolveGuestVoiceSettings(
  ctx: { runMutation: any; runQuery: any },
  voice: Doc<"voiceMessages">,
  transcript: string,
): Promise<{
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
}> {
  const displayedMode = voice.displayedMode;
  const displayedContext = voice.displayedContext;
  const displayedDetail = voice.displayedDetail;
  if (
    displayedMode &&
    displayedContext &&
    isModeKey(displayedMode) &&
    displayedMode !== "auto" &&
    isContextKey(displayedContext) &&
    displayedContext !== "auto" &&
    displayedDetail !== undefined &&
    isDetail(displayedDetail)
  ) {
    return {
      mode: displayedMode,
      context: displayedContext,
      detail: displayedDetail,
    };
  }

  const chatDefaults = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: voice.chatId,
  });
  const resolved = await resolveVoiceSettings(
    ctx,
    voice._id,
    transcript,
    chatDefaults,
  );
  return {
    mode: resolved.mode,
    context: resolved.context,
    detail: resolved.detail,
  };
}

async function answerGuestProcessing(
  guestQueryId: string,
): Promise<{ message_id?: number; inline_message_id?: string }> {
  return await answerGuestQuery(guestQueryId, {
    type: "article",
    id: "voice_processing",
    title: "Обрабатываю голосовое…",
    input_message_content: {
      message_text: `${loadingEmoji()} <i>Обрабатываю голосовое…</i>`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  });
}

async function editGuestProgress(
  inlineMessageId: string | null,
  text: string,
): Promise<void> {
  if (!inlineMessageId) return;
  await editGuestMessageText(
    inlineMessageId,
    `${loadingEmoji()} <i>${escapeHtml(text)}</i>`,
    { parseMode: "HTML" },
  ).catch((err) => {
    console.warn(
      "failed to edit guest progress",
      err instanceof Error ? err.message : err,
    );
  });
}

const GUEST_STREAM_EDIT_INTERVAL_MS = 1200;
const GUEST_STREAM_MIN_CHAR_DELTA = 80;

function labelForMedia(kind: MediaInfo["kind"]): string {
  return kind === "video_note"
    ? "Summary видеокружка"
    : kind === "audio"
      ? "Summary аудио"
      : "Summary голосового";
}

function createGuestSummaryStreamer(
  inlineMessageId: string,
  title: string,
): (text: string) => Promise<void> {
  let lastEditAt = 0;
  let lastEditLen = 0;
  return async (text: string) => {
    const now = Date.now();
    if (
      now - lastEditAt < GUEST_STREAM_EDIT_INTERVAL_MS &&
      text.length - lastEditLen < GUEST_STREAM_MIN_CHAR_DELTA
    ) {
      return;
    }
    lastEditAt = now;
    lastEditLen = text.length;
    await editGuestMessageText(
      inlineMessageId,
      buildGuestStreamingSummaryBody(text, title),
      { parseMode: "HTML" },
    ).catch((err) => {
      console.warn(
        "failed to stream guest summary",
        err instanceof Error ? err.message : err,
      );
    });
  };
}

function buildGuestStreamingSummaryBody(
  summary: string,
  title: string,
): string {
  const escapedTitle = escapeHtml(title);
  const header = `<b>${escapedTitle}</b>\n\n`;
  const suffix = "\n\n<i>Генерирую…</i>";
  const budget = TG_TEXT_LIMIT - header.length - suffix.length - 20;
  const clipped =
    summary.length > budget
      ? `${summary.slice(0, Math.max(0, budget - 20))}\n...[обрезано]`
      : summary;
  return `${header}${markdownToTelegramHtml(clipped)}${suffix}`;
}

async function finishGuestWithSummary(
  guestQueryId: string,
  inlineMessageId: string | null,
  summary: string,
  transcript: string,
  title = "Summary голосового",
): Promise<void> {
  const body = buildGuestSummaryBody(summary, transcript, title);
  if (inlineMessageId) {
    await editGuestMessageText(inlineMessageId, body, { parseMode: "HTML" });
    return;
  }
  await answerGuestQuery(guestQueryId, {
    type: "article",
    id: "voice_summary",
    title,
    input_message_content: {
      message_text: body,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  });
}

function buildGuestSummaryBody(
  summary: string,
  transcript: string,
  title: string,
): string {
  const escapedTitle = escapeHtml(title);
  const header = `<b>${escapedTitle}</b>\n\n`;
  const renderBody = (summaryText: string, transcriptText: string | null) => {
    const summaryHtml = markdownToTelegramHtml(summaryText);
    if (!transcriptText) return `${header}${summaryHtml}`;
    return `${header}${summaryHtml}\n\n<blockquote expandable>${escapeHtml(transcriptText)}</blockquote>`;
  };

  let body = renderBody(summary, transcript);
  if (body.length > TG_TEXT_LIMIT) {
    const transcriptBudget = Math.max(0, TG_TEXT_LIMIT - header.length - 1500);
    const clippedTranscript =
      transcript.length > transcriptBudget
        ? `${transcript.slice(0, Math.max(0, transcriptBudget - 20))}\n...[обрезано]`
        : transcript;
    body = renderBody(summary, clippedTranscript);
  }
  if (body.length > TG_TEXT_LIMIT) {
    body = renderBody(summary, null);
  }
  if (body.length > TG_TEXT_LIMIT) {
    const summaryBudget = Math.max(0, TG_TEXT_LIMIT - header.length - 30);
    const clippedSummary =
      summary.length > summaryBudget
        ? `${summary.slice(0, Math.max(0, summaryBudget - 20))}\n...[обрезано]`
        : summary;
    body = renderBody(clippedSummary, null);
  }
  return body;
}

async function finishGuestWithText(
  guestQueryId: string,
  inlineMessageId: string | null,
  text: string,
  title = "Сукаризатор",
): Promise<void> {
  const body = buildGuestTextBody(text, title);
  if (inlineMessageId) {
    await editGuestMessageText(inlineMessageId, body, { parseMode: "HTML" });
    return;
  }
  await answerGuestWithText(guestQueryId, text, title);
}

async function answerGuestWithText(
  guestQueryId: string,
  text: string,
  title = "Сукаризатор",
): Promise<void> {
  const body = buildGuestTextBody(text, title);
  await answerGuestQuery(guestQueryId, {
    type: "article",
    id: "voice_transcript",
    title,
    input_message_content: {
      message_text: body,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  });
}

function buildGuestTextBody(text: string, title: string): string {
  const escapedTitle = escapeHtml(title);
  const quoteBudget = TG_TEXT_LIMIT - escapedTitle.length - 80;
  const clipped =
    text.length > quoteBudget
      ? `${text.slice(0, Math.max(0, quoteBudget - 20))}\n...[обрезано]`
      : text;
  return `<b>${escapedTitle}</b>\n\n<blockquote expandable>${escapeHtml(clipped)}</blockquote>`;
}

async function handleVoice(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
  media: MediaInfo,
  opts: {
    businessConnectionId?: string;
    businessUserChatId?: number;
    privateResult?: boolean;
  } = {},
) {
  const existing = await ctx.runQuery(internal.voiceMessages.findByMessage, {
    chatId: message.chat.id,
    messageId: message.message_id,
  });
  if (existing) return;

  const fromName =
    [
      message.from?.first_name,
      message.from?.username && `@${message.from.username}`,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  let ackMessageId: number | undefined;
  const ackChatId = opts.privateResult
    ? opts.businessUserChatId
    : message.chat.id;
  if (ackChatId !== undefined) {
    try {
      const ack = await sendMessage(
        ackChatId,
        `${loadingEmoji()}  <i>Обрабатываю голосовое из личной переписки…</i>`,
        {
          replyToMessageId: opts.privateResult ? undefined : message.message_id,
          parseMode: "HTML",
        },
      );
      ackMessageId = ack.message_id;
    } catch (err) {
      console.warn("Failed to send ack placeholder", err);
    }
  }

  const id = await ctx.runMutation(internal.voiceMessages.create, {
    chatId: message.chat.id,
    chatTitle: message.chat.title,
    messageId: message.message_id,
    fromId: message.from?.id,
    fromName,
    fileId: media.fileId,
    mediaKind: media.kind,
    durationSec: media.duration,
    ackMessageId,
    businessConnectionId: opts.businessConnectionId,
    businessUserChatId: opts.businessUserChatId,
  });
  // Pull the freshly-generated shortId and link it back to the chat-log
  // row so /summary can splice the transcript in later.
  const created = (await ctx.runQuery(internal.voiceMessages.get, {
    id,
  })) as Doc<"voiceMessages"> | null;
  if (created?.shortId) {
    await ctx.runMutation(internal.chatMessages.linkVoiceShortId, {
      chatId: message.chat.id,
      messageId: message.message_id,
      voiceShortId: created.shortId,
    });
  }
  await ctx.scheduler.runAfter(0, internal.processing.processVoiceMessage, {
    id,
  });
}

// ---- /name command -------------------------------------------------------

// `/name Сонечка` as reply to someone's message → sets a nickname that
// the bot will use in all future summaries for that user in this chat.
// `/name` as reply (no text) → clears the nickname.
async function handleNameCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const nickname = text.replace(/^\/name(@[\w_]+)?\s*/i, "").trim();
  const target = message.reply_to_message;

  if (!target || !target.from) {
    await sendMessage(
      chatId,
      "Ответьте этой командой на сообщение человека, которому хотите задать имя для summary.",
      {},
    );
    return;
  }

  const targetUser = target.from;
  const displayName =
    [targetUser.first_name, targetUser.last_name].filter(Boolean).join(" ") ||
    targetUser.username ||
    `user${targetUser.id}`;

  if (!nickname) {
    // Clear the nickname.
    await ctx.runMutation(internal.chatNicknames.remove, {
      chatId,
      userId: targetUser.id,
    });
    await sendMessage(
      chatId,
      `Имя для ${displayName} сброшено. Бот вернётся к имени из Telegram.`,
      {},
    );
    return;
  }

  await ctx.runMutation(internal.chatNicknames.set, {
    chatId,
    userId: targetUser.id,
    nickname,
  });
  await sendMessage(
    chatId,
    `Теперь в summary этого чата ${displayName} будет упоминаться как «${nickname}».`,
    {},
  );
}

// ---- /lore command -------------------------------------------------------

// `/lore Соня любит члены` → adds a permanent note the bot sees in every
// summary. `/lore` without text → lists existing lore.
async function handleLoreCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const loreText = text.replace(/^\/lore(@[\w_]+)?\s*/i, "").trim();

  if (!loreText) {
    // List existing lore entries.
    const entries = await ctx.runQuery(internal.chatLore.allForChat, {
      chatId,
    });
    if (!entries || entries.length === 0) {
      await sendMessage(
        chatId,
        "В этом чате пока нет lore-заметок. Добавьте через /lore <текст>.",
        {},
      );
      return;
    }
    const lines = entries.map(
      (e: any, i: number) =>
        `${i + 1}. ${e.text}${e.addedByName ? ` (${e.addedByName})` : ""}`,
    );
    await sendMessage(
      chatId,
      `<b>Lore этого чата:</b>\n${escapeHtml(lines.join("\n"))}`,
      { parseMode: "HTML" },
    );
    return;
  }

  const fromName =
    [message.from?.first_name, message.from?.last_name]
      .filter(Boolean)
      .join(" ") || message.from?.username;

  await ctx.runMutation(internal.chatLore.add, {
    chatId,
    text: loreText,
    addedById: message.from?.id,
    addedByName: fromName,
  });
  await sendMessage(chatId, `Lore добавлен: ${loreText}`, {});
}

// ---- Chat-message storage (for /summary) ---------------------------------

type ChatMediaKind =
  | "text"
  | "photo"
  | "video"
  | "voice"
  | "audio"
  | "video_note"
  | "document"
  | "sticker"
  | "other";

function detectChatMediaKind(message: TgMessage): ChatMediaKind {
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.video_note) return "video_note";
  if (message.photo && message.photo.length > 0) return "photo";
  if (message.video) return "video";
  if (message.document) return "document";
  if (message.sticker) return "sticker";
  if (message.text) return "text";
  return "other";
}

async function storeChatMessage(
  ctx: { runMutation: any },
  message: TgMessage,
): Promise<Id<"chatMessages">> {
  const ts = message.date ?? Math.floor(Date.now() / 1000);
  return await ctx.runMutation(internal.chatMessages.upsert, {
    chatId: message.chat.id,
    messageId: message.message_id,
    ts,
    fromId: message.from?.id,
    fromFirstName: message.from?.first_name,
    fromLastName: message.from?.last_name,
    fromUsername: message.from?.username,
    text: message.text ?? message.caption,
    mediaKind: detectChatMediaKind(message),
    replyToMessageId: message.reply_to_message?.message_id,
  });
}

// ---- /summary command ----------------------------------------------------

async function handleSummaryCommand(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
): Promise<void> {
  // If the user sent /s, /sum or /summary as a reply to a voice/audio/
  // video_note, treat it as a "resummarize this voice" request — same
  // behavior as the old /summarize command. The chat-summary path is for
  // when the command is used standalone.
  const replyTarget = message.reply_to_message;
  const replyMedia = replyTarget ? extractMedia(replyTarget) : null;
  if (replyTarget && replyMedia) {
    await handleVoice(ctx, replyTarget, replyMedia);
    return;
  }

  const text = (message.text ?? "").trim();
  // Strip the command + any /command@bot suffix and grab whatever comes
  // after as free-form natural-language args.
  const stripped = text.replace(/^\/(?:s|sum|summary)(@[\w_]+)?\s*/i, "");
  const rawArgs = stripped;

  let ackMessageId: number | undefined;
  try {
    const ack = await sendMessage(
      message.chat.id,
      `${loadingEmoji()} <i>Готовлю summary переписки…</i>`,
      { replyToMessageId: message.message_id, parseMode: "HTML" },
    );
    ackMessageId = ack.message_id;
  } catch (err) {
    console.warn("Failed to send /summary ack", err);
  }

  const id = await ctx.runMutation(internal.chatSummaries.create, {
    chatId: message.chat.id,
    requesterId: message.from?.id ?? 0,
    requestMessageId: message.message_id,
    ackMessageId,
  });
  await ctx.scheduler.runAfter(0, internal.processing.processChatSummary, {
    chatSummaryId: id,
    rawArgs,
  });
}

async function handleSearchCommand(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
  commandText: string,
): Promise<void> {
  const isAsk = /^\/ask(?:@[\w_]+)?(?:\s|$)/i.test(commandText);
  const query = commandText
    .replace(/^\/(?:search|ask)(@[\w_]+)?\s*/i, "")
    .trim();
  if (!query) {
    await sendMessage(
      message.chat.id,
      isAsk
        ? "Использование: /ask <вопрос>"
        : "Использование: /search <что найти>",
      {
        replyToMessageId: message.message_id,
      },
    );
    return;
  }
  const parent = message.reply_to_message
    ? await ctx.runQuery(internal.searchRequests.findByOutputMessage, {
        chatId: message.chat.id,
        messageId: message.reply_to_message.message_id,
      })
    : null;
  let ackMessageId: number | undefined;
  try {
    const ack = await sendMessage(
      message.chat.id,
      `${loadingEmoji()} <i>${
        isAsk
          ? parent
            ? "Продолжаю отвечать по истории…"
            : "Ищу доказательства для ответа…"
          : parent
            ? "Продолжаю поиск по истории…"
            : "Ищу по истории чата…"
      }</i>`,
      { replyToMessageId: message.message_id, parseMode: "HTML" },
    );
    ackMessageId = ack.message_id;
  } catch (err) {
    console.warn("Failed to send /search ack", err);
  }
  const id = await ctx.runMutation(internal.searchRequests.create, {
    chatId: message.chat.id,
    requesterId: message.from?.id ?? 0,
    requestMessageId: message.message_id,
    ackMessageId,
    parentSearchRequestId: parent?._id,
    mode: isAsk ? "ask" : "search",
    query,
  });
  await ctx.scheduler.runAfter(0, internal.vectorSearch.processVectorSearch, {
    searchRequestId: id,
  });
}

async function handleReindexCommand(
  ctx: { scheduler: any },
  message: TgMessage,
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    internal.vectorSearch.backfillMessageEmbeddings,
    {
      chatId: message.chat.id,
    },
  );
  await sendMessage(
    message.chat.id,
    "Переиндексация запущена в фоне. /search будет обновляться по мере готовности.",
    { replyToMessageId: message.message_id },
  );
}

async function handleIndexStatsCommand(
  ctx: { scheduler: any },
  message: TgMessage,
  commandText: string,
): Promise<void> {
  const forceRebuild = /\brebuild\b/i.test(commandText);
  let ackMessageId: number | undefined;
  try {
    const ack = await sendMessage(
      message.chat.id,
      `${loadingEmoji()} <i>Считаю index stats…</i>`,
      { replyToMessageId: message.message_id, parseMode: "HTML" },
    );
    ackMessageId = ack.message_id;
  } catch (err) {
    console.warn("Failed to send /indexstats ack", err);
  }
  await ctx.scheduler.runAfter(0, internal.indexStats.processIndexStats, {
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    ackMessageId,
    forceRebuild,
  });
}

async function handleImportDumpCommand(
  ctx: { runMutation: any; scheduler: any },
  message: TgMessage,
): Promise<void> {
  const target = message.document ? message : message.reply_to_message;
  const document = target?.document;
  if (!target || !document) {
    await sendMessage(
      message.chat.id,
      "Отправьте result.json, .zip или result.json.gz с подписью /importdump, либо ответьте /importdump на файл.",
      { replyToMessageId: message.message_id },
    );
    return;
  }
  const fileName = document.file_name;
  const lowerName = fileName?.toLowerCase() ?? "";
  const supported =
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".json.gz") ||
    lowerName.endsWith(".zip") ||
    document.mime_type === "application/json" ||
    document.mime_type === "text/json" ||
    document.mime_type === "application/zip" ||
    document.mime_type === "application/x-zip-compressed" ||
    document.mime_type === "application/gzip" ||
    document.mime_type === "application/x-gzip";
  if (!supported) {
    await sendMessage(
      message.chat.id,
      "Нужен Telegram export: result.json, .zip или result.json.gz.",
      {
        replyToMessageId: message.message_id,
      },
    );
    return;
  }

  let ackMessageId: number | undefined;
  try {
    const ack = await sendMessage(
      message.chat.id,
      `${loadingEmoji()} <i>Готовлю импорт dump…</i>`,
      { replyToMessageId: message.message_id, parseMode: "HTML" },
    );
    ackMessageId = ack.message_id;
  } catch (err) {
    console.warn("Failed to send /importdump ack", err);
  }

  const id = await ctx.runMutation(internal.chatImportJobs.create, {
    fileId: document.file_id,
    fileName,
    fileMimeType: document.mime_type,
    requesterId: message.from?.id ?? 0,
    requestChatId: message.chat.id,
    requestMessageId: message.message_id,
    ackMessageId,
  });
  await ctx.scheduler.runAfter(0, internal.chatImport.processChatImportJob, {
    importJobId: id,
  });
}

// ---- Deep-link picker (group "Открыть в боте" → bot DM) -------------------

async function handleVoiceDeepLink(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
  shortId: string,
): Promise<void> {
  if (!shortId) {
    await sendMessage(message.chat.id, "Битая ссылка.", {});
    return;
  }
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) {
    await sendMessage(message.chat.id, "Сообщение не найдено.", {});
    return;
  }
  if (!voice.transcript) {
    await sendMessage(
      message.chat.id,
      "Сообщение ещё не расшифровано. Попробуйте через несколько секунд.",
      {},
    );
    return;
  }

  const userId = message.from?.id;
  if (!userId) return;

  // Initialize the user's session from the chat defaults. Subsequent
  // clicks will mutate these values as the user picks things.
  const chatDefaults = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: voice.chatId,
  });
  const session = {
    mode: chatDefaults.mode,
    context: chatDefaults.context,
    detail: chatDefaults.detail as Detail,
  };

  // 1. Send the raw transcript first (split if long). This is the "just
  //    view the transcript" affordance — the user sees it up-front, then
  //    scrolls down to the summary picker.
  await sendTranscriptMessages(message.chat.id, voice);

  // 2. Render and send the main picker (summary + settings + controls).
  const summary = await loadOrGenerateForSession(ctx, voice, session);
  const state: PickerState = {
    voice,
    session,
    view: "main",
    isAuthor: userId === voice.fromId,
  };
  const pickerText = renderPickerMessage(state, summary);
  const keyboard = buildKeyboard(state);

  const sent = await sendMessage(message.chat.id, pickerText, {
    parseMode: "HTML",
    inlineKeyboard: keyboard,
  });

  await ctx.runMutation(internal.userSession.upsert, {
    userId,
    voiceShortId: shortId,
    mode: session.mode,
    context: session.context,
    detail: session.detail,
    pickerMessageId: sent.message_id,
    view: "main",
  });
}

// Sends the raw transcript as one or more messages in the user's DM.
async function sendTranscriptMessages(
  chatId: number,
  voice: Doc<"voiceMessages">,
): Promise<void> {
  const kindLabel =
    voice.mediaKind === "video_note"
      ? "Видеокружок"
      : voice.mediaKind === "audio"
        ? "Аудио"
        : "Голосовое";
  const headerLines: string[] = [`<b>${kindLabel}</b>`];
  if (voice.chatTitle)
    headerLines.push(`<b>Из:</b> ${escapeHtml(voice.chatTitle)}`);
  if (voice.fromName)
    headerLines.push(`<b>От:</b> ${escapeHtml(voice.fromName)}`);
  if (voice.durationSec !== undefined) {
    headerLines.push(`<b>Длительность:</b> ${voice.durationSec}s`);
  }
  const header = headerLines.join("\n");
  const transcriptHtml = escapeHtml(voice.transcript ?? "");

  const single = `${header}\n\n<blockquote expandable>${transcriptHtml}</blockquote>`;
  if (single.length <= TG_TEXT_LIMIT) {
    await sendMessage(chatId, single, { parseMode: "HTML" });
    return;
  }
  // Header alone, then transcript chunks threaded under it.
  const firstSent = await sendMessage(chatId, header, { parseMode: "HTML" });
  const QUOTE_BUDGET = TG_TEXT_LIMIT - 50;
  const chunks = splitTextSafely(transcriptHtml, QUOTE_BUDGET);
  let anchor = firstSent.message_id;
  for (const chunk of chunks) {
    const reply = await sendMessage(
      chatId,
      `<blockquote expandable>${chunk}</blockquote>`,
      { parseMode: "HTML", replyToMessageId: anchor },
    );
    anchor = reply.message_id;
  }
}

// ---- Picker rendering -----------------------------------------------------

type View = "main" | "mode" | "context" | "detail";

interface PickerState {
  voice: Doc<"voiceMessages">;
  session: { mode: ModeKey; context: ContextKey; detail: Detail };
  view: View;
  isAuthor: boolean;
}

// The message body of the picker. Depends on voice + summary + session;
// the view only affects the keyboard, so navigating between main and
// sub-pickers uses editMessageReplyMarkup and leaves the text alone.
// Renders a setting label, expanding "auto" to show what the router
// actually picked when that resolution is known. Used by both the text
// summary line and the inline-keyboard buttons.
function describeAutoSetting(
  sessionValue: string,
  resolvedValue: string | null | undefined,
  labelFn: (key: any) => string,
): string {
  if (sessionValue !== "auto") return labelFn(sessionValue);
  if (!resolvedValue) return AUTO_LABEL;
  return `${AUTO_LABEL} → ${labelFn(resolvedValue)}`;
}

// Compact version for inline-keyboard buttons (no spaces around the
// arrow, no escaping — keyboard buttons aren't HTML-parsed).
function describeAutoButton(
  sessionValue: string,
  resolvedValue: string | null | undefined,
  labelFn: (key: any) => string,
): string {
  if (sessionValue !== "auto") return labelFn(sessionValue);
  if (!resolvedValue) return AUTO_LABEL;
  return `${AUTO_LABEL}·${labelFn(resolvedValue)}`;
}

function renderPickerMessage(state: PickerState, summary: string): string {
  const summaryHtml = markdownToTelegramHtml(summary);
  const modeText = describeAutoSetting(
    state.session.mode,
    state.voice.autoMode,
    modeLabel,
  );
  const contextText = describeAutoSetting(
    state.session.context,
    state.voice.autoContext,
    contextLabel,
  );
  const settingsLine =
    `<i>Стиль:</i> ${escapeHtml(modeText)} · ` +
    `<i>Контекст:</i> ${escapeHtml(contextText)} · ` +
    `<i>Детали:</i> ${state.session.detail}`;

  // Truncate if the combination overshoots the limit — in the DM picker
  // we don't have room for a fallback link-prompt (we're already in the
  // bot), so we soft-truncate the summary body.
  const settingsBlock = `\n\n${settingsLine}`;
  const limit = TG_TEXT_LIMIT - settingsBlock.length - 10;
  const body =
    summaryHtml.length > limit
      ? summaryHtml.slice(0, limit - 30) + "\n\n<i>(summary обрезан)</i>"
      : summaryHtml;
  return `${body}${settingsBlock}`;
}

// Loading-state body for the picker. Shown for one render frame while we
// generate a fresh summary on cache miss, so the user gets immediate
// visual feedback that the click was registered.
function renderLoadingState(state: PickerState): string {
  const modeText = describeAutoSetting(
    state.session.mode,
    state.voice.autoMode,
    modeLabel,
  );
  const contextText = describeAutoSetting(
    state.session.context,
    state.voice.autoContext,
    contextLabel,
  );
  const settingsLine =
    `<i>Стиль:</i> ${escapeHtml(modeText)} · ` +
    `<i>Контекст:</i> ${escapeHtml(contextText)} · ` +
    `<i>Детали:</i> ${state.session.detail}`;
  return `${loadingEmoji()} <i>Готовлю summary с новыми настройками…</i>\n\n${settingsLine}`;
}

// Resolves the user's possibly-"auto" session into the concrete keys we
// actually use for cache lookup and generation. Falls back to safe
// defaults if the voice doesn't have an auto resolution stored yet.
function resolveAutoForSession(
  voice: Doc<"voiceMessages">,
  session: { mode: ModeKey; context: ContextKey; detail: Detail },
): {
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
} | null {
  let mode: ModeKey = session.mode;
  let context: ContextKey = session.context;
  if (mode === "auto")
    mode = (voice.autoMode as ModeKey | undefined) ?? "brief";
  if (context === "auto") {
    context =
      (voice.autoContext as ContextKey | undefined) ?? "thinkingOutLoud";
  }
  if (mode === "auto" || context === "auto") return null;
  return {
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail: session.detail,
  };
}

function buildKeyboard(state: PickerState): InlineKeyboard {
  const { session, view, isAuthor, voice } = state;
  const sid = voice.shortId ?? "";

  if (view === "main") {
    const rows: InlineKeyboard = [];
    rows.push([
      {
        text: `📝 ${describeAutoButton(session.mode, voice.autoMode, modeLabel)}`,
        callback_data: `v:${sid}:mode`,
      },
      {
        text: `🎭 ${describeAutoButton(session.context, voice.autoContext, contextLabel)}`,
        callback_data: `v:${sid}:context`,
      },
      {
        text: `📊 ${session.detail}`,
        callback_data: `v:${sid}:detail`,
      },
    ]);
    if (isAuthor) {
      rows.push([
        {
          text: "Применить в чат",
          callback_data: `a:${sid}`,
        },
      ]);
    }
    return rows;
  }

  if (view === "mode") {
    return keyboardFromKeys(
      ALL_MODE_KEYS,
      (k) => modeLabel(k),
      (k) => `sm:${sid}:${k}`,
      session.mode,
      `bk:${sid}`,
    );
  }
  if (view === "context") {
    return keyboardFromKeys(
      ALL_CONTEXT_KEYS,
      (k) => contextLabel(k),
      (k) => `sc:${sid}:${k}`,
      session.context,
      `bk:${sid}`,
    );
  }
  // detail
  return [
    ALL_DETAILS.map((d) => ({
      text: d === session.detail ? `✓ ${d}` : `${d}`,
      callback_data: `sd:${sid}:${d}`,
    })),
    [{ text: "← Назад", callback_data: `bk:${sid}` }],
  ];
}

// Lays out `keys` in rows of 2, marks the active one with ✓, and appends a
// back row.
function keyboardFromKeys<K extends string>(
  keys: readonly K[],
  label: (k: K) => string,
  data: (k: K) => string,
  active: K,
  backData: string,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < keys.length; i += 2) {
    const row = keys.slice(i, i + 2).map((k) => ({
      text: k === active ? `✓ ${label(k)}` : label(k),
      callback_data: data(k),
    }));
    rows.push(row);
  }
  rows.push([{ text: "← Назад", callback_data: backData }]);
  return rows;
}

// ---- Summary loader for picker (with cache) -------------------------------

// Resolves "auto" via the voice's cached auto resolution (populated during
// the initial processing pass) and then hits the shared cache helper in
// processing.ts — cache hit gives instant responses, cache miss generates
// and stores.
async function loadOrGenerateForSession(
  ctx: { runQuery: any; runMutation: any },
  voice: Doc<"voiceMessages">,
  session: { mode: ModeKey; context: ContextKey; detail: Detail },
): Promise<string> {
  let mode: ModeKey = session.mode;
  let context: ContextKey = session.context;
  if (mode === "auto") {
    mode = (voice.autoMode as ModeKey | undefined) ?? "brief";
  }
  if (context === "auto") {
    context =
      (voice.autoContext as ContextKey | undefined) ?? "thinkingOutLoud";
  }
  if (mode === "auto" || context === "auto") {
    return "Summary ещё не готов — подождите пару секунд и попробуйте ещё раз.";
  }
  if (!voice.transcript) {
    return "Сообщение ещё не расшифровано.";
  }
  const memory = await ctx.runQuery(internal.chatMemory.get, {
    chatId: voice.chatId,
  });
  const loreRows = await ctx.runQuery(internal.chatLore.allForChat, {
    chatId: voice.chatId,
  });
  const lore =
    loreRows && loreRows.length > 0
      ? loreRows.map((r: any) => `- ${r.text}`).join("\n")
      : null;
  const { text } = await getOrGenerateSummary(ctx, voice._id, {
    transcript: voice.transcript,
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail: session.detail,
    chatStyleNotes: memory?.notes ?? null,
    chatLore: lore,
  });
  return text;
}

// ---- Callback router ------------------------------------------------------

async function handleCallback(
  ctx: { runMutation: any; runQuery: any; scheduler: any; runAction: any },
  cb: TgCallbackQuery,
): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const userId = cb.from.id;
  if (chatId === undefined || messageId === undefined) {
    await answerCallbackQuery(cb.id);
    return;
  }

  const parts = data.split(":");
  // Voice picker callback formats:
  //   v:<sid>:<view>     — open a sub-view (mode|context|detail)
  //   bk:<sid>           — back to main view
  //   sm:<sid>:<modeKey> — set mode
  //   sc:<sid>:<ctxKey>  — set context
  //   sd:<sid>:<1|2|3>   — set detail
  //   a:<sid>            — apply current session to chat (author only)
  //
  // Chat-summary picker uses the same shape with a `c` prefix on the
  // verb so we can dispatch by parts[0].startsWith("c"):
  //   cv: cbk: csm: csc: csd: ca:
  try {
    // Cancel buttons (work during processing on either pipeline). Must
    // be matched BEFORE the chat-summary `c`-prefix dispatcher because
    // `dc:` doesn't actually start with `c`, and `dv:` doesn't either.
    if (parts[0] === "dv" && parts.length === 2) {
      await cancelVoice(ctx, cb, parts[1]);
      return;
    }
    if (parts[0] === "dc" && parts.length === 2) {
      await cancelChatSummary(ctx, cb, parts[1]);
      return;
    }
    if (parts[0]?.startsWith("c")) {
      await handleChatSummaryCallback(ctx, cb, parts);
      return;
    }
    if (parts[0] === "v" && parts.length === 3) {
      const view = parts[2];
      if (view !== "mode" && view !== "context" && view !== "detail") {
        await answerCallbackQuery(cb.id);
        return;
      }
      await openSubView(ctx, cb, parts[1], view);
      return;
    }
    if (parts[0] === "bk" && parts.length === 2) {
      await backToMain(ctx, cb, parts[1]);
      return;
    }
    if (parts[0] === "sm" && parts.length === 3) {
      await setSessionField(ctx, cb, parts[1], "mode", parts[2]);
      return;
    }
    if (parts[0] === "sc" && parts.length === 3) {
      await setSessionField(ctx, cb, parts[1], "context", parts[2]);
      return;
    }
    if (parts[0] === "sd" && parts.length === 3) {
      await setSessionField(ctx, cb, parts[1], "detail", parts[2]);
      return;
    }
    if (parts[0] === "a" && parts.length === 2) {
      await applyToChat(ctx, cb, parts[1]);
      return;
    }
  } catch (err) {
    console.error("handleCallback failed", err);
    await answerCallbackQuery(cb.id, "Что-то сломалось").catch(() => {});
    return;
  }
  await answerCallbackQuery(cb.id);
}

// Cancels an in-flight voice processing job and deletes the bot's ack
// message. The processing pipeline polls the row's `cancelled` flag
// between stages and bails out cleanly.
async function cancelVoice(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  await answerCallbackQuery(cb.id, "Отменяю…");
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (voice) {
    await ctx.runMutation(internal.voiceMessages.markCancelled, {
      id: voice._id,
    });
  }
  if (cb.message) {
    await deleteMessage(cb.message.chat.id, cb.message.message_id);
  }
}

async function cancelChatSummary(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  await answerCallbackQuery(cb.id, "Отменяю…");
  const summary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
    shortId,
  })) as Doc<"chatSummaries"> | null;
  if (summary) {
    await ctx.runMutation(internal.chatSummaries.markCancelled, {
      id: summary._id,
    });
  }
  if (cb.message) {
    await deleteMessage(cb.message.chat.id, cb.message.message_id);
  }
}

async function loadSession(
  ctx: { runQuery: any },
  userId: number,
  shortId: string,
): Promise<Doc<"userSession"> | null> {
  return await ctx.runQuery(internal.userSession.get, {
    userId,
    voiceShortId: shortId,
  });
}

async function openSubView(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
  view: "mode" | "context" | "detail",
): Promise<void> {
  await answerCallbackQuery(cb.id);
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) return;
  const session = await loadSession(ctx, cb.from.id, shortId);
  if (!session) return;
  const isAuthor = cb.from.id === voice.fromId;
  const state: PickerState = {
    voice,
    session: {
      mode: session.mode as ModeKey,
      context: session.context as ContextKey,
      detail: session.detail as Detail,
    },
    view,
    isAuthor,
  };
  const keyboard = buildKeyboard(state);
  await editMessageReplyMarkup(
    cb.message!.chat.id,
    cb.message!.message_id,
    keyboard,
  );
  await ctx.runMutation(internal.userSession.upsert, {
    userId: cb.from.id,
    voiceShortId: shortId,
    mode: session.mode,
    context: session.context,
    detail: session.detail,
    pickerMessageId: cb.message!.message_id,
    view,
  });
}

async function backToMain(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  await answerCallbackQuery(cb.id);
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) return;
  const session = await loadSession(ctx, cb.from.id, shortId);
  if (!session) return;
  const isAuthor = cb.from.id === voice.fromId;
  const state: PickerState = {
    voice,
    session: {
      mode: session.mode as ModeKey,
      context: session.context as ContextKey,
      detail: session.detail as Detail,
    },
    view: "main",
    isAuthor,
  };
  const keyboard = buildKeyboard(state);
  await editMessageReplyMarkup(
    cb.message!.chat.id,
    cb.message!.message_id,
    keyboard,
  );
  await ctx.runMutation(internal.userSession.upsert, {
    userId: cb.from.id,
    voiceShortId: shortId,
    mode: session.mode,
    context: session.context,
    detail: session.detail,
    pickerMessageId: cb.message!.message_id,
    view: "main",
  });
}

async function setSessionField(
  ctx: { runMutation: any; runQuery: any; runAction: any },
  cb: TgCallbackQuery,
  shortId: string,
  field: "mode" | "context" | "detail",
  rawValue: string,
): Promise<void> {
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) {
    await answerCallbackQuery(cb.id, "Сообщение не найдено");
    return;
  }
  const prev = await loadSession(ctx, cb.from.id, shortId);
  if (!prev) {
    await answerCallbackQuery(cb.id, "Сессия не найдена, /start заново");
    return;
  }

  // Validate and apply.
  const nextSession = {
    mode: prev.mode as ModeKey,
    context: prev.context as ContextKey,
    detail: prev.detail as Detail,
  };
  if (field === "mode") {
    if (!isModeKey(rawValue)) {
      await answerCallbackQuery(cb.id);
      return;
    }
    nextSession.mode = rawValue;
  } else if (field === "context") {
    if (!isContextKey(rawValue)) {
      await answerCallbackQuery(cb.id);
      return;
    }
    nextSession.context = rawValue;
  } else {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || !isDetail(n)) {
      await answerCallbackQuery(cb.id);
      return;
    }
    nextSession.detail = n;
  }

  // Answer the callback now — summary generation may take a couple
  // seconds and we don't want the loading spinner to hang.
  await answerCallbackQuery(cb.id);

  const isAuthor = cb.from.id === voice.fromId;
  const state: PickerState = {
    voice,
    session: nextSession,
    view: "main",
    isAuthor,
  };
  const keyboard = buildKeyboard(state);
  const chatIdForEdit = cb.message!.chat.id;
  const messageIdForEdit = cb.message!.message_id;

  // Resolve "auto" to concrete keys so we can probe the cache directly.
  // If the user's session is still on "auto" and the voice hasn't been
  // routed yet, fall through to the slow path with a loading state.
  const concrete = resolveAutoForSession(voice, nextSession);

  let cachedHit = false;
  let summary: string | null = null;

  if (concrete && voice.transcript) {
    const cached = await ctx.runQuery(internal.summaries.findCached, {
      voiceMessageId: voice._id,
      mode: concrete.mode,
      context: concrete.context,
      detail: concrete.detail,
    });
    if (cached) {
      cachedHit = true;
      summary = cached.text;
    }
  }

  if (!cachedHit) {
    // Cache miss → flash a loading state so the user knows we're working,
    // then generate, then commit. Two edits total. The loading state
    // keeps the same keyboard so users can still navigate while it
    // resolves (in practice they won't, but it doesn't lock them out).
    const loadingText = renderLoadingState(state);
    await editMessageText(chatIdForEdit, messageIdForEdit, loadingText, {
      parseMode: "HTML",
      inlineKeyboard: keyboard,
    });
    summary = await loadOrGenerateForSession(ctx, voice, nextSession);
  }

  const text = renderPickerMessage(state, summary ?? "");
  await editMessageText(chatIdForEdit, messageIdForEdit, text, {
    parseMode: "HTML",
    inlineKeyboard: keyboard,
  });

  await ctx.runMutation(internal.userSession.upsert, {
    userId: cb.from.id,
    voiceShortId: shortId,
    mode: nextSession.mode,
    context: nextSession.context,
    detail: nextSession.detail,
    pickerMessageId: messageIdForEdit,
    view: "main",
  });
}

// Author-only: re-renders the source-chat message using the author's
// current session settings. Reads (or generates) the cached summary and
// edits the original ack message via the same commitFinal path that the
// initial pipeline uses.
async function applyToChat(
  ctx: { runMutation: any; runQuery: any; scheduler: any; runAction: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) {
    await answerCallbackQuery(cb.id, "Сообщение не найдено");
    return;
  }
  if (cb.from.id !== voice.fromId) {
    await answerCallbackQuery(
      cb.id,
      "Только автор сообщения может менять отображение в чате",
      true,
    );
    return;
  }
  const session = await loadSession(ctx, cb.from.id, shortId);
  if (!session) {
    await answerCallbackQuery(cb.id, "Сессия не найдена, /start заново");
    return;
  }
  if (!voice.transcript) {
    await answerCallbackQuery(cb.id, "Расшифровка отсутствует");
    return;
  }
  await answerCallbackQuery(cb.id, "Обновляю в чате…");

  // Resolve auto values if the user's session still has "auto" (happens
  // when they never entered a sub-picker — they're applying the defaults).
  let mode = session.mode as ModeKey;
  let context = session.context as ContextKey;
  if (mode === "auto")
    mode = (voice.autoMode as ModeKey | undefined) ?? "brief";
  if (context === "auto") {
    context =
      (voice.autoContext as ContextKey | undefined) ?? "thinkingOutLoud";
  }
  if (mode === "auto" || context === "auto") return;
  const detail = session.detail as Detail;

  const debugMode = await ctx.runQuery(internal.botConfig.getDebugMode, {});
  const memory = await ctx.runQuery(internal.chatMemory.get, {
    chatId: voice.chatId,
  });
  const loreRows = await ctx.runQuery(internal.chatLore.allForChat, {
    chatId: voice.chatId,
  });
  const lore =
    loreRows && loreRows.length > 0
      ? loreRows.map((r: any) => `- ${r.text}`).join("\n")
      : null;
  const { text: summary } = await getOrGenerateSummary(ctx, voice._id, {
    transcript: voice.transcript,
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail,
    chatStyleNotes: memory?.notes ?? null,
    chatLore: lore,
  });

  // Mark as currently-displayed so debug info + future applies are correct.
  await ctx.runMutation(internal.voiceMessages.setDisplayed, {
    id: voice._id,
    mode,
    context,
    detail,
  });

  const botUsername = await ctx.runQuery(internal.botConfig.getBotUsername, {});
  const rendered = renderFinal({
    summary,
    transcript: voice.transcript,
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail,
    wasAutoMode: session.mode === "auto",
    wasAutoContext: session.context === "auto",
    timings: {},
    debug: debugMode,
  });
  const keyboard = buildOpenInBotKeyboard(botUsername, voice.shortId);
  await commitFinal({
    chatId: voice.chatId,
    ackId: voice.ackMessageId,
    replyTo: voice.messageId,
    ...rendered,
    keyboard,
  });
}

// ---- Admin text commands (no more wizards / type management) --------------

async function handleAdminText(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
) {
  const text = message.text!.trim();
  const adminId = message.from!.id;
  const chatId = message.chat.id;

  if (!text.startsWith("/")) return; // silent; owner is just chatting

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@[\w_]+/, "").toLowerCase();
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      await sendMessage(chatId, HELP_TEXT, {});
      return;

    case "/whoami":
      await sendMessage(
        chatId,
        `Ваш Telegram ID: ${adminId}\nID этого чата: ${chatId}\nТип чата: ${message.chat.type}`,
        {},
      );
      return;

    case "/summarize":
    case "/sum":
    case "/transcribe": {
      const target = message.reply_to_message;
      const media = target ? extractMedia(target) : null;
      if (!target || !media) {
        await sendMessage(
          chatId,
          "Ответьте этой командой на голосовое, аудио или видеокружок.",
          {},
        );
        return;
      }
      await handleVoice(ctx, target, media);
      return;
    }

    case "/debug": {
      let value: boolean | undefined;
      const arg = args.toLowerCase();
      if (arg === "on" || arg === "1" || arg === "true") value = true;
      else if (arg === "off" || arg === "0" || arg === "false") value = false;
      const next: boolean = await ctx.runMutation(
        internal.botConfig.toggleDebugMode,
        value !== undefined ? { value } : {},
      );
      await sendMessage(chatId, next ? "Debug: ON" : "Debug: OFF", {});
      return;
    }

    case "/defaults": {
      await handleDefaults(ctx, message, args);
      return;
    }

    default:
      return; // silent for unknown commands
  }
}

// /defaults — show or set the per-chat default mode/context/detail. Usage:
//   /defaults                     → show current + list of keys
//   /defaults <mode> <ctx> <det>  → set (keys come from prompts.ts)
async function handleDefaults(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
  args: string,
): Promise<void> {
  const chatId = message.chat.id;
  const current = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  });

  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const modeList = ALL_MODE_KEYS.map(
      (k) => `  ${k}${k === current.mode ? " (сейчас)" : ""}`,
    ).join("\n");
    const ctxList = ALL_CONTEXT_KEYS.map(
      (k) => `  ${k}${k === current.context ? " (сейчас)" : ""}`,
    ).join("\n");
    await sendMessage(
      chatId,
      `<b>Дефолты для этого чата</b>\n` +
        `Стиль: <code>${escapeHtml(current.mode)}</code>\n` +
        `Контекст: <code>${escapeHtml(current.context)}</code>\n` +
        `Детали: <code>${current.detail}</code>\n\n` +
        `Сменить: <code>/defaults &lt;mode&gt; &lt;context&gt; &lt;detail&gt;</code>\n\n` +
        `Доступные стили:\n${escapeHtml(modeList)}\n\n` +
        `Доступные контексты:\n${escapeHtml(ctxList)}\n\n` +
        `Детали: 1, 2 или 3`,
      { parseMode: "HTML" },
    );
    return;
  }
  if (parts.length < 3) {
    await sendMessage(
      chatId,
      "Использование: /defaults <mode> <context> <detail>",
      {},
    );
    return;
  }
  const [modeArg, ctxArg, detArg] = parts;
  if (!isModeKey(modeArg)) {
    await sendMessage(chatId, `Неизвестный стиль: ${modeArg}`, {});
    return;
  }
  if (!isContextKey(ctxArg)) {
    await sendMessage(chatId, `Неизвестный контекст: ${ctxArg}`, {});
    return;
  }
  const det = Number(detArg);
  if (!Number.isFinite(det) || !isDetail(det)) {
    await sendMessage(chatId, "Детали: 1, 2 или 3", {});
    return;
  }
  await ctx.runMutation(internal.chatSettings.set, {
    chatId,
    defaultMode: modeArg,
    defaultContext: ctxArg,
    defaultDetail: det,
  });
  await sendMessage(chatId, `Сохранено: ${modeArg} / ${ctxArg} / ${det}`, {});
}

// =====================================================================
// ============== Chat-summary picker (parallel to voice) ==============
// =====================================================================

interface ChatSummaryPickerState {
  summary: Doc<"chatSummaries">;
  session: { mode: ModeKey; context: ContextKey; detail: Detail };
  view: View;
  isRequester: boolean;
}

function renderChatSummaryHeader(s: Doc<"chatSummaries">): string {
  const parts: string[] = [`<b>Summary переписки</b>`];
  if (s.filterDescription) parts.push(escapeHtml(s.filterDescription));
  parts.push(`${s.messageIds.length} сообщений`);
  return parts.join(" · ");
}

function renderChatSummaryPickerMessage(
  state: ChatSummaryPickerState,
  summary: string,
): string {
  const rawHtml = markdownToTelegramHtml(summary);
  const summaryHtml = resolveMessageLinks(rawHtml, state.summary.chatId);
  const header = renderChatSummaryHeader(state.summary);
  const modeText = describeAutoSetting(
    state.session.mode,
    state.summary.autoMode,
    modeLabel,
  );
  const contextText = describeAutoSetting(
    state.session.context,
    state.summary.autoContext,
    contextLabel,
  );
  const settingsLine =
    `<i>Стиль:</i> ${escapeHtml(modeText)} · ` +
    `<i>Контекст:</i> ${escapeHtml(contextText)} · ` +
    `<i>Детали:</i> ${state.session.detail}`;
  const settingsBlock = `\n\n${settingsLine}`;
  const headerBlock = `${header}\n\n`;
  const limit = TG_TEXT_LIMIT - settingsBlock.length - headerBlock.length - 10;
  const body =
    summaryHtml.length > limit
      ? summaryHtml.slice(0, limit - 30) + "\n\n<i>(summary обрезан)</i>"
      : summaryHtml;
  return `${headerBlock}${body}${settingsBlock}`;
}

function renderChatSummaryLoading(state: ChatSummaryPickerState): string {
  const modeText = describeAutoSetting(
    state.session.mode,
    state.summary.autoMode,
    modeLabel,
  );
  const contextText = describeAutoSetting(
    state.session.context,
    state.summary.autoContext,
    contextLabel,
  );
  const settingsLine =
    `<i>Стиль:</i> ${escapeHtml(modeText)} · ` +
    `<i>Контекст:</i> ${escapeHtml(contextText)} · ` +
    `<i>Детали:</i> ${state.session.detail}`;
  const header = renderChatSummaryHeader(state.summary);
  return (
    `${header}\n\n${loadingEmoji()} <i>Готовлю summary переписки с новыми настройками…</i>` +
    `\n\n${settingsLine}`
  );
}

function buildChatSummaryKeyboard(
  state: ChatSummaryPickerState,
): InlineKeyboard {
  const sid = state.summary.shortId ?? "";

  if (state.view === "main") {
    const rows: InlineKeyboard = [];
    rows.push([
      {
        text: `📝 ${describeAutoButton(state.session.mode, state.summary.autoMode, modeLabel)}`,
        callback_data: `cv:${sid}:mode`,
      },
      {
        text: `🎭 ${describeAutoButton(state.session.context, state.summary.autoContext, contextLabel)}`,
        callback_data: `cv:${sid}:context`,
      },
      {
        text: `📊 ${state.session.detail}`,
        callback_data: `cv:${sid}:detail`,
      },
    ]);
    if (state.isRequester) {
      rows.push([{ text: "Применить в чат", callback_data: `ca:${sid}` }]);
    }
    return rows;
  }

  if (state.view === "mode") {
    return chatKeysKeyboard(
      ALL_MODE_KEYS,
      (k) => modeLabel(k),
      (k) => `csm:${sid}:${k}`,
      state.session.mode,
      `cbk:${sid}`,
    );
  }
  if (state.view === "context") {
    return chatKeysKeyboard(
      ALL_CONTEXT_KEYS,
      (k) => contextLabel(k),
      (k) => `csc:${sid}:${k}`,
      state.session.context,
      `cbk:${sid}`,
    );
  }
  return [
    ALL_DETAILS.map((d) => ({
      text: d === state.session.detail ? `✓ ${d}` : `${d}`,
      callback_data: `csd:${sid}:${d}`,
    })),
    [{ text: "← Назад", callback_data: `cbk:${sid}` }],
  ];
}

function chatKeysKeyboard<K extends string>(
  keys: readonly K[],
  label: (k: K) => string,
  data: (k: K) => string,
  active: K,
  backData: string,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(
      keys.slice(i, i + 2).map((k) => ({
        text: k === active ? `✓ ${label(k)}` : label(k),
        callback_data: data(k),
      })),
    );
  }
  rows.push([{ text: "← Назад", callback_data: backData }]);
  return rows;
}

// ---- Deep-link entry point -----------------------------------------------

async function handleChatSummaryDeepLink(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
  shortId: string,
): Promise<void> {
  if (!shortId) {
    await sendMessage(message.chat.id, "Битая ссылка.", {});
    return;
  }
  const summary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
    shortId,
  })) as Doc<"chatSummaries"> | null;
  if (!summary) {
    await sendMessage(message.chat.id, "Summary не найден.", {});
    return;
  }
  if (summary.messageIds.length === 0) {
    await sendMessage(
      message.chat.id,
      "Summary ещё не готов. Попробуйте через несколько секунд.",
      {},
    );
    return;
  }
  const userId = message.from?.id;
  if (!userId) return;

  const chatDefaults = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: summary.chatId,
  });
  const session = {
    mode: chatDefaults.mode,
    context: chatDefaults.context,
    detail: chatDefaults.detail as Detail,
  };

  const summaryText = await loadOrGenerateChatSummaryForSession(
    ctx,
    summary,
    session,
  );

  const state: ChatSummaryPickerState = {
    summary,
    session,
    view: "main",
    isRequester: userId === summary.requesterId,
  };
  const text = renderChatSummaryPickerMessage(state, summaryText);
  const keyboard = buildChatSummaryKeyboard(state);

  const sent = await sendMessage(message.chat.id, text, {
    parseMode: "HTML",
    inlineKeyboard: keyboard,
  });

  await ctx.runMutation(internal.chatSummarySession.upsert, {
    userId,
    chatSummaryShortId: shortId,
    mode: session.mode,
    context: session.context,
    detail: session.detail,
    pickerMessageId: sent.message_id,
    view: "main",
  });
}

// ---- Cache-aware summary loader for picker --------------------------------

function resolveAutoForChatSummarySession(
  summary: Doc<"chatSummaries">,
  session: { mode: ModeKey; context: ContextKey; detail: Detail },
): {
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
} | null {
  let mode: ModeKey = session.mode;
  let context: ContextKey = session.context;
  if (mode === "auto")
    mode = (summary.autoMode as ModeKey | undefined) ?? "brief";
  if (context === "auto") {
    context =
      (summary.autoContext as ContextKey | undefined) ?? "thinkingOutLoud";
  }
  if (mode === "auto" || context === "auto") return null;
  return {
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail: session.detail,
  };
}

async function loadOrGenerateChatSummaryForSession(
  ctx: { runQuery: any; runMutation: any },
  summary: Doc<"chatSummaries">,
  session: { mode: ModeKey; context: ContextKey; detail: Detail },
): Promise<string> {
  const concrete = resolveAutoForChatSummarySession(summary, session);
  if (!concrete) {
    return "Summary ещё не готов — подождите пару секунд и попробуйте ещё раз.";
  }
  const chatLog = await buildChatLogFor(ctx, summary);
  const memory = await ctx.runQuery(internal.chatMemory.get, {
    chatId: summary.chatId,
  });
  const loreRows = await ctx.runQuery(internal.chatLore.allForChat, {
    chatId: summary.chatId,
  });
  const lore =
    loreRows && loreRows.length > 0
      ? loreRows.map((r: any) => `- ${r.text}`).join("\n")
      : null;
  const { text } = await getOrGenerateChatSummary(ctx, summary._id, {
    chatLog,
    mode: concrete.mode,
    context: concrete.context,
    detail: concrete.detail,
    chatStyleNotes: memory?.notes ?? null,
    chatLore: lore,
  });
  return text;
}

// ---- Callback dispatch ---------------------------------------------------

async function handleChatSummaryCallback(
  ctx: { runMutation: any; runQuery: any; scheduler: any; runAction: any },
  cb: TgCallbackQuery,
  parts: string[],
): Promise<void> {
  if (parts[0] === "cv" && parts.length === 3) {
    const view = parts[2];
    if (view !== "mode" && view !== "context" && view !== "detail") {
      await answerCallbackQuery(cb.id);
      return;
    }
    await openChatSummarySubView(ctx, cb, parts[1], view);
    return;
  }
  if (parts[0] === "cbk" && parts.length === 2) {
    await backToChatSummaryMain(ctx, cb, parts[1]);
    return;
  }
  if (parts[0] === "csm" && parts.length === 3) {
    await setChatSummaryField(ctx, cb, parts[1], "mode", parts[2]);
    return;
  }
  if (parts[0] === "csc" && parts.length === 3) {
    await setChatSummaryField(ctx, cb, parts[1], "context", parts[2]);
    return;
  }
  if (parts[0] === "csd" && parts.length === 3) {
    await setChatSummaryField(ctx, cb, parts[1], "detail", parts[2]);
    return;
  }
  if (parts[0] === "ca" && parts.length === 2) {
    await applyChatSummaryToChat(ctx, cb, parts[1]);
    return;
  }
  await answerCallbackQuery(cb.id);
}

async function loadChatSummarySession(
  ctx: { runQuery: any },
  userId: number,
  shortId: string,
): Promise<Doc<"chatSummarySession"> | null> {
  return await ctx.runQuery(internal.chatSummarySession.get, {
    userId,
    chatSummaryShortId: shortId,
  });
}

async function openChatSummarySubView(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
  view: "mode" | "context" | "detail",
): Promise<void> {
  await answerCallbackQuery(cb.id);
  const summary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
    shortId,
  })) as Doc<"chatSummaries"> | null;
  if (!summary) return;
  const session = await loadChatSummarySession(ctx, cb.from.id, shortId);
  if (!session) return;
  const state: ChatSummaryPickerState = {
    summary,
    session: {
      mode: session.mode as ModeKey,
      context: session.context as ContextKey,
      detail: session.detail as Detail,
    },
    view,
    isRequester: cb.from.id === summary.requesterId,
  };
  const keyboard = buildChatSummaryKeyboard(state);
  await editMessageReplyMarkup(
    cb.message!.chat.id,
    cb.message!.message_id,
    keyboard,
  );
  await ctx.runMutation(internal.chatSummarySession.upsert, {
    userId: cb.from.id,
    chatSummaryShortId: shortId,
    mode: session.mode,
    context: session.context,
    detail: session.detail,
    pickerMessageId: cb.message!.message_id,
    view,
  });
}

async function backToChatSummaryMain(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  await answerCallbackQuery(cb.id);
  const summary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
    shortId,
  })) as Doc<"chatSummaries"> | null;
  if (!summary) return;
  const session = await loadChatSummarySession(ctx, cb.from.id, shortId);
  if (!session) return;
  const state: ChatSummaryPickerState = {
    summary,
    session: {
      mode: session.mode as ModeKey,
      context: session.context as ContextKey,
      detail: session.detail as Detail,
    },
    view: "main",
    isRequester: cb.from.id === summary.requesterId,
  };
  const keyboard = buildChatSummaryKeyboard(state);
  await editMessageReplyMarkup(
    cb.message!.chat.id,
    cb.message!.message_id,
    keyboard,
  );
  await ctx.runMutation(internal.chatSummarySession.upsert, {
    userId: cb.from.id,
    chatSummaryShortId: shortId,
    mode: session.mode,
    context: session.context,
    detail: session.detail,
    pickerMessageId: cb.message!.message_id,
    view: "main",
  });
}

async function setChatSummaryField(
  ctx: { runMutation: any; runQuery: any; runAction: any },
  cb: TgCallbackQuery,
  shortId: string,
  field: "mode" | "context" | "detail",
  rawValue: string,
): Promise<void> {
  const summary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
    shortId,
  })) as Doc<"chatSummaries"> | null;
  if (!summary) {
    await answerCallbackQuery(cb.id, "Summary не найден");
    return;
  }
  const prev = await loadChatSummarySession(ctx, cb.from.id, shortId);
  if (!prev) {
    await answerCallbackQuery(cb.id, "Сессия не найдена, /start заново");
    return;
  }

  const nextSession = {
    mode: prev.mode as ModeKey,
    context: prev.context as ContextKey,
    detail: prev.detail as Detail,
  };
  if (field === "mode") {
    if (!isModeKey(rawValue)) {
      await answerCallbackQuery(cb.id);
      return;
    }
    nextSession.mode = rawValue;
  } else if (field === "context") {
    if (!isContextKey(rawValue)) {
      await answerCallbackQuery(cb.id);
      return;
    }
    nextSession.context = rawValue;
  } else {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || !isDetail(n)) {
      await answerCallbackQuery(cb.id);
      return;
    }
    nextSession.detail = n;
  }

  await answerCallbackQuery(cb.id);

  const state: ChatSummaryPickerState = {
    summary,
    session: nextSession,
    view: "main",
    isRequester: cb.from.id === summary.requesterId,
  };
  const keyboard = buildChatSummaryKeyboard(state);
  const chatIdForEdit = cb.message!.chat.id;
  const messageIdForEdit = cb.message!.message_id;

  // Cache pre-check.
  const concrete = resolveAutoForChatSummarySession(summary, nextSession);
  let cachedHit = false;
  let summaryText: string | null = null;
  if (concrete) {
    const cached = await ctx.runQuery(internal.chatSummaryTexts.findCached, {
      chatSummaryId: summary._id,
      mode: concrete.mode,
      context: concrete.context,
      detail: concrete.detail,
    });
    if (cached) {
      cachedHit = true;
      summaryText = cached.text;
    }
  }

  if (!cachedHit) {
    const loadingText = renderChatSummaryLoading(state);
    await editMessageText(chatIdForEdit, messageIdForEdit, loadingText, {
      parseMode: "HTML",
      inlineKeyboard: keyboard,
    });
    summaryText = await loadOrGenerateChatSummaryForSession(
      ctx,
      summary,
      nextSession,
    );
  }

  const text = renderChatSummaryPickerMessage(state, summaryText ?? "");
  await editMessageText(chatIdForEdit, messageIdForEdit, text, {
    parseMode: "HTML",
    inlineKeyboard: keyboard,
  });

  await ctx.runMutation(internal.chatSummarySession.upsert, {
    userId: cb.from.id,
    chatSummaryShortId: shortId,
    mode: nextSession.mode,
    context: nextSession.context,
    detail: nextSession.detail,
    pickerMessageId: messageIdForEdit,
    view: "main",
  });
}

// Re-renders the source-chat /summary message with the requester's
// current settings. Mirror of applyToChat for voices.
async function applyChatSummaryToChat(
  ctx: { runMutation: any; runQuery: any; scheduler: any; runAction: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  const summary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
    shortId,
  })) as Doc<"chatSummaries"> | null;
  if (!summary) {
    await answerCallbackQuery(cb.id, "Summary не найден");
    return;
  }
  if (cb.from.id !== summary.requesterId) {
    await answerCallbackQuery(
      cb.id,
      "Только тот, кто запросил /summary, может менять отображение в чате",
      true,
    );
    return;
  }
  const session = await loadChatSummarySession(ctx, cb.from.id, shortId);
  if (!session) {
    await answerCallbackQuery(cb.id, "Сессия не найдена, /start заново");
    return;
  }
  await answerCallbackQuery(cb.id, "Обновляю в чате…");

  let mode = session.mode as ModeKey;
  let context = session.context as ContextKey;
  if (mode === "auto")
    mode = (summary.autoMode as ModeKey | undefined) ?? "brief";
  if (context === "auto") {
    context =
      (summary.autoContext as ContextKey | undefined) ?? "thinkingOutLoud";
  }
  if (mode === "auto" || context === "auto") return;
  const detail = session.detail as Detail;

  const debugMode = await ctx.runQuery(internal.botConfig.getDebugMode, {});
  const chatLog = await buildChatLogFor(ctx, summary);
  const memory = await ctx.runQuery(internal.chatMemory.get, {
    chatId: summary.chatId,
  });
  const loreRows = await ctx.runQuery(internal.chatLore.allForChat, {
    chatId: summary.chatId,
  });
  const lore =
    loreRows && loreRows.length > 0
      ? loreRows.map((r: any) => `- ${r.text}`).join("\n")
      : null;
  const { text: summaryText } = await getOrGenerateChatSummary(
    ctx,
    summary._id,
    {
      chatLog,
      mode: mode as Exclude<ModeKey, "auto">,
      context: context as Exclude<ContextKey, "auto">,
      detail,
      chatStyleNotes: memory?.notes ?? null,
      chatLore: lore,
    },
  );

  await ctx.runMutation(internal.chatSummaries.setDisplayed, {
    id: summary._id,
    mode,
    context,
    detail,
  });

  const botUsername = await ctx.runQuery(internal.botConfig.getBotUsername, {});
  const rendered = renderChatSummaryFinal({
    chatId: summary.chatId,
    summaryText,
    chatLog,
    filterDescription: summary.filterDescription ?? "выбранные сообщения",
    messageCount: summary.messageIds.length,
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail,
    wasAutoMode: session.mode === "auto",
    wasAutoContext: session.context === "auto",
    debug: debugMode,
  });
  const keyboard = buildChatSummaryButton(botUsername, summary.shortId);
  await commitFinal({
    chatId: summary.chatId,
    ackId: summary.ackMessageId,
    replyTo: summary.requestMessageId,
    ...rendered,
    keyboard,
  });
}
