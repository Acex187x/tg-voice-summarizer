import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  isSummarizeModelKey,
  SUMMARIZE_MODEL_OPTIONS,
  summarizeModelId,
  TRANSCRIBE_MODEL,
  type SummarizeModelKey,
} from "./models";
import { transcribeAudioWithTimestamps } from "./openai";
import {
  answerSummaryQuestion,
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
  sendBusinessTranscript,
} from "./processing";
import {
  ALL_CONTEXT_KEYS,
  ALL_DETAILS,
  ALL_MODE_KEYS,
  AUTO_LABEL,
  CONTEXTS,
  contextLabel,
  DETAIL_LEVELS,
  formatTimecode,
  formatTimestampedTranscript,
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
  deleteEphemeralMessage,
  deleteMessage,
  downloadFile,
  editEphemeralMessageText,
  editGuestMessageText,
  editMessageReplyMarkup,
  editMessageText,
  escapeHtml,
  getFilePath,
  loadingEmoji,
  markdownToTelegramHtml,
  resolveMessageLinks,
  sendEphemeralMessage,
  sendMessage,
  setMessageReaction,
  splitHtmlSafely,
  splitTextSafely,
  TG_TEXT_LIMIT,
  type InlineKeyboard,
} from "./telegram";
import type { ResolvedChatSettings } from "./chatSettings";

// Minimal Telegram update typing — only the fields we read.
type TgUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};
type TgChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  // Private chats (incl. business-managed conversations).
  first_name?: string;
  last_name?: string;
};
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
type TgEntity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
};
type TgMessage = {
  message_id: number;
  date?: number;
  business_connection_id?: string;
  guest_query_id?: string;
  guest_bot_caller_user?: TgUser;
  guest_bot_caller_chat?: TgChat;
  // Bot API 10.2: set for incoming ephemeral messages (ephemeral commands).
  // Such messages have message_id 0 and are invisible in the chat.
  ephemeral_message_id?: number;
  from?: TgUser;
  // Set when the message is sent on behalf of a chat: channel-identity
  // messages in the discussion group and (with is_automatic_forward)
  // channel posts auto-forwarded there.
  sender_chat?: TgChat;
  is_automatic_forward?: boolean;
  chat: TgChat;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
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
type TgReactionType = {
  type: string; // "emoji" | "custom_emoji" | "paid"
  emoji?: string;
  custom_emoji_id?: string;
};
type TgMessageReaction = {
  chat: TgChat;
  message_id: number;
  user?: TgUser;
  date?: number;
  old_reaction?: TgReactionType[];
  new_reaction?: TgReactionType[];
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
  message_reaction?: TgMessageReaction;
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

/settings — настройки бота: в группе — режим ответа/реакция/модель, в личке — бизнес-переписки и дефолты
/reaction <эмодзи> — сменить реакцию-триггер режима «по требованию»
/defaults — показать/изменить дефолтные настройки summary для этого чата
/debug [on|off] — дебаг-режим
/whoami — ваш Telegram ID и ID этого чата
/summarize — ответьте этой командой на голосовое или видеокружок, чтобы пересобрать summary
/search <запрос> — найти сообщения в истории чата по смыслу
/ask <вопрос> — коротко ответить на вопрос по истории чата с доказательными ссылками
/modal — выбрать модель суммаризации для чата (эфемерный переключатель)
/quiet — переключить режим «по требованию» (алиас для /settings)
/importdump — загрузить Telegram JSON export (result.json) и проиндексировать историю
/indexstats — статистика покрытия БД и векторного индекса для этого чата
/indexstats rebuild — пересобрать сохранённые счётчики
/reindex — переиндексировать сохранённые сообщения этого чата
/help — это сообщение

Тег бота ответом на голосовое в любом режиме постит его расшифровку в чат.

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

    // Reactions (bot must be a chat admin to receive these). Powers the
    // quiet-mode "react to get an ephemeral summary" flow.
    if (u.message_reaction) {
      await handleMessageReaction(ctx, u.message_reaction);
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
    if (!isPrivateChat && message.ephemeral_message_id === undefined) {
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

    // 3a-bis. Chat-settings commands. All registered as ephemeral commands
    // (invisible in chat); any group member can use them. /modal and
    // /quiet are legacy aliases for parts of /settings. In the bot's DM
    // /settings opens the private-mode panel (business conversations +
    // personal defaults).
    if (/^\/settings(?:@[\w_]+)?(?:\s|$)/i.test(commandText)) {
      if (isPrivateChat) {
        await handleDmSettingsCommand(ctx, message);
      } else {
        await handleSettingsCommand(ctx, message);
      }
      return;
    }
    if (
      !isPrivateChat &&
      /^\/reaction(?:@[\w_]+)?(?:\s|$)/i.test(commandText)
    ) {
      await handleReactionCommand(ctx, message, commandText);
      return;
    }
    if (!isPrivateChat && /^\/modal(?:@[\w_]+)?(?:\s|$)/i.test(commandText)) {
      await handleModalCommand(ctx, message);
      return;
    }
    if (!isPrivateChat && /^\/quiet(?:@[\w_]+)?(?:\s|$)/i.test(commandText)) {
      await handleQuietCommand(ctx, message);
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

    // 3c. Bot mention replying to a voice — ALWAYS answers with a public
    // transcription/summary of that voice, regardless of the chat's
    // delivery mode. (When the bot is not in the chat, the same summon
    // arrives as a guest_message and is handled above.)
    if (!isPrivateChat && message.reply_to_message) {
      const handledMention = await maybeHandleVoiceMentionSummon(
        ctx,
        message,
        commandText,
      );
      if (handledMention) return;
    }

    // 3d. Reply-to-summary Q&A — any group member replying (plain text,
    // not a command) to one of the bot's summary or Q&A messages gets an
    // answer grounded in the summary + full transcript/log.
    if (
      !isPrivateChat &&
      message.reply_to_message &&
      !commandText.startsWith("/")
    ) {
      const handled = await maybeAnswerSummaryReply(ctx, message, commandText);
      if (handled) return;
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

// Human-readable name of the peer in a managed private conversation.
function businessPeerName(chat: TgChat): string | undefined {
  return (
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
    chat.title ||
    (chat.username ? `@${chat.username}` : undefined)
  );
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

  // Direction: the owner's own voices are "outgoing" (they can be
  // auto-transcribed into the conversation for the peer); everything else
  // is incoming from the peer.
  const outgoing = message.from?.id === connection.userId;

  // Materialize/refresh the conversation row so the owner's DM /settings
  // panel lists it with its toggle.
  await ctx.runMutation(internal.businessChatSettings.upsertSeen, {
    connectionId: message.business_connection_id,
    peerChatId: message.chat.id,
    peerName: businessPeerName(message.chat),
  });

  await handleVoice(ctx, message, media, {
    businessConnectionId: message.business_connection_id,
    businessUserChatId: connection.userChatId,
    businessOutgoing: outgoing,
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
    // No voice anywhere in sight. This fires not only on genuine
    // mis-summons but on EVERY reply to the bot's own guest answer —
    // Telegram sends those as guest updates too, and answering them used
    // to drop a stray system-looking message into the group. Ignore
    // silently: an unanswered guest query just expires without a trace.
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
    let segments = voice.transcriptSegments ?? [];
    if (!transcript) {
      const filePath = await getFilePath(media.fileId);
      const audio = await downloadFile(filePath);
      const result = await transcribeAudioWithTimestamps(
        audio,
        TRANSCRIBE_MODEL,
        "voice.ogg",
      );
      transcript = result.text;
      segments = result.segments;
      if (!transcript) throw new Error("Whisper returned empty transcript");
      await ctx.runMutation(internal.voiceMessages.setTranscript, {
        id: voice._id,
        transcript,
        segments,
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
    const guestChatSettings = await ctx.runQuery(
      internal.chatSettings.getResolved,
      { chatId: voice.chatId },
    );
    const summaryArgs = {
      transcript,
      segments,
      durationSec: voice.durationSec ?? null,
      mode: settings.mode,
      context: settings.context,
      detail: settings.detail,
      chatStyleNotes: memory?.notes ?? null,
      chatLore: lore,
      modelId: summarizeModelId(guestChatSettings.summarizeModelKey),
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
    voice.durationSec,
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

type VoiceDelivery = "instant" | "instantSilent" | "onDemand";

// True for messages that carry a channel identity: channel posts
// auto-forwarded into the linked discussion group, and messages sent into
// the group "as the channel".
function isChannelSenderMessage(message: TgMessage): boolean {
  return (
    message.is_automatic_forward === true ||
    message.sender_chat?.type === "channel"
  );
}

async function handleVoice(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
  media: MediaInfo,
  opts: {
    businessConnectionId?: string;
    businessUserChatId?: number;
    businessOutgoing?: boolean;
    privateResult?: boolean;
    // Bot-mention summon: always answer publicly with a placeholder, no
    // matter what the chat's delivery mode says.
    forceInstant?: boolean;
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

  const ackChatId = opts.privateResult
    ? opts.businessUserChatId
    : message.chat.id;

  // Resolve the delivery plan for this specific voice.
  const isGroup = !opts.privateResult && message.chat.type !== "private";
  let delivery: VoiceDelivery = "instant";
  let triggerReaction: { type: "emoji" | "custom_emoji"; value: string } = {
    type: "emoji",
    value: "👀",
  };
  if (isGroup) {
    const settings = await ctx.runQuery(internal.chatSettings.getResolved, {
      chatId: message.chat.id,
    });
    triggerReaction = {
      type: settings.reaction.type,
      value: settings.reaction.value,
    };
    if (opts.forceInstant) {
      delivery = "instant";
    } else if (isChannelSenderMessage(message)) {
      // Channel voices: always instant with a visible placeholder (when
      // the toggle is on) — the on-demand and silent modes don't apply to
      // channel posts / channel-identity voices.
      delivery = settings.channelVoicesInstant
        ? "instant"
        : settings.deliveryMode === "onDemand"
          ? "onDemand"
          : settings.skipLoadingMessage
            ? "instantSilent"
            : "instant";
    } else if (settings.deliveryMode === "onDemand") {
      delivery = "onDemand";
    } else if (settings.skipLoadingMessage) {
      delivery = "instantSilent";
    }
  }

  let ackMessageId: number | undefined;
  if (ackChatId !== undefined && delivery === "instant") {
    const label = opts.privateResult
      ? "Обрабатываю голосовое из личной переписки…"
      : media.kind === "video_note"
        ? "Обрабатываю видеокружок…"
        : media.kind === "audio"
          ? "Обрабатываю аудио…"
          : "Обрабатываю голосовое…";
    const ackText = `${loadingEmoji()}  <i>${escapeHtml(label)}</i>`;
    try {
      if (opts.privateResult) {
        // Business voices: the placeholder lands in the OWNER's DM, but as
        // an EXTERNAL reply to the voice in the managed conversation — the
        // quote header is a one-tap jump into that dialog. Cross-chat
        // replies can't fall back automatically, so retry plain on error.
        let ack: { message_id: number };
        try {
          ack = await sendMessage(ackChatId, ackText, {
            replyToChatId: message.chat.id,
            replyToMessageId: message.message_id,
            parseMode: "HTML",
          });
        } catch {
          ack = await sendMessage(ackChatId, ackText, { parseMode: "HTML" });
        }
        ackMessageId = ack.message_id;
      } else {
        const ack = await sendMessage(ackChatId, ackText, {
          replyToMessageId: message.message_id,
          parseMode: "HTML",
        });
        ackMessageId = ack.message_id;
      }
    } catch (err) {
      console.warn("Failed to send ack placeholder", err);
    }
  }

  // Silent-instant: the trigger reaction doubles as the "seen, working on
  // it" indicator — up immediately, cleared when the summary is posted.
  if (delivery === "instantSilent") {
    await setMessageReaction(
      message.chat.id,
      message.message_id,
      triggerReaction,
    );
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
    businessOutgoing: opts.businessOutgoing,
    delivery,
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

// ---- /modal: per-chat summarizer model toggle -----------------------------

function renderModalPanel(activeKey: SummarizeModelKey): string {
  const lines = (
    Object.keys(SUMMARIZE_MODEL_OPTIONS) as SummarizeModelKey[]
  ).map((key) => {
    const opt = SUMMARIZE_MODEL_OPTIONS[key];
    return `${key === activeKey ? "●" : "○"} ${opt.label} — <code>${opt.id}</code>`;
  });
  return `<b>Модель суммаризации в этом чате</b>\n${lines.join("\n")}`;
}

function buildModalKeyboard(
  chatId: number,
  activeKey: SummarizeModelKey,
  ephemeralId: number,
): InlineKeyboard {
  return [
    (Object.keys(SUMMARIZE_MODEL_OPTIONS) as SummarizeModelKey[]).map(
      (key) => ({
        text:
          key === activeKey
            ? `✓ ${SUMMARIZE_MODEL_OPTIONS[key].label}`
            : SUMMARIZE_MODEL_OPTIONS[key].label,
        callback_data: `mm:${chatId}:${key}:${ephemeralId}`,
      }),
    ),
  ];
}

async function handleModalCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;
  const settings = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  });
  const text = renderModalPanel(settings.summarizeModelKey);

  // Ephemeral path: works when /modal came in as an ephemeral command
  // (reply within 15s) or when the bot is a chat admin.
  const eph = await sendEphemeralMessage(chatId, userId, text, {
    parseMode: "HTML",
    inlineKeyboard: buildModalKeyboard(chatId, settings.summarizeModelKey, 0),
    replyToEphemeralMessageId: message.ephemeral_message_id,
  });
  if (eph?.ephemeral_message_id) {
    // Re-issue the keyboard with the real ephemeral id baked into the
    // callback data, so toggles can edit this panel in place.
    await editEphemeralMessageText(
      chatId,
      userId,
      eph.ephemeral_message_id,
      text,
      {
        parseMode: "HTML",
        inlineKeyboard: buildModalKeyboard(
          chatId,
          settings.summarizeModelKey,
          eph.ephemeral_message_id,
        ),
      },
    );
    return;
  }
  if (!eph) {
    await sendMessage(chatId, text, {
      parseMode: "HTML",
      inlineKeyboard: buildModalKeyboard(chatId, settings.summarizeModelKey, 0),
      replyToMessageId: message.message_id || undefined,
    });
  }
}

// mm:<chatId>:<modelKey>:<ephemeralId>
async function handleModalCallback(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  parts: string[],
): Promise<void> {
  if (parts.length !== 4) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const chatId = Number(parts[1]);
  const key = parts[2];
  const ephemeralId = Number(parts[3]);
  if (!Number.isFinite(chatId) || !isSummarizeModelKey(key)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  await ctx.runMutation(internal.chatSettings.setSummarizeModel, {
    chatId,
    modelKey: key,
  });
  await answerCallbackQuery(
    cb.id,
    `Модель: ${SUMMARIZE_MODEL_OPTIONS[key].label}`,
  );
  const text = renderModalPanel(key);
  const keyboard = buildModalKeyboard(chatId, key, ephemeralId);
  if (ephemeralId) {
    await editEphemeralMessageText(chatId, cb.from.id, ephemeralId, text, {
      parseMode: "HTML",
      inlineKeyboard: keyboard,
    });
  } else if (cb.message) {
    await editMessageText(cb.message.chat.id, cb.message.message_id, text, {
      parseMode: "HTML",
      inlineKeyboard: keyboard,
    });
  }
}

// ---- /quiet: legacy alias for the on-demand delivery mode -----------------

async function handleQuietCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;
  const enabled: boolean = await ctx.runMutation(
    internal.chatSettings.toggleQuietMode,
    { chatId },
  );
  const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  })) as ResolvedChatSettings;
  const text = enabled
    ? `👀 Режим «по требованию» включён. Summary больше не постятся в чат: обработанное голосовое бот помечает реакцией ${settings.reaction.display}, а ваша такая же реакция на голосовое присылает вам расшифровку эфемерно — видно только вам. Тег бота ответом на голосовое всё равно постит расшифровку публично. Подробнее: /settings`
    : "📨 Режим «по требованию» выключен — summary снова постятся в чат. Подробнее: /settings";
  const eph = await sendEphemeralMessage(chatId, userId, text, {
    replyToEphemeralMessageId: message.ephemeral_message_id,
  });
  if (!eph) {
    await sendMessage(chatId, text, {
      replyToMessageId: message.message_id || undefined,
    });
  }
}

// ---- /settings: chat settings panel (Bot API 9.4/10.3 styled buttons) -----

type SettingsView =
  | "main"
  | "delivery"
  | "reaction"
  | "model"
  | "defMode"
  | "defContext"
  | "defDetail";

// Preset trigger reactions offered in the menu. All are from Telegram's
// allowed plain-reaction set; anything else (incl. premium custom emoji)
// goes through /reaction.
const REACTION_PRESETS = ["👀", "✍", "👍", "🔥", "⚡", "💯", "🎉", "🤝"];

// Telegram's fixed set of plain-emoji reactions (Bot API ReactionTypeEmoji).
// A plain reaction outside this set is a hard 400 from setMessageReaction.
const ALLOWED_REACTION_EMOJI = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢",
  "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
  "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
  "😡",
]);

function deliveryModeLabel(s: ResolvedChatSettings): string {
  return s.deliveryMode === "onDemand" ? "По требованию" : "Сразу в чат";
}

function settingsCb(chatId: number, ephId: number, op: string): string {
  return `st:${chatId}:${ephId}:${op}`;
}

function renderSettingsText(
  view: SettingsView,
  s: ResolvedChatSettings,
): string {
  const header = `<b>⚙️ Настройки бота в этом чате</b>`;
  switch (view) {
    case "delivery":
      return (
        `${header}\n\n<b>Режим ответа на голосовые</b>\n\n` +
        `📨 <b>Сразу в чат</b> — бот отвечает на голосовое сообщением с загрузкой и превращает его в summary. Классика.\n\n` +
        `👀 <b>По требованию</b> — бот ничего не постит. Когда расшифровка готова, он ставит на голосовое реакцию ${escapeHtml(s.reaction.display)}. Поставьте такую же реакцию — и получите расшифровку эфемерным сообщением, которое видите только вы.\n\n` +
        `Для режима «по требованию» бот должен быть <b>админом чата</b> (реакции и эфемерные сообщения), а реакция ${escapeHtml(s.reaction.display)} — разрешена в чате.\n\n` +
        `В любом режиме: тег бота ответом на голосовое постит его расшифровку публично. Войсы от имени канала управляются отдельной настройкой.`
      );
    case "reaction":
      return (
        `${header}\n\n<b>Реакция-триггер</b>\n\nСейчас: ${escapeHtml(s.reaction.display)}${s.reaction.type === "custom_emoji" ? " (премиум-эмодзи)" : ""}\n\n` +
        `Этой реакцией бот помечает обработанные голосовые в режиме «по требованию», и её же ставят участники, чтобы получить расшифровку.\n\n` +
        `Любую другую реакцию (включая премиум) можно задать командой:\n<code>/reaction &lt;эмодзи&gt;</code>\n\n` +
        `Реакция должна быть разрешена в настройках чата, иначе Telegram не даст её поставить.`
      );
    case "model":
      return `${header}\n\n<b>Модель суммаризации</b>\n\nКакая LLM пишет summary в этом чате.`;
    case "defMode":
      return `${header}\n\n<b>Стиль summary по умолчанию</b>\n\n«Авто» — роутер выбирает стиль по содержанию голосового.`;
    case "defContext":
      return `${header}\n\n<b>Контекст по умолчанию</b>\n\n«Авто» — роутер определяет контекст по содержанию.`;
    case "defDetail":
      return `${header}\n\n<b>Детальность по умолчанию</b>\n\n1 — кратко, 3 — подробно.`;
    default: {
      const lines = [
        header,
        "",
        `📬 Режим: <b>${deliveryModeLabel(s)}</b>`,
        s.deliveryMode === "onDemand"
          ? `— бот помечает готовые голосовые реакцией ${escapeHtml(s.reaction.display)}; такая же реакция участника присылает ему расшифровку эфемерно.`
          : s.skipLoadingMessage
            ? `— без сообщения о загрузке: бот ставит ${escapeHtml(s.reaction.display)} пока обрабатывает и постит готовый summary.`
            : `— бот отвечает сообщением с загрузкой и превращает его в summary.`,
        `📣 Войсы от имени канала: <b>${s.channelVoicesInstant ? "всегда сразу в чат" : "по общему режиму"}</b>`,
        `🧠 Модель: <b>${escapeHtml(SUMMARIZE_MODEL_OPTIONS[s.summarizeModelKey].label)}</b>`,
        "",
        `Тег бота ответом на голосовое в любом режиме постит расшифровку публично.`,
      ];
      return lines.join("\n");
    }
  }
}

function buildSettingsKeyboard(
  view: SettingsView,
  s: ResolvedChatSettings,
  chatId: number,
  ephId: number,
): InlineKeyboard {
  const cb = (op: string) => settingsCb(chatId, ephId, op);
  const backRow = [{ text: "← Назад", callback_data: cb("m") }];

  if (view === "delivery") {
    const active = s.deliveryMode;
    return [
      [
        active === "instant"
          ? { text: "✓ 📨 Сразу в чат", style: "success" as const, disabled: {} }
          : { text: "📨 Сразу в чат", callback_data: cb("di") },
      ],
      [
        active === "onDemand"
          ? {
              text: `✓ ${s.reaction.display} По требованию`,
              style: "success" as const,
              disabled: {},
            }
          : {
              text: `${s.reaction.display} По требованию`,
              callback_data: cb("do"),
            },
      ],
      backRow,
    ];
  }

  if (view === "reaction") {
    const rows: InlineKeyboard = [];
    for (let i = 0; i < REACTION_PRESETS.length; i += 4) {
      rows.push(
        REACTION_PRESETS.slice(i, i + 4).map((emoji) =>
          s.reaction.type === "emoji" && s.reaction.value === emoji
            ? { text: `✓ ${emoji}`, style: "success" as const, disabled: {} }
            : { text: emoji, callback_data: cb(`rs:${emoji}`) },
        ),
      );
    }
    rows.push(backRow);
    return rows;
  }

  if (view === "model") {
    const rows: InlineKeyboard = (
      Object.keys(SUMMARIZE_MODEL_OPTIONS) as SummarizeModelKey[]
    ).map((key) => [
      key === s.summarizeModelKey
        ? {
            text: `✓ ${SUMMARIZE_MODEL_OPTIONS[key].label}`,
            style: "success" as const,
            disabled: {},
          }
        : {
            text: SUMMARIZE_MODEL_OPTIONS[key].label,
            callback_data: cb(`os:${key}`),
          },
    ]);
    rows.push(backRow);
    return rows;
  }

  if (view === "defMode" || view === "defContext") {
    const keys: readonly string[] =
      view === "defMode" ? ALL_MODE_KEYS : ALL_CONTEXT_KEYS;
    const label = view === "defMode" ? modeLabel : contextLabel;
    const active = view === "defMode" ? s.mode : s.context;
    const op = view === "defMode" ? "fms" : "fcs";
    const rows: InlineKeyboard = [];
    for (let i = 0; i < keys.length; i += 2) {
      rows.push(
        keys.slice(i, i + 2).map((k) =>
          k === active
            ? {
                text: `✓ ${label(k as any)}`,
                style: "success" as const,
                disabled: {},
              }
            : { text: label(k as any), callback_data: cb(`${op}:${k}`) },
        ),
      );
    }
    rows.push(backRow);
    return rows;
  }

  if (view === "defDetail") {
    return [
      ALL_DETAILS.map((d) =>
        d === s.detail
          ? { text: `✓ ${d}`, style: "success" as const, disabled: {} }
          : { text: `${d}`, callback_data: cb(`fds:${d}`) },
      ),
      backRow,
    ];
  }

  // Main view.
  const isOnDemand = s.deliveryMode === "onDemand";
  const rows: InlineKeyboard = [
    [
      {
        text: `📬 Режим: ${deliveryModeLabel(s)}`,
        style: "primary" as const,
        callback_data: cb("d"),
      },
    ],
    [
      // The loading toggle only matters in instant mode — in on-demand
      // it's inert, so render it as a disabled (grey) button.
      isOnDemand
        ? { text: "⏳ Загрузка: — (режим «по требованию»)", disabled: {} }
        : s.skipLoadingMessage
          ? { text: "⏳ Сообщение о загрузке: выкл", callback_data: cb("tl") }
          : {
              text: "⏳ Сообщение о загрузке: вкл",
              style: "success" as const,
              callback_data: cb("tl"),
            },
    ],
    [
      s.channelVoicesInstant
        ? {
            text: "📣 Войсы канала: всегда сразу",
            style: "success" as const,
            callback_data: cb("tc"),
          }
        : { text: "📣 Войсы канала: по общему режиму", callback_data: cb("tc") },
    ],
    [
      { text: `Реакция: ${s.reaction.display}`, callback_data: cb("r") },
      {
        text: `🧠 ${SUMMARIZE_MODEL_OPTIONS[s.summarizeModelKey].label}`,
        callback_data: cb("o"),
      },
    ],
    [
      { text: `📝 ${modeLabel(s.mode as any)}`, callback_data: cb("fm") },
      { text: `🎭 ${contextLabel(s.context as any)}`, callback_data: cb("fc") },
      { text: `📊 ${s.detail}`, callback_data: cb("fd") },
    ],
    [{ text: "✖️ Закрыть", style: "danger" as const, callback_data: cb("x") }],
  ];
  return rows;
}

async function handleSettingsCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;
  const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  })) as ResolvedChatSettings;
  const text = renderSettingsText("main", settings);

  // Ephemeral path: works when /settings came in as an ephemeral command
  // (reply within 15s) or when the bot is a chat admin. The keyboard is
  // sent twice — first with a placeholder ephemeral id, then re-issued
  // with the real id baked into callback_data so button presses can edit
  // the panel in place.
  const eph = await sendEphemeralMessage(chatId, userId, text, {
    parseMode: "HTML",
    inlineKeyboard: buildSettingsKeyboard("main", settings, chatId, 0),
    replyToEphemeralMessageId: message.ephemeral_message_id,
  });
  if (eph?.ephemeral_message_id) {
    await editEphemeralMessageText(
      chatId,
      userId,
      eph.ephemeral_message_id,
      text,
      {
        parseMode: "HTML",
        inlineKeyboard: buildSettingsKeyboard(
          "main",
          settings,
          chatId,
          eph.ephemeral_message_id,
        ),
      },
    );
    return;
  }
  if (!eph) {
    await sendMessage(chatId, text, {
      parseMode: "HTML",
      inlineKeyboard: buildSettingsKeyboard("main", settings, chatId, 0),
      replyToMessageId: message.message_id || undefined,
    });
  }
}

// st:<chatId>:<ephId>:<op>[:<value>]
async function handleSettingsCallback(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  parts: string[],
): Promise<void> {
  if (parts.length < 4) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const chatId = Number(parts[1]);
  const ephId = Number(parts[2]);
  const op = parts[3];
  const value = parts[4];
  if (!Number.isFinite(chatId) || !Number.isFinite(ephId)) {
    await answerCallbackQuery(cb.id);
    return;
  }

  if (op === "x") {
    await answerCallbackQuery(cb.id);
    if (ephId) {
      await deleteEphemeralMessage(chatId, cb.from.id, ephId);
    } else if (cb.message) {
      await deleteMessage(cb.message.chat.id, cb.message.message_id);
    }
    return;
  }

  let view: SettingsView = "main";
  let toast: string | undefined;

  switch (op) {
    case "m":
      view = "main";
      break;
    case "d":
      view = "delivery";
      break;
    case "di":
    case "do": {
      const next = op === "di" ? "instant" : "onDemand";
      await ctx.runMutation(internal.chatSettings.update, {
        chatId,
        deliveryMode: next,
      });
      toast =
        next === "onDemand" ? "Режим: по требованию" : "Режим: сразу в чат";
      view = "delivery";
      break;
    }
    case "tl": {
      const cur = (await ctx.runQuery(internal.chatSettings.getResolved, {
        chatId,
      })) as ResolvedChatSettings;
      await ctx.runMutation(internal.chatSettings.update, {
        chatId,
        skipLoadingMessage: !cur.skipLoadingMessage,
      });
      toast = cur.skipLoadingMessage
        ? "Сообщение о загрузке включено"
        : "Сообщение о загрузке выключено — вместо него реакция";
      view = "main";
      break;
    }
    case "tc": {
      const cur = (await ctx.runQuery(internal.chatSettings.getResolved, {
        chatId,
      })) as ResolvedChatSettings;
      await ctx.runMutation(internal.chatSettings.update, {
        chatId,
        channelVoicesInstant: !cur.channelVoicesInstant,
      });
      toast = cur.channelVoicesInstant
        ? "Войсы канала — по общему режиму"
        : "Войсы канала — всегда сразу в чат";
      view = "main";
      break;
    }
    case "r":
      view = "reaction";
      break;
    case "rs": {
      if (value && ALLOWED_REACTION_EMOJI.has(value)) {
        await ctx.runMutation(internal.chatSettings.update, {
          chatId,
          reactionType: "emoji",
          reactionValue: value,
          reactionDisplay: value,
        });
        toast = `Реакция: ${value}`;
      }
      view = "reaction";
      break;
    }
    case "o":
      view = "model";
      break;
    case "os": {
      if (value && isSummarizeModelKey(value)) {
        await ctx.runMutation(internal.chatSettings.setSummarizeModel, {
          chatId,
          modelKey: value,
        });
        toast = `Модель: ${SUMMARIZE_MODEL_OPTIONS[value].label}`;
      }
      view = "model";
      break;
    }
    case "fm":
      view = "defMode";
      break;
    case "fms": {
      if (value && isModeKey(value)) {
        await ctx.runMutation(internal.chatSettings.update, {
          chatId,
          defaultMode: value,
        });
        toast = `Стиль: ${modeLabel(value)}`;
      }
      view = "defMode";
      break;
    }
    case "fc":
      view = "defContext";
      break;
    case "fcs": {
      if (value && isContextKey(value)) {
        await ctx.runMutation(internal.chatSettings.update, {
          chatId,
          defaultContext: value,
        });
        toast = `Контекст: ${contextLabel(value)}`;
      }
      view = "defContext";
      break;
    }
    case "fd":
      view = "defDetail";
      break;
    case "fds": {
      const n = Number(value);
      if (Number.isFinite(n) && isDetail(n)) {
        await ctx.runMutation(internal.chatSettings.update, {
          chatId,
          defaultDetail: n,
        });
        toast = `Детальность: ${n}`;
      }
      view = "defDetail";
      break;
    }
    default:
      break;
  }

  await answerCallbackQuery(cb.id, toast);

  // Private chats (positive ids) have their own main panel — the group
  // main view is full of group-only toggles. Submenus (model, defaults)
  // are shared between both panels.
  const isPrivatePanel = chatId > 0;
  let text: string;
  let keyboard: InlineKeyboard;
  if (isPrivatePanel && view === "main") {
    const panel = await renderDmSettingsPanel(ctx, cb.from.id, chatId);
    text = panel.text;
    keyboard = panel.keyboard;
  } else {
    const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
      chatId,
    })) as ResolvedChatSettings;
    text = renderSettingsText(view, settings);
    keyboard = buildSettingsKeyboard(view, settings, chatId, ephId);
  }
  if (ephId) {
    await editEphemeralMessageText(chatId, cb.from.id, ephId, text, {
      parseMode: "HTML",
      inlineKeyboard: keyboard,
    });
  } else if (cb.message) {
    await editMessageText(cb.message.chat.id, cb.message.message_id, text, {
      parseMode: "HTML",
      inlineKeyboard: keyboard,
    });
  }
}

// ---- DM /settings: private-mode panel (business + personal defaults) ------

// The bot DM has no delivery modes or reactions — voices are always
// answered instantly and everything is private already. What it does have:
// the summarizer model + default style for the owner's voices (both DM and
// business ones), and per-conversation toggles for Telegram Business mode.
async function renderDmSettingsPanel(
  ctx: { runQuery: any },
  userId: number,
  chatId: number,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  })) as ResolvedChatSettings;
  const connection = await ctx.runQuery(
    internal.businessConnections.findEnabledByUser,
    { userId },
  );
  const conversations = connection
    ? await ctx.runQuery(internal.businessChatSettings.listByConnection, {
        connectionId: connection.connectionId,
        limit: 15,
      })
    : [];

  const lines: string[] = [
    "<b>⚙️ Настройки в личке</b>",
    "",
    `🧠 Модель: <b>${escapeHtml(SUMMARIZE_MODEL_OPTIONS[settings.summarizeModelKey].label)}</b> · стиль/контекст/детали ниже — применяются к вашим войсам в личке и в бизнес-переписках.`,
    "",
  ];
  if (!connection) {
    lines.push(
      "<i>Подключите бота как менеджера аккаунта (Telegram → Настройки → Telegram Business → Чат-боты), и здесь появятся ваши переписки.</i>",
    );
  } else if (conversations.length === 0) {
    lines.push(
      "<b>Переписки</b>",
      "<i>Бот подключён к аккаунту. Как только в какой-нибудь переписке появится голосовое, она появится здесь со своими настройками.</i>",
    );
  } else {
    lines.push(
      "<b>Переписки</b>",
      "📤 — расшифровка вашего исходящего войса сразу отправляется собеседнику в эту переписку (от имени вашего аккаунта). По умолчанию выключено; нажмите на переписку, чтобы переключить.",
      "Входящие войсы собеседников всегда расшифровываются сюда, в чат с ботом — Telegram не даёт показать расшифровку в самой переписке так, чтобы её не видел собеседник.",
    );
  }

  const keyboard: InlineKeyboard = [];
  const cb = (op: string) => settingsCb(chatId, 0, op);
  keyboard.push([
    {
      text: `🧠 ${SUMMARIZE_MODEL_OPTIONS[settings.summarizeModelKey].label}`,
      callback_data: cb("o"),
    },
  ]);
  keyboard.push([
    { text: `📝 ${modeLabel(settings.mode as any)}`, callback_data: cb("fm") },
    {
      text: `🎭 ${contextLabel(settings.context as any)}`,
      callback_data: cb("fc"),
    },
    { text: `📊 ${settings.detail}`, callback_data: cb("fd") },
  ]);
  for (const conv of conversations) {
    const name = conv.peerName ?? `чат ${conv.peerChatId}`;
    const on = conv.autoSendTranscript === true;
    keyboard.push([
      {
        text: on ? `📤 ${name} — авто-отправка` : `💤 ${name}`,
        ...(on ? { style: "success" as const } : {}),
        callback_data: `bt:${conv.peerChatId}`,
      },
    ]);
  }
  keyboard.push([
    { text: "✖️ Закрыть", style: "danger" as const, callback_data: cb("x") },
  ]);
  return { text: lines.join("\n"), keyboard };
}

async function handleDmSettingsCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
): Promise<void> {
  const userId = message.from?.id;
  if (!userId) return;
  const panel = await renderDmSettingsPanel(ctx, userId, message.chat.id);
  await sendMessage(message.chat.id, panel.text, {
    parseMode: "HTML",
    inlineKeyboard: panel.keyboard,
  });
}

// bt:<peerChatId> — toggles autoSendTranscript for one business
// conversation and re-renders the DM panel in place.
async function handleBusinessToggleCallback(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  parts: string[],
): Promise<void> {
  const peerChatId = Number(parts[1]);
  if (!Number.isFinite(peerChatId)) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const connection = await ctx.runQuery(
    internal.businessConnections.findEnabledByUser,
    { userId: cb.from.id },
  );
  if (!connection) {
    await answerCallbackQuery(cb.id, "Бот не подключён к аккаунту", true);
    return;
  }
  const enabled: boolean = await ctx.runMutation(
    internal.businessChatSettings.toggleAutoSend,
    { connectionId: connection.connectionId, peerChatId },
  );
  await answerCallbackQuery(
    cb.id,
    enabled
      ? "📤 Расшифровки ваших войсов будут отправляться собеседнику"
      : "💤 Авто-отправка выключена",
  );
  if (cb.message) {
    const panel = await renderDmSettingsPanel(
      ctx,
      cb.from.id,
      cb.message.chat.id,
    );
    await editMessageText(cb.message.chat.id, cb.message.message_id, panel.text, {
      parseMode: "HTML",
      inlineKeyboard: panel.keyboard,
    });
  }
}

// ---- «Отправить собеседнику»: manual business transcript send -------------

// bx:<shortId> — one tap on the owner's DM summary posts the transcript
// of their outgoing voice into the managed conversation (sent from the
// owner's account, as a reply to the voice). On success the button turns
// into an inert "✓ Отправлено" confirmation.
async function handleBusinessSendCallback(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
): Promise<void> {
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice || !voice.businessConnectionId) {
    await answerCallbackQuery(cb.id, "Сообщение не найдено");
    return;
  }
  if (cb.from.id !== voice.businessUserChatId) {
    await answerCallbackQuery(cb.id, "Кнопка только для владельца аккаунта", true);
    return;
  }
  if (!voice.transcript) {
    await answerCallbackQuery(cb.id, "Расшифровка ещё не готова — подождите");
    return;
  }
  try {
    await sendBusinessTranscript(
      voice.businessConnectionId,
      voice.chatId,
      voice.messageId,
      voice.transcript,
    );
  } catch (err) {
    console.warn(
      "manual business transcript send failed",
      err instanceof Error ? err.message : String(err),
    );
    await answerCallbackQuery(
      cb.id,
      "Не удалось отправить — проверьте, что бот всё ещё подключён к аккаунту",
      true,
    );
    return;
  }
  await answerCallbackQuery(cb.id, "📤 Отправлено собеседнику");
  if (cb.message) {
    const botUsername = await ctx.runQuery(
      internal.botConfig.getBotUsername,
      {},
    );
    const keyboard = buildOpenInBotKeyboard(botUsername, shortId, {
      businessSend: true,
      businessSent: true,
    });
    await editMessageReplyMarkup(
      cb.message.chat.id,
      cb.message.message_id,
      keyboard,
    );
  }
}

// ---- /reaction: change the on-demand trigger reaction ---------------------

async function handleReactionCommand(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
  commandText: string,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;
  const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  })) as ResolvedChatSettings;

  const respond = async (text: string) => {
    const eph = await sendEphemeralMessage(chatId, userId, text, {
      parseMode: "HTML",
      replyToEphemeralMessageId: message.ephemeral_message_id,
    });
    if (!eph) {
      await sendMessage(chatId, text, {
        parseMode: "HTML",
        replyToMessageId: message.message_id || undefined,
      });
    }
  };

  const arg = commandText.replace(/^\/reaction(@[\w_]+)?\s*/i, "").trim();

  // Premium (custom emoji) reaction: the emoji arrives as a custom_emoji
  // entity on the command message.
  const customEntity = message.entities?.find(
    (e) => e.type === "custom_emoji" && e.custom_emoji_id,
  );
  if (customEntity && message.text) {
    const display = message.text.slice(
      customEntity.offset,
      customEntity.offset + customEntity.length,
    );
    await ctx.runMutation(internal.chatSettings.update, {
      chatId,
      reactionType: "custom_emoji",
      reactionValue: customEntity.custom_emoji_id!,
      reactionDisplay: display,
    });
    await respond(
      `Реакция-триггер: ${escapeHtml(display)} (премиум-эмодзи). Бот сможет ставить её, только если она разрешена админами чата или уже стоит на сообщении.`,
    );
    return;
  }

  if (!arg) {
    await respond(
      `Реакция-триггер сейчас: ${escapeHtml(settings.reaction.display)}\n\n` +
        `Сменить: <code>/reaction &lt;эмодзи&gt;</code> — любая обычная или премиум-реакция.\n` +
        `Сбросить: <code>/reaction reset</code> (вернёт 👀).`,
    );
    return;
  }

  if (/^reset$/i.test(arg)) {
    await ctx.runMutation(internal.chatSettings.update, {
      chatId,
      reactionType: "emoji",
      reactionValue: "👀",
      reactionDisplay: "👀",
    });
    await respond("Реакция-триггер сброшена на 👀.");
    return;
  }

  // Plain emoji: Telegram only allows reactions from its fixed set. Try
  // the raw arg and the variation-selector-stripped form.
  const stripped = arg.replace(/️/g, "");
  const emoji = ALLOWED_REACTION_EMOJI.has(arg)
    ? arg
    : ALLOWED_REACTION_EMOJI.has(stripped)
      ? stripped
      : null;
  if (!emoji) {
    await respond(
      `«${escapeHtml(arg)}» нельзя использовать как обычную реакцию — Telegram разрешает только фиксированный набор эмодзи-реакций. ` +
        `Отправьте <code>/reaction</code> с премиум-эмодзи, либо выберите из типовых: ${REACTION_PRESETS.join(" ")}`,
    );
    return;
  }
  await ctx.runMutation(internal.chatSettings.update, {
    chatId,
    reactionType: "emoji",
    reactionValue: emoji,
    reactionDisplay: emoji,
  });
  await respond(`Реакция-триггер: ${emoji}`);
}

// ---- Bot-mention summon: reply to a voice with @bot → public summary ------

// Returns true when the message was a bot mention replying to a voice and
// was handled. Works in every delivery mode; in on-demand mode the summon
// message itself is deleted (needs the delete-messages admin right —
// failure is tolerated).
async function maybeHandleVoiceMentionSummon(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  message: TgMessage,
  commandText: string,
): Promise<boolean> {
  const target = message.reply_to_message;
  if (!target) return false;
  const media = extractMedia(target);
  if (!media) return false;

  const botUsername = (await ctx.runQuery(
    internal.botConfig.getBotUsername,
    {},
  )) as string | null;
  if (!botUsername) return false;
  const mentionRe = new RegExp(
    `@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  if (!mentionRe.test(commandText)) return false;

  const allowed = getAllowedChatIds();
  if (allowed && !allowed.has(message.chat.id)) return true;

  const chatId = message.chat.id;
  const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  })) as ResolvedChatSettings;
  if (settings.deliveryMode === "onDemand") {
    // Keep the chat clean: the tag did its job, the transcription follows.
    await deleteMessage(chatId, message.message_id);
  }

  await summonVoiceSummary(ctx, chatId, target, media);
  return true;
}

// Shared by the bot-mention summon and the /s-as-reply command: makes sure
// the target voice ends up with a PUBLIC summary reply, whatever state
// it's in and whatever the chat's delivery mode is.
async function summonVoiceSummary(
  ctx: { runMutation: any; runQuery: any; scheduler: any },
  chatId: number,
  target: TgMessage,
  media: MediaInfo,
): Promise<void> {
  const voice = (await ctx.runQuery(internal.voiceMessages.findByMessage, {
    chatId,
    messageId: target.message_id,
  })) as Doc<"voiceMessages"> | null;

  if (!voice) {
    await handleVoice(ctx, target, media, { forceInstant: true });
    return;
  }

  if (
    voice.transcript &&
    (voice.status === "done" || voice.status === "ignored")
  ) {
    const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
      chatId,
    })) as ResolvedChatSettings;
    await postPublicVoiceSummary(ctx, voice, settings);
    return;
  }

  if (voice.status === "error") {
    await sendMessage(
      chatId,
      `Не удалось обработать это голосовое: ${escapeHtml(voice.error ?? "неизвестная ошибка")}`,
      { replyToMessageId: target.message_id },
    );
    return;
  }

  // Still processing — upgrade the delivery plan so the pipeline commits
  // the summary publicly when it finishes.
  await ctx.runMutation(internal.voiceMessages.setDelivery, {
    id: voice._id,
    delivery: "instant",
  });
}

// Renders the voice's current (or default) summary and posts it as a NEW
// public reply to the voice — used by the mention summon, so the answer is
// always visible even if a summary message already exists elsewhere.
async function postPublicVoiceSummary(
  ctx: { runMutation: any; runQuery: any },
  voice: Doc<"voiceMessages">,
  settings: ResolvedChatSettings,
): Promise<void> {
  if (!voice.transcript) return;
  const session = {
    mode: (voice.displayedMode ?? "auto") as ModeKey,
    context: (voice.displayedContext ?? "auto") as ContextKey,
    detail: (voice.displayedDetail ?? settings.detail) as Detail,
  };
  const summary = await loadOrGenerateForSession(ctx, voice, session);
  const concrete = resolveAutoForSession(voice, session) ?? {
    mode: "brief" as const,
    context: "thinkingOutLoud" as const,
    detail: session.detail,
  };
  const debugMode = await ctx.runQuery(internal.botConfig.getDebugMode, {});
  const botUsername = await ctx.runQuery(internal.botConfig.getBotUsername, {});
  const rendered = renderFinal({
    summary,
    transcript: voice.transcript,
    segments: voice.transcriptSegments ?? null,
    mode: concrete.mode,
    context: concrete.context,
    detail: concrete.detail,
    wasAutoMode: session.mode === "auto",
    wasAutoContext: session.context === "auto",
    timings: {},
    debug: debugMode,
  });
  const keyboard = buildOpenInBotKeyboard(botUsername, voice.shortId);
  await commitFinal({
    chatId: voice.chatId,
    ackId: undefined,
    replyTo: voice.messageId,
    ...rendered,
    keyboard,
  });
  await ctx.runMutation(internal.voiceMessages.setDisplayed, {
    id: voice._id,
    mode: concrete.mode,
    context: concrete.context,
    detail: concrete.detail,
  });
}

// ---- Reactions → ephemeral summary (on-demand mode) -----------------------

function reactionMatches(
  r: TgReactionType,
  trigger: { type: string; value: string },
): boolean {
  if (trigger.type === "emoji") {
    return (
      r.type === "emoji" &&
      (r.emoji === trigger.value ||
        r.emoji?.replace(/️/g, "") === trigger.value.replace(/️/g, ""))
    );
  }
  return r.type === "custom_emoji" && r.custom_emoji_id === trigger.value;
}

async function handleMessageReaction(
  ctx: { runMutation: any; runQuery: any },
  mr: TgMessageReaction,
): Promise<void> {
  const user = mr.user;
  // Ignore reaction removals and anonymous/channel reactions.
  if (!user || (mr.new_reaction?.length ?? 0) === 0) return;
  const chatId = mr.chat.id;
  const voice = (await ctx.runQuery(internal.voiceMessages.findByMessage, {
    chatId,
    messageId: mr.message_id,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) return;
  const settings = (await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  })) as ResolvedChatSettings;
  if (settings.deliveryMode !== "onDemand") return;
  // Only the trigger reaction summons the transcript — ordinary reactions
  // (❤️ on a funny voice) shouldn't spam their author with ephemerals.
  const triggered = (mr.new_reaction ?? []).some((r) =>
    reactionMatches(r, settings.reaction),
  );
  if (!triggered) return;

  if (!voice.transcript) {
    await sendEphemeralMessage(
      chatId,
      user.id,
      voice.status === "error"
        ? `Не удалось расшифровать это голосовое: ${escapeHtml((voice.error ?? "неизвестная ошибка").slice(0, 300))}`
        : `${loadingEmoji()} <i>Ещё обрабатываю это голосовое — поставьте реакцию чуть позже.</i>`,
      { parseMode: "HTML" },
    );
    return;
  }

  // Rows without a finished summary ("ignored" from the nonsense filter,
  // an error after transcription, or a summary still generating) get the
  // transcript alone — it's ready and that's what the reactor wants.
  let body: string;
  if (voice.status !== "done") {
    body = `<blockquote expandable>${escapeHtml(voice.transcript)}</blockquote>`;
  } else {
    const session = {
      mode: (voice.displayedMode ?? "auto") as ModeKey,
      context: (voice.displayedContext ?? "auto") as ContextKey,
      detail: (voice.displayedDetail ?? settings.detail) as Detail,
    };
    const summary = await loadOrGenerateForSession(ctx, voice, session);
    const summaryHtml = markdownToTelegramHtml(summary);
    body = `${summaryHtml}\n\n<blockquote expandable>${escapeHtml(voice.transcript)}</blockquote>`;
    if (body.length > TG_TEXT_LIMIT) {
      // Drop the transcript quote first; truncate the summary as a last
      // resort (tag-safe).
      body =
        summaryHtml.length <= TG_TEXT_LIMIT
          ? summaryHtml
          : splitHtmlSafely(summaryHtml, TG_TEXT_LIMIT - 60)[0] +
            "\n\n<i>(обрезано — полная версия в боте)</i>";
    }
  }
  if (body.length > TG_TEXT_LIMIT) {
    body =
      splitHtmlSafely(body, TG_TEXT_LIMIT - 60)[0] +
      "\n\n<i>(обрезано — полная версия в боте)</i>";
  }
  const botUsername = await ctx.runQuery(internal.botConfig.getBotUsername, {});
  const keyboard: InlineKeyboard | undefined =
    botUsername && voice.shortId
      ? [
          [
            {
              text: "Открыть в боте",
              url: `https://t.me/${botUsername}?start=v${voice.shortId}`,
            },
          ],
        ]
      : undefined;
  await sendEphemeralMessage(chatId, user.id, body, {
    parseMode: "HTML",
    inlineKeyboard: keyboard,
  });
}

// ---- Reply-to-summary Q&A -------------------------------------------------

// Resolves the replied-to bot message back to its source voice / chat
// summary (directly or through a previous Q&A answer) and answers the
// question. Returns false if the reply target isn't ours.
async function maybeAnswerSummaryReply(
  ctx: { runMutation: any; runQuery: any },
  message: TgMessage,
  question: string,
): Promise<boolean> {
  const chatId = message.chat.id;
  const target = message.reply_to_message;
  if (!target) return false;
  const targetId = target.message_id;

  let voice = (await ctx.runQuery(internal.voiceMessages.findByAckMessage, {
    chatId,
    ackMessageId: targetId,
  })) as Doc<"voiceMessages"> | null;
  let chatSummary: Doc<"chatSummaries"> | null = null;
  let quotedAnswer: string | null = null;
  if (!voice) {
    chatSummary = (await ctx.runQuery(internal.chatSummaries.findByAckMessage, {
      chatId,
      ackMessageId: targetId,
    })) as Doc<"chatSummaries"> | null;
  }
  if (!voice && !chatSummary) {
    // Maybe it's a reply to one of our earlier Q&A answers — follow-up.
    const qa = await ctx.runQuery(internal.qaMessages.findByMessage, {
      chatId,
      messageId: targetId,
    });
    if (!qa) return false;
    quotedAnswer = target.text ?? null;
    if (qa.voiceShortId) {
      voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
        shortId: qa.voiceShortId,
      })) as Doc<"voiceMessages"> | null;
    } else if (qa.chatSummaryShortId) {
      chatSummary = (await ctx.runQuery(internal.chatSummaries.getByShortId, {
        shortId: qa.chatSummaryShortId,
      })) as Doc<"chatSummaries"> | null;
    }
  }
  if (voice && (voice.status !== "done" || !voice.transcript)) return false;
  if (chatSummary && chatSummary.status !== "done") return false;
  if (!voice && !chatSummary) return false;

  await answerSummaryQuestion(ctx, {
    chatId,
    question,
    questionMessageId: message.message_id,
    voice,
    chatSummary,
    quotedAnswer,
  });
  return true;
}

// ---- In-group ephemeral style switcher (voice author) ---------------------

const GROUP_STYLE_MODE_KEYS: Exclude<ModeKey, "auto">[] = [
  "bulletPoints",
  "brief",
  "cleanText",
  "structured",
  "sections",
  "actionItems",
  "keyPoints",
];

// True when this user may restyle the voice's chat message: its author,
// or — for business voices — the account owner (the summary lives in the
// owner's DM, and incoming voices are authored by the peer).
function canRestyleVoice(userId: number, voice: Doc<"voiceMessages">): boolean {
  if (userId === voice.fromId) return true;
  return (
    voice.businessUserChatId !== undefined &&
    userId === voice.businessUserChatId
  );
}

// gs:<shortId> — opens a style picker for the voice author. In groups it's
// an ephemeral message (uses the callback's 15-second window, so it works
// without admin rights); in private chats (bot DM, business results)
// ephemeral sends aren't available — Telegram only supports them in
// groups — so the picker is a regular message, which is fine there since
// the whole chat is private anyway.
async function openGroupStylePicker(
  ctx: { runQuery: any },
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
  if (!canRestyleVoice(cb.from.id, voice)) {
    await answerCallbackQuery(
      cb.id,
      "Только автор голосового может менять стиль в чате",
      true,
    );
    return;
  }
  const current = voice.displayedMode ?? voice.autoMode;
  const rows: InlineKeyboard = [];
  for (let i = 0; i < GROUP_STYLE_MODE_KEYS.length; i += 2) {
    rows.push(
      GROUP_STYLE_MODE_KEYS.slice(i, i + 2).map((k) => ({
        text: k === current ? `✓ ${modeLabel(k)}` : modeLabel(k),
        callback_data: `ga:${shortId}:${k}`,
      })),
    );
  }

  if (cb.message?.chat.type === "private") {
    await answerCallbackQuery(cb.id);
    await sendMessage(
      cb.message.chat.id,
      "Стиль summary для этого голосового:",
      {
        inlineKeyboard: rows,
        replyToMessageId: cb.message.message_id,
      },
    );
    return;
  }

  const eph = await sendEphemeralMessage(
    voice.chatId,
    cb.from.id,
    "Стиль summary для этого голосового (пикер видно только вам):",
    { callbackQueryId: cb.id, inlineKeyboard: rows },
  );
  if (eph) {
    await answerCallbackQuery(cb.id);
  } else {
    await answerCallbackQuery(
      cb.id,
      "Не удалось открыть пикер — используйте «Открыть в боте»",
      true,
    );
  }
}

// ga:<shortId>:<modeKey> — regenerates the group summary with a new mode.
async function applyGroupStyle(
  ctx: { runMutation: any; runQuery: any },
  cb: TgCallbackQuery,
  shortId: string,
  modeRaw: string,
): Promise<void> {
  const voice = (await ctx.runQuery(internal.voiceMessages.getByShortId, {
    shortId,
  })) as Doc<"voiceMessages"> | null;
  if (!voice) {
    await answerCallbackQuery(cb.id, "Сообщение не найдено");
    return;
  }
  if (!canRestyleVoice(cb.from.id, voice)) {
    await answerCallbackQuery(cb.id, "Только автор голосового", true);
    return;
  }
  if (!voice.transcript) {
    await answerCallbackQuery(cb.id, "Расшифровка отсутствует");
    return;
  }
  if (!isModeKey(modeRaw) || modeRaw === "auto") {
    await answerCallbackQuery(cb.id);
    return;
  }
  const settings = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: voice.chatId,
  });
  const context = (voice.displayedContext ??
    voice.autoContext ??
    (settings.context !== "auto" ? settings.context : "thinkingOutLoud")) as
    Exclude<ContextKey, "auto">;
  const detail = (voice.displayedDetail ?? settings.detail) as Detail;
  await answerCallbackQuery(cb.id, "Обновляю summary в чате…");
  await regenerateVoiceInChat(ctx, voice, modeRaw, context, detail);
}

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
  // video_note, treat it as a "summarize this voice" request — same
  // behavior as the bot-mention summon: always answers publicly, in any
  // delivery mode. The chat-summary path is for when the command is used
  // standalone.
  const replyTarget = message.reply_to_message;
  const replyMedia = replyTarget ? extractMedia(replyTarget) : null;
  if (replyTarget && replyMedia) {
    await summonVoiceSummary(ctx, message.chat.id, replyTarget, replyMedia);
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
    headerLines.push(
      `<b>Длительность:</b> ${formatTimecode(voice.durationSec)}`,
    );
  }
  const header = headerLines.join("\n");
  // Prefer the timestamped rendering when Whisper segments are stored —
  // [M:SS] anchors make a long transcript navigable.
  const transcriptText =
    voice.transcriptSegments && voice.transcriptSegments.length > 0
      ? formatTimestampedTranscript(voice.transcriptSegments)
      : (voice.transcript ?? "");
  const transcriptHtml = escapeHtml(transcriptText);

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
  // bot), so we soft-truncate the summary body. The cut goes through
  // splitHtmlSafely so we never tear an expandable-blockquote tag apart.
  const settingsBlock = `\n\n${settingsLine}`;
  const limit = TG_TEXT_LIMIT - settingsBlock.length - 10;
  const body =
    summaryHtml.length > limit
      ? splitHtmlSafely(summaryHtml, limit - 40)[0] +
        "\n\n<i>(summary обрезан)</i>"
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
  // Business voices: the model pick lives in the owner's DM settings.
  const chatSettings = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: voice.businessUserChatId ?? voice.chatId,
  });
  const { text } = await getOrGenerateSummary(ctx, voice._id, {
    transcript: voice.transcript,
    segments: voice.transcriptSegments ?? null,
    durationSec: voice.durationSec ?? null,
    mode: mode as Exclude<ModeKey, "auto">,
    context: context as Exclude<ContextKey, "auto">,
    detail: session.detail,
    chatStyleNotes: memory?.notes ?? null,
    chatLore: lore,
    modelId: summarizeModelId(chatSettings.summarizeModelKey),
  });
  return text;
}

// ---- Callback router ------------------------------------------------------

async function handleCallback(
  ctx: { runMutation: any; runQuery: any; scheduler: any; runAction: any },
  cb: TgCallbackQuery,
): Promise<void> {
  const data = cb.data ?? "";
  const parts = data.split(":");

  // Ephemeral-capable callbacks first: they carry everything they need in
  // callback_data because ephemeral-origin callbacks may arrive without a
  // usable cb.message (ephemeral messages have message_id 0).
  try {
    if (parts[0] === "st") {
      await handleSettingsCallback(ctx, cb, parts);
      return;
    }
    if (parts[0] === "bt" && parts.length === 2) {
      await handleBusinessToggleCallback(ctx, cb, parts);
      return;
    }
    if (parts[0] === "bx" && parts.length === 2) {
      await handleBusinessSendCallback(ctx, cb, parts[1]);
      return;
    }
    if (parts[0] === "mm") {
      await handleModalCallback(ctx, cb, parts);
      return;
    }
    if (parts[0] === "gs" && parts.length === 2) {
      await openGroupStylePicker(ctx, cb, parts[1]);
      return;
    }
    if (parts[0] === "ga" && parts.length === 3) {
      await applyGroupStyle(ctx, cb, parts[1], parts[2]);
      return;
    }
  } catch (err) {
    console.error("handleCallback (ephemeral) failed", err);
    await answerCallbackQuery(cb.id, "Что-то сломалось").catch(() => {});
    return;
  }

  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const userId = cb.from.id;
  if (chatId === undefined || messageId === undefined) {
    await answerCallbackQuery(cb.id);
    return;
  }
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
  if (!canRestyleVoice(cb.from.id, voice)) {
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

  await regenerateVoiceInChat(
    ctx,
    voice,
    mode as Exclude<ModeKey, "auto">,
    context as Exclude<ContextKey, "auto">,
    detail,
    session.mode === "auto",
    session.context === "auto",
  );
}

// Regenerates (or pulls from cache) a summary with the given concrete
// settings and commits it into the voice's message in the source chat.
// Shared by the DM picker's "apply to chat" and the in-group ephemeral
// style switcher.
async function regenerateVoiceInChat(
  ctx: { runMutation: any; runQuery: any },
  voice: Doc<"voiceMessages">,
  mode: Exclude<ModeKey, "auto">,
  context: Exclude<ContextKey, "auto">,
  detail: Detail,
  wasAutoMode = false,
  wasAutoContext = false,
): Promise<void> {
  if (!voice.transcript) return;
  const debugMode = await ctx.runQuery(internal.botConfig.getDebugMode, {});
  const chatSettings = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: voice.businessUserChatId ?? voice.chatId,
  });
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
    segments: voice.transcriptSegments ?? null,
    durationSec: voice.durationSec ?? null,
    mode,
    context,
    detail,
    chatStyleNotes: memory?.notes ?? null,
    chatLore: lore,
    modelId: summarizeModelId(chatSettings.summarizeModelKey),
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
    segments: voice.transcriptSegments ?? null,
    mode,
    context,
    detail,
    wasAutoMode,
    wasAutoContext,
    timings: {},
    debug: debugMode,
  });
  const keyboard = buildOpenInBotKeyboard(botUsername, voice.shortId, {
    businessSend:
      voice.businessConnectionId !== undefined &&
      voice.businessOutgoing === true,
  });
  // Business voices live in a managed conversation, but the bot's summary
  // message for them is in the OWNER's DM — restyle edits go there.
  const isBusinessResult = voice.businessUserChatId !== undefined;
  await commitFinal({
    chatId: voice.businessUserChatId ?? voice.chatId,
    ackId: voice.ackMessageId,
    replyTo: isBusinessResult ? undefined : voice.messageId,
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
      await summonVoiceSummary(ctx, chatId, target, media);
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
      ? splitHtmlSafely(summaryHtml, limit - 40)[0] +
        "\n\n<i>(summary обрезан)</i>"
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
  const chatSettings = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId: summary.chatId,
  });
  const { text } = await getOrGenerateChatSummary(ctx, summary._id, {
    chatLog,
    mode: concrete.mode,
    context: concrete.context,
    detail: concrete.detail,
    chatStyleNotes: memory?.notes ?? null,
    chatLore: lore,
    modelId: summarizeModelId(chatSettings.summarizeModelKey),
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
  const applyChatSettings = await ctx.runQuery(
    internal.chatSettings.getResolved,
    { chatId: summary.chatId },
  );
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
      modelId: summarizeModelId(applyChatSettings.summarizeModelKey),
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
