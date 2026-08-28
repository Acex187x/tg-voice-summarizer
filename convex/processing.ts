import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import {
  CLASSIFY_MODEL,
  CLASSIFY_PROVIDER,
  SUMMARIZE_MODEL,
  SUMMARIZE_PROVIDER,
  summarizeModelId,
  TRANSCRIBE_MODEL,
} from "./models";
import {
  chatComplete,
  chatCompleteStream,
  transcribeAudioWithTimestamps,
} from "./openai";
import {
  buildChatSummaryPrompt,
  buildFilterAgentSystemPrompt,
  buildShortVoiceCleanTextPrompt,
  buildSummaryPrompt,
  buildSummaryQaPrompt,
  type ContextKey,
  type Detail,
  type FilterDecision,
  formatTimecode,
  formatTimestampedTranscript,
  LONG_VOICE_SECTIONS_MIN_SEC,
  MEMORY_REFRESH_SYSTEM_PROMPT,
  type ModeKey,
  parseFilterResponse,
  parseRouterResponse,
  parseVoiceNonsenseResponse,
  ROUTER_SYSTEM_PROMPT,
  type TimedSegment,
  VOICE_NONSENSE_SYSTEM_PROMPT,
} from "./prompts";
import {
  deleteMessage,
  downloadFile,
  editMessageText,
  escapeHtml,
  getFilePath,
  loadingEmoji,
  markdownToTelegramHtml,
  resolveMessageLinks,
  editIntoRichMarkdownMessage,
  escapeRichText,
  resolveMessageLinksMarkdown,
  RICH_TEXT_LIMIT,
  sendChatAction,
  sendMessage,
  sendRichMarkdownMessage,
  setMessageReaction,
  splitHtmlSafely,
  summaryMarkdownToRichMarkdown,
  TG_TEXT_LIMIT,
  type InlineKeyboard,
} from "./telegram";
import { semanticSearchMessages } from "./vectorSearch";

const SHORT_TRANSCRIPT_CLEAN_TEXT_MAX_CHARS = 320;

function transcriptLength(text: string): number {
  return Array.from(text.replace(/\s+/g, " ").trim()).length;
}

function isShortTranscript(text: string): boolean {
  const len = transcriptLength(text);
  return len > 0 && len <= SHORT_TRANSCRIPT_CLEAN_TEXT_MAX_CHARS;
}

// ---- Lore loader ---------------------------------------------------------

// Collects all /lore entries for a chat into a single string for prompt
// injection. Returns null if the chat has no lore.
async function loadChatLore(
  ctx: { runQuery: any },
  chatId: number,
): Promise<string | null> {
  const rows = await ctx.runQuery(internal.chatLore.allForChat, { chatId });
  if (!rows || rows.length === 0) return null;
  return rows.map((r: any) => `- ${r.text}`).join("\n");
}

// ---- Cancel-button helpers (used by both pipelines) ----------------------

// Inline keyboard with a single ❌ button that fires the cancel callback.
// The voice version uses prefix `dv:`, the chat-summary version `dc:`,
// both keyed by the row's shortId. Returns undefined if shortId is missing
// (legacy rows from before the shortId field existed).
function buildVoiceCancelKeyboard(
  shortId: string | undefined,
): InlineKeyboard | undefined {
  if (!shortId) return undefined;
  return [[{ text: "❌ Отмена", callback_data: `dv:${shortId}` }]];
}
function buildChatSummaryCancelKeyboard(
  shortId: string | undefined,
): InlineKeyboard | undefined {
  if (!shortId) return undefined;
  return [[{ text: "❌ Отмена", callback_data: `dc:${shortId}` }]];
}

// Re-fetches the row and returns true if the user has cancelled. Used
// between pipeline stages to bail out cleanly without further side
// effects.
async function isVoiceCancelled(
  ctx: { runQuery: any },
  id: Id<"voiceMessages">,
): Promise<boolean> {
  const row = await ctx.runQuery(internal.voiceMessages.get, { id });
  return row?.cancelled === true;
}
async function isChatSummaryCancelled(
  ctx: { runQuery: any },
  id: Id<"chatSummaries">,
): Promise<boolean> {
  const row = await ctx.runQuery(internal.chatSummaries.get, { id });
  return row?.cancelled === true;
}

async function classifyVoiceNonsense(
  transcript: string,
): Promise<{ shouldIgnore: boolean; reason: string }> {
  try {
    const raw = await chatComplete({
      provider: CLASSIFY_PROVIDER,
      model: CLASSIFY_MODEL,
      system: VOICE_NONSENSE_SYSTEM_PROMPT,
      user: `Расшифровка голосового сообщения:\n"""\n${transcript}\n"""`,
      temperature: 0,
      jsonMode: true,
    });
    return parseVoiceNonsenseResponse(raw);
  } catch (err) {
    console.warn(
      "Voice nonsense filter failed",
      err instanceof Error ? err.message : String(err),
    );
    return { shouldIgnore: false, reason: "filter failed" };
  }
}

// ---- Pipeline entry point -------------------------------------------------

export const processVoiceMessage = internalAction({
  args: { id: v.id("voiceMessages") },
  handler: async (ctx, { id }): Promise<void> => {
    const record = await ctx.runQuery(internal.voiceMessages.get, { id });
    if (!record) return;

    const debugMode = await ctx.runQuery(internal.botConfig.getDebugMode, {});
    const ackId = record.ackMessageId;
    const responseChatId = record.businessUserChatId ?? record.chatId;
    const isBusinessPrivateResult = record.businessUserChatId !== undefined;
    const cancelKeyboard = buildVoiceCancelKeyboard(record.shortId);
    const startedAt = Date.now();
    const timings: {
      transcribeMs?: number;
      routerMs?: number;
      summarizeMs?: number;
      totalMs?: number;
    } = {};

    try {
      // ---- 1. Transcribe ----------------------------------------------
      await ctx.runMutation(internal.voiceMessages.setStatus, {
        id,
        status: "transcribing",
      });
      if (await isVoiceCancelled(ctx, id)) return;
      if (ackId !== undefined) {
        await editMessageText(
          responseChatId,
          ackId,
          `${loadingEmoji()}  <i>Расшифровываю сообщение…</i>`,
          { parseMode: "HTML", inlineKeyboard: cancelKeyboard },
        );
      }
      const tStart = Date.now();
      const filePath = await getFilePath(record.fileId);
      const blob = await downloadFile(filePath);
      const { text: transcript, segments } =
        await transcribeAudioWithTimestamps(blob, TRANSCRIBE_MODEL, "voice.ogg");
      timings.transcribeMs = Date.now() - tStart;
      if (!transcript) throw new Error("Whisper returned empty transcript");
      await ctx.runMutation(internal.voiceMessages.setTranscript, {
        id,
        transcript,
        segments,
      });
      // On-demand delivery: the trigger reaction goes up as soon as the
      // transcript exists — that's the "ready, react to read" signal.
      // (The summary may still be generating; the reaction handler serves
      // a cached transcript immediately and generates on demand.)
      const chatSettingsEarly = await ctx.runQuery(
        internal.chatSettings.getResolved,
        { chatId: record.chatId },
      );
      if (record.delivery === "onDemand" && !isBusinessPrivateResult) {
        await setMessageReaction(record.chatId, record.messageId, {
          type: chatSettingsEarly.reaction.type,
          value: chatSettingsEarly.reaction.value,
        });
      }
      const linkedChatMessage = await ctx.runQuery(
        internal.chatMessages.findByMessage,
        { chatId: record.chatId, messageId: record.messageId },
      );
      if (linkedChatMessage) {
        await ctx.scheduler.runAfter(
          0,
          internal.vectorSearch.indexChatMessage,
          {
            chatMessageId: linkedChatMessage._id,
          },
        );
      }
      if (await isVoiceCancelled(ctx, id)) return;
      const nonsensePromise = classifyVoiceNonsense(transcript);

      // ---- 2. Resolve chat settings + router --------------------------
      const chatSettings = chatSettingsEarly;

      const resolved = await resolveVoiceSettings(
        ctx,
        id,
        transcript,
        chatSettings,
        record.durationSec,
      );
      timings.routerMs = resolved.routerMs;
      const nonsense = await nonsensePromise;
      if (nonsense.shouldIgnore) {
        await ctx.runMutation(internal.voiceMessages.setStatus, {
          id,
          status: "ignored",
          error: nonsense.reason,
        });
        if (ackId !== undefined) {
          await deleteMessage(responseChatId, ackId);
        }
        // Silent-instant: drop the "processing" reaction; nothing will be
        // posted. (On-demand keeps its reaction — the transcript is still
        // servable ephemerally.)
        if (record.delivery === "instantSilent" && !isBusinessPrivateResult) {
          await setMessageReaction(record.chatId, record.messageId);
        }
        return;
      }

      // ---- 3. Generate summary (always uncached on first run) ---------
      await ctx.runMutation(internal.voiceMessages.setStatus, {
        id,
        status: "summarizing",
      });
      if (await isVoiceCancelled(ctx, id)) return;
      if (ackId !== undefined) {
        await editMessageText(
          responseChatId,
          ackId,
          `${loadingEmoji()} <i>Готовлю summary…</i>`,
          { parseMode: "HTML", inlineKeyboard: cancelKeyboard },
        );
      }
      const sStart = Date.now();
      const memory = await ctx.runQuery(internal.chatMemory.get, {
        chatId: record.chatId,
      });
      const lore = await loadChatLore(ctx, record.chatId);
      const summaryText = await generateAndCacheSummary(ctx, id, {
        transcript,
        segments,
        durationSec: record.durationSec,
        mode: resolved.mode,
        context: resolved.context,
        detail: resolved.detail,
        chatStyleNotes: memory?.notes ?? null,
        chatLore: lore,
        modelId: summarizeModelId(chatSettings.summarizeModelKey),
      });
      if (await isVoiceCancelled(ctx, id)) return;
      timings.summarizeMs = Date.now() - sStart;
      timings.totalMs = Date.now() - startedAt;

      if (!summaryText)
        throw new Error("Summary model returned empty response");

      await ctx.runMutation(internal.voiceMessages.setTimings, { id, timings });
      await ctx.runMutation(internal.voiceMessages.setDisplayed, {
        id,
        mode: resolved.mode,
        context: resolved.context,
        detail: resolved.detail,
      });

      // ---- 4. Commit the final chat message ---------------------------
      // Re-read the row first: a bot-mention reply may have upgraded an
      // on-demand voice to "instant" while we were summarizing.
      const fresh = await ctx.runQuery(internal.voiceMessages.get, { id });
      const effectiveDelivery =
        fresh?.delivery ??
        record.delivery ??
        (chatSettings.deliveryMode === "onDemand" && !isBusinessPrivateResult
          ? "onDemand"
          : "instant");

      // On-demand: nothing is posted publicly. The summary sits in the
      // cache; the trigger reaction (already set after transcription)
      // invites members to react and get it ephemerally (bot.ts →
      // handleMessageReaction).
      if (effectiveDelivery === "onDemand" && !isBusinessPrivateResult) {
        await ctx.runMutation(internal.voiceMessages.setStatus, {
          id,
          status: "done",
        });
        return;
      }
      const botUsername = await ctx.runQuery(
        internal.botConfig.getBotUsername,
        {},
      );
      const rendered = renderFinal({
        summary: summaryText,
        transcript,
        segments,
        mode: resolved.mode,
        context: resolved.context,
        detail: resolved.detail,
        wasAutoMode: chatSettings.mode === "auto",
        wasAutoContext: chatSettings.context === "auto",
        timings,
        debug: debugMode,
      });
      const keyboard = buildOpenInBotKeyboard(botUsername, fresh?.shortId);
      await commitFinal({
        chatId: responseChatId,
        ackId,
        replyTo: isBusinessPrivateResult ? undefined : record.messageId,
        ...rendered,
        keyboard,
      });

      // Silent-instant mode used the trigger reaction as its "processing"
      // indicator — clear it now that the summary is posted.
      if (effectiveDelivery === "instantSilent" && !isBusinessPrivateResult) {
        await setMessageReaction(record.chatId, record.messageId);
      }

      await ctx.runMutation(internal.voiceMessages.setStatus, {
        id,
        status: "done",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Voice processing failed", message);
      await ctx.runMutation(internal.voiceMessages.setStatus, {
        id,
        status: "error",
        error: message,
      });

      if (ackId !== undefined) {
        await editMessageText(
          responseChatId,
          ackId,
          `Не удалось обработать сообщение: ${message}`,
        ).catch(() => {});
      }
      // Silent-instant used the reaction as its "processing" indicator —
      // don't leave it hanging on a voice we failed to process.
      if (record.delivery === "instantSilent") {
        await setMessageReaction(record.chatId, record.messageId);
      }
      const adminIdRaw = process.env.ADMIN_TELEGRAM_ID;
      if (adminIdRaw) {
        try {
          await sendMessage(
            Number(adminIdRaw),
            `Ошибка обработки голосового:\n${message}`,
            {},
          );
        } catch {
          // ignore
        }
      }
    }
  },
});

// ---- Router ---------------------------------------------------------------

interface ResolvedSettings {
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
  routerMs: number;
}

// Resolves (possibly-"auto") chat settings to concrete mode+context keys.
// The router result is cached on the voiceMessages row so we don't pay for
// it again on cache misses for different (detail, explicit mode) combos.
export async function resolveVoiceSettings(
  ctx: { runQuery: any; runMutation: any },
  voiceId: Id<"voiceMessages">,
  transcript: string,
  settings: { mode: ModeKey; context: ContextKey; detail: Detail },
  durationSec?: number,
): Promise<ResolvedSettings> {
  let mode: ModeKey = settings.mode;
  let context: ContextKey = settings.context;

  if (isShortTranscript(transcript)) {
    const forcedContext =
      context === "auto"
        ? "thinkingOutLoud"
        : (context as Exclude<ContextKey, "auto">);
    await ctx.runMutation(internal.voiceMessages.setAutoResolution, {
      id: voiceId,
      autoMode: "cleanText",
      autoContext: forcedContext,
    });
    return {
      mode: "cleanText",
      context: forcedContext,
      detail: settings.detail,
      routerMs: 0,
    };
  }

  // Long voices default to the sectioned per-topic summary. Only kicks in
  // for "auto" — an explicit mode choice always wins. The forced value is
  // stored as the auto resolution so the DM picker shows "Авто → Темы"
  // consistently with what the chat message displays.
  const forceSections =
    mode === "auto" && (durationSec ?? 0) >= LONG_VOICE_SECTIONS_MIN_SEC;
  if (forceSections) {
    mode = "sections";
    if (context !== "auto") {
      await ctx.runMutation(internal.voiceMessages.setAutoResolution, {
        id: voiceId,
        autoMode: "sections",
        autoContext: context,
      });
    }
  }

  // Fast path: nothing to resolve.
  if (mode !== "auto" && context !== "auto") {
    return {
      mode: mode as Exclude<ModeKey, "auto">,
      context: context as Exclude<ContextKey, "auto">,
      detail: settings.detail,
      routerMs: 0,
    };
  }

  // Reuse previously-computed auto resolution if it exists on the row.
  const existing = await ctx.runQuery(internal.voiceMessages.get, {
    id: voiceId,
  });
  if (existing?.autoMode && existing?.autoContext) {
    if (mode === "auto") mode = existing.autoMode as ModeKey;
    if (context === "auto") context = existing.autoContext as ContextKey;
    if (mode !== "auto" && context !== "auto") {
      return {
        mode: mode as Exclude<ModeKey, "auto">,
        context: context as Exclude<ContextKey, "auto">,
        detail: settings.detail,
        routerMs: 0,
      };
    }
  }

  // Run the router.
  await ctx.runMutation(internal.voiceMessages.setStatus, {
    id: voiceId,
    status: "routing",
  });
  const rStart = Date.now();
  const raw = await chatComplete({
    provider: CLASSIFY_PROVIDER,
    model: CLASSIFY_MODEL,
    system: ROUTER_SYSTEM_PROMPT,
    user: `Расшифровка сообщения:\n"""\n${transcript}\n"""`,
    temperature: 0,
    jsonMode: true,
  });
  const routed = parseRouterResponse(raw);
  const routerMs = Date.now() - rStart;

  await ctx.runMutation(internal.voiceMessages.setAutoResolution, {
    id: voiceId,
    // When sections mode was duration-forced, that's what "auto" resolves
    // to for this voice — not whatever the router would have picked.
    autoMode: forceSections ? "sections" : routed.mode,
    autoContext: routed.context,
  });

  return {
    mode: mode === "auto" ? routed.mode : (mode as Exclude<ModeKey, "auto">),
    context:
      context === "auto"
        ? routed.context
        : (context as Exclude<ContextKey, "auto">),
    detail: settings.detail,
    routerMs,
  };
}

// ---- Summary generator + cache --------------------------------------------

export interface GenerateArgs {
  transcript: string;
  // Whisper segment timestamps for this voice, when available. Used to
  // feed the sections mode a timestamped transcript so it can anchor
  // topics to real timecodes.
  segments?: TimedSegment[] | null;
  durationSec?: number | null;
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
  chatStyleNotes?: string | null;
  chatLore?: string | null;
  // Per-chat summarizer model id (from /modal). Defaults to SUMMARIZE_MODEL.
  modelId?: string | null;
}

// Looks up the (voice, mode, context, detail) key in the summaries cache.
// Hit → return cached text. Miss → call the model, cache, return.
//
// Exported so bot.ts can reuse it for on-demand re-summarization from the
// DM picker.
export async function getOrGenerateSummary(
  ctx: { runQuery: any; runMutation: any },
  voiceId: Id<"voiceMessages">,
  args: GenerateArgs,
): Promise<{ text: string; cached: boolean }> {
  const cached = await ctx.runQuery(internal.summaries.findCached, {
    voiceMessageId: voiceId,
    mode: args.mode,
    context: args.context,
    detail: args.detail,
  });
  if (cached) return { text: cached.text, cached: true };

  const text = await generateAndCacheSummary(ctx, voiceId, args);
  return { text, cached: false };
}

export async function getOrGenerateSummaryStreaming(
  ctx: { runQuery: any; runMutation: any },
  voiceId: Id<"voiceMessages">,
  args: GenerateArgs,
  onPartial: (text: string) => Promise<void>,
): Promise<{ text: string; cached: boolean }> {
  const cached = await ctx.runQuery(internal.summaries.findCached, {
    voiceMessageId: voiceId,
    mode: args.mode,
    context: args.context,
    detail: args.detail,
  });
  if (cached) return { text: cached.text, cached: true };

  const text = await generateAndCacheSummary(ctx, voiceId, args, onPartial);
  return { text, cached: false };
}

async function generateAndCacheSummary(
  ctx: { runQuery: any; runMutation: any },
  voiceId: Id<"voiceMessages">,
  args: GenerateArgs,
  onPartial?: (text: string) => Promise<void>,
): Promise<string> {
  const useShortCleanup =
    args.mode === "cleanText" && isShortTranscript(args.transcript);
  const system = useShortCleanup
    ? buildShortVoiceCleanTextPrompt()
    : buildSummaryPrompt(
        args.mode,
        args.context,
        args.detail,
        args.chatStyleNotes ?? null,
        args.chatLore ?? null,
      );
  // The sections mode needs timestamps to anchor topics to; other modes
  // get the plain transcript (timestamps would only burn tokens there).
  const useTimestamps =
    args.mode === "sections" && (args.segments?.length ?? 0) > 0;
  const transcriptBlock = useTimestamps
    ? formatTimestampedTranscript(args.segments!)
    : args.transcript;
  const durationLine =
    useTimestamps && args.durationSec
      ? `Длительность аудио: ${formatTimecode(args.durationSec)}\n`
      : "";
  const completionArgs = {
    provider: SUMMARIZE_PROVIDER,
    model: args.modelId ?? SUMMARIZE_MODEL,
    system,
    user: `${durationLine}Расшифровка:\n"""\n${transcriptBlock}\n"""`,
    temperature: useShortCleanup ? 0.2 : 0.4,
  };
  const text = onPartial
    ? await chatCompleteStream({
        ...completionArgs,
        onDelta: async (_delta, full) => {
          await onPartial(full);
        },
      })
    : await chatComplete(completionArgs);
  if (!text) throw new Error("Summary model returned empty response");
  await ctx.runMutation(internal.summaries.store, {
    voiceMessageId: voiceId,
    mode: args.mode,
    context: args.context,
    detail: args.detail,
    text,
  });
  return text;
}

// ---- Final message rendering ----------------------------------------------

interface RenderArgs {
  summary: string;
  transcript: string;
  // Whisper segments — when present, the rich-message transcript is
  // rendered with [M:SS] anchors.
  segments?: TimedSegment[] | null;
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
  wasAutoMode: boolean;
  wasAutoContext: boolean;
  timings: {
    transcribeMs?: number;
    routerMs?: number;
    summarizeMs?: number;
    totalMs?: number;
  };
  debug: boolean;
}

export interface RenderedMessage {
  summaryHtml: string;
  quoteHtml: string;
  // Rich-message (Bot API 10.1+) markdown variant of the same content.
  // commitFinal uses it when preferRich is set or the classic rendering
  // overflows a single message; on API error it falls back to classic.
  richMarkdown?: string;
  preferRich?: boolean;
}

export function renderFinal(args: RenderArgs): RenderedMessage {
  const summaryHtml = markdownToTelegramHtml(args.summary);

  const quoteLines: string[] = [];
  if (args.debug) {
    const modeLabel = args.wasAutoMode ? `auto → ${args.mode}` : args.mode;
    const ctxLabel = args.wasAutoContext
      ? `auto → ${args.context}`
      : args.context;
    quoteLines.push(`<b>Стиль:</b> ${escapeHtml(modeLabel)}`);
    quoteLines.push(`<b>Контекст:</b> ${escapeHtml(ctxLabel)}`);
    quoteLines.push(`<b>Детальность:</b> ${args.detail}`);
    quoteLines.push(
      `<b>Модели:</b> transcribe=openai/${escapeHtml(TRANSCRIBE_MODEL)}, ` +
        `router=${escapeHtml(CLASSIFY_PROVIDER)}/${escapeHtml(CLASSIFY_MODEL)}, ` +
        `summary=${escapeHtml(SUMMARIZE_PROVIDER)}/${escapeHtml(SUMMARIZE_MODEL)}`,
    );
    quoteLines.push(`<b>Время:</b> ${formatTimings(args.timings)}`);
    quoteLines.push("");
    quoteLines.push("<b>Расшифровка:</b>");
  }
  quoteLines.push(escapeHtml(args.transcript));

  return {
    summaryHtml,
    quoteHtml: quoteLines.join("\n"),
    richMarkdown: buildVoiceRichMarkdown(args),
    // Sectioned summaries carry the most structure (headings + per-topic
    // collapsible details), so they get the rich rendering by default;
    // other modes only upgrade to rich when they overflow.
    preferRich: args.mode === "sections",
  };
}

// Assembles the rich-markdown variant: summary (with `> ` blocks turned
// into collapsed <details>), optional debug block, and the full transcript
// in its own collapsed <details> — rich messages fit 32k chars, so even a
// 40-minute transcript usually rides along instead of hiding behind the
// "открой в боте" link.
function buildVoiceRichMarkdown(args: RenderArgs): string | undefined {
  const parts: string[] = [
    summaryMarkdownToRichMarkdown(args.summary),
  ];
  if (args.debug) {
    const modeLabel = args.wasAutoMode ? `auto → ${args.mode}` : args.mode;
    const ctxLabel = args.wasAutoContext
      ? `auto → ${args.context}`
      : args.context;
    parts.push(
      [
        `<details><summary>Debug</summary>`,
        "",
        `**Стиль:** ${modeLabel}`,
        `**Контекст:** ${ctxLabel}`,
        `**Детальность:** ${args.detail}`,
        `**Модели:** transcribe=openai/${TRANSCRIBE_MODEL}, router=${CLASSIFY_PROVIDER}/${CLASSIFY_MODEL}, summary=${SUMMARIZE_PROVIDER}/${SUMMARIZE_MODEL}`,
        `**Время:** ${formatTimings(args.timings)}`,
        "",
        `</details>`,
      ].join("\n"),
    );
  }
  let rich = parts.join("\n\n");
  if (rich.length > RICH_TEXT_LIMIT) return undefined;

  const transcriptText =
    args.segments && args.segments.length > 0
      ? formatTimestampedTranscript(args.segments)
      : args.transcript;
  const transcriptBlock = [
    `<details><summary>Расшифровка</summary>`,
    "",
    escapeRichText(transcriptText),
    "",
    `</details>`,
  ].join("\n");
  if (rich.length + transcriptBlock.length + 2 <= RICH_TEXT_LIMIT) {
    rich += `\n\n${transcriptBlock}`;
  }
  return rich;
}

function formatTimings(t: {
  transcribeMs?: number;
  routerMs?: number;
  summarizeMs?: number;
  totalMs?: number;
}): string {
  const fmt = (ms: number | undefined) =>
    ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;
  return `whisper ${fmt(t.transcribeMs)} · router ${fmt(t.routerMs)} · summary ${fmt(t.summarizeMs)} · total ${fmt(t.totalMs)}`;
}

// ---- Deep-link keyboard helper (used here and by bot.ts) ------------------

export function buildOpenInBotKeyboard(
  botUsername: string | undefined | null,
  shortId: string | undefined | null,
): InlineKeyboard | undefined {
  if (!shortId) return undefined;
  const row: InlineKeyboard[number] = [];
  if (botUsername) {
    row.push({
      text: "Открыть в боте",
      url: `https://t.me/${botUsername}?start=v${shortId}`,
    });
  }
  // Ephemeral style picker for the voice author — no DM round-trip.
  row.push({ text: "⚙️ Стиль", callback_data: `gs:${shortId}` });
  row.push({ text: "❌", callback_data: `dv:${shortId}` });
  return [row];
}

// ---- Long-message handling -------------------------------------------------

function wrapQuote(content: string): string {
  return `<blockquote expandable>${content}</blockquote>`;
}

const LINK_PROMPT_HTML =
  "<i>Откройте сообщение в боте, чтобы посмотреть его полную расшифровку.</i>";

export interface CommitArgs {
  chatId: number;
  ackId: number | undefined;
  replyTo?: number;
  summaryHtml: string;
  quoteHtml: string;
  richMarkdown?: string;
  preferRich?: boolean;
  keyboard?: InlineKeyboard;
}

// Commits the final message(s) for a voice. Same three-path logic as the
// previous implementation — exported so bot.ts (on-demand picker resum) can
// reuse it for long on-demand summaries too.
export async function commitFinal(args: CommitArgs): Promise<void> {
  // If quoteHtml is empty (chat summaries embed everything in summaryHtml
  // already), skip the blockquote wrapper so we don't append an empty tag.
  const inlineCombined = args.quoteHtml
    ? `${args.summaryHtml}\n\n${wrapQuote(args.quoteHtml)}`
    : args.summaryHtml;

  // Rich-message path (Bot API 10.1+): used when the renderer asked for it
  // (sectioned summaries) or when the classic rendering wouldn't fit one
  // message anyway. Any API error falls through to the classic path —
  // rich messages are new enough that we don't bet the whole send on them.
  if (
    args.richMarkdown &&
    (args.preferRich || inlineCombined.length > TG_TEXT_LIMIT)
  ) {
    try {
      if (args.ackId !== undefined) {
        await editIntoRichMarkdownMessage(
          args.chatId,
          args.ackId,
          args.richMarkdown,
          { inlineKeyboard: args.keyboard },
        );
      } else {
        await sendRichMarkdownMessage(args.chatId, args.richMarkdown, {
          replyToMessageId: args.replyTo,
          inlineKeyboard: args.keyboard,
        });
      }
      return;
    } catch (err) {
      console.warn(
        "Rich message commit failed, falling back to classic HTML",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (inlineCombined.length <= TG_TEXT_LIMIT) {
    await sendOrEdit(args.chatId, args.ackId, args.replyTo, inlineCombined, {
      inlineKeyboard: args.keyboard,
    });
    return;
  }

  const summaryWithPrompt = `${args.summaryHtml}\n\n${LINK_PROMPT_HTML}`;
  if (summaryWithPrompt.length <= TG_TEXT_LIMIT) {
    await sendOrEdit(args.chatId, args.ackId, args.replyTo, summaryWithPrompt, {
      inlineKeyboard: args.keyboard,
    });
    return;
  }

  const summaryChunks = splitHtmlSafely(args.summaryHtml, TG_TEXT_LIMIT);
  const lastIdx = summaryChunks.length - 1;
  const lastWithPrompt = `${summaryChunks[lastIdx]}\n\n${LINK_PROMPT_HTML}`;
  if (lastWithPrompt.length <= TG_TEXT_LIMIT) {
    summaryChunks[lastIdx] = lastWithPrompt;
  } else {
    summaryChunks.push(LINK_PROMPT_HTML);
  }

  let threadAnchor: number | undefined = args.ackId;
  for (let i = 0; i < summaryChunks.length; i++) {
    const text = summaryChunks[i];
    const isLast = i === summaryChunks.length - 1;
    const opts = isLast ? { inlineKeyboard: args.keyboard } : {};

    if (i === 0) {
      const id = await sendOrEdit(
        args.chatId,
        args.ackId,
        args.replyTo,
        text,
        opts,
      );
      threadAnchor = id ?? threadAnchor;
    } else {
      const sent = await sendMessage(args.chatId, text, {
        parseMode: "HTML",
        replyToMessageId: threadAnchor ?? args.replyTo,
        ...opts,
      });
      threadAnchor = sent.message_id;
    }
  }
}

async function sendOrEdit(
  chatId: number,
  ackId: number | undefined,
  replyTo: number | undefined,
  html: string,
  opts: { inlineKeyboard?: InlineKeyboard } = {},
): Promise<number | undefined> {
  if (ackId !== undefined) {
    await editMessageText(chatId, ackId, html, {
      parseMode: "HTML",
      ...opts,
    });
    return ackId;
  }
  const sent = await sendMessage(chatId, html, {
    parseMode: "HTML",
    replyToMessageId: replyTo,
    ...opts,
  });
  return sent.message_id;
}

// =====================================================================
// ============= Chat-summary pipeline (the /summary command) ==========
// =====================================================================

const SESSION_GAP_MINUTES = 30; // configurable gap for last-session detection
const MAX_SESSION_LOOKBACK = 500; // hard cap on messages we walk back through

// Internal action wired up by /summary. Resolves the user's argument into
// a frozen message-id selection, runs the router, generates the first
// summary, and commits the inline result with the deep-link button.
export const processChatSummary = internalAction({
  args: {
    chatSummaryId: v.id("chatSummaries"),
    rawArgs: v.string(), // user-supplied free text after /summary, may be ""
  },
  handler: async (ctx, { chatSummaryId, rawArgs }): Promise<void> => {
    const summary = await ctx.runQuery(internal.chatSummaries.get, {
      id: chatSummaryId,
    });
    if (!summary) return;

    const ackId = summary.ackMessageId;
    const cancelKeyboard = buildChatSummaryCancelKeyboard(summary.shortId);
    const startedAt = Date.now();
    const debugMode = await ctx.runQuery(internal.botConfig.getDebugMode, {});

    try {
      // ---- 1. Resolve message selection -------------------------------
      await ctx.runMutation(internal.chatSummaries.setStatus, {
        id: chatSummaryId,
        status: "filtering",
      });
      if (await isChatSummaryCancelled(ctx, chatSummaryId)) return;
      if (ackId !== undefined) {
        await editMessageText(
          summary.chatId,
          ackId,
          `${loadingEmoji()} <i>Подбираю сообщения для summary…</i>`,
          { parseMode: "HTML", inlineKeyboard: cancelKeyboard },
        );
      }

      const selection = await resolveSelection(ctx, summary.chatId, rawArgs);
      if (await isChatSummaryCancelled(ctx, chatSummaryId)) return;
      if (selection.messageIds.length === 0) {
        const hasAny = await ctx.runQuery(internal.chatMessages.hasAnyForChat, {
          chatId: summary.chatId,
        });
        if (!hasAny) {
          throw new Error(
            "В этом чате я ещё не накопил никаких сообщений. " +
              "Я начинаю их сохранять только с того момента, как меня добавили — " +
              "подождите немного и попробуйте снова.",
          );
        }
        throw new Error(
          "В выбранном диапазоне нет сообщений. Попробуйте другой диапазон, " +
            "например `/summary последние 7 дней` или `/summary всё что есть`.",
        );
      }
      await ctx.runMutation(internal.chatSummaries.patchSelection, {
        id: chatSummaryId,
        startTs: selection.startTs,
        endTs: selection.endTs,
        fromUsername: selection.fromUsername ?? undefined,
        filterDescription: selection.description,
        messageIds: selection.messageIds,
      });

      // ---- 2. Build the chat log (token-budgeted) --------------------
      const built = await buildChatLog(ctx, selection.messages);
      const chatLog = built.log;
      // If the budget dropped some messages, narrow the frozen selection
      // so the picker shows the same set the summary was actually built
      // from.
      if (built.usedMessages.length < selection.messages.length) {
        const usedIds = new Set(built.usedMessages.map((m) => m.messageId));
        selection.messages = selection.messages.filter((m) =>
          usedIds.has(m.messageId),
        );
        selection.messageIds = selection.messages.map((m) => m.messageId);
        if (selection.messages.length > 0) {
          selection.startTs = selection.messages[0].ts;
          selection.endTs =
            selection.messages[selection.messages.length - 1].ts;
        }
      }

      // ---- 3. Router (auto → concrete mode/context) -------------------
      await ctx.runMutation(internal.chatSummaries.setStatus, {
        id: chatSummaryId,
        status: "routing",
      });
      const chatSettings = await ctx.runQuery(
        internal.chatSettings.getResolved,
        { chatId: summary.chatId },
      );
      const resolved = await resolveChatSummarySettings(
        ctx,
        chatSummaryId,
        chatLog,
        chatSettings,
      );

      // ---- 4. Generate ------------------------------------------------
      await ctx.runMutation(internal.chatSummaries.setStatus, {
        id: chatSummaryId,
        status: "summarizing",
      });
      if (await isChatSummaryCancelled(ctx, chatSummaryId)) return;
      if (ackId !== undefined) {
        await editMessageText(
          summary.chatId,
          ackId,
          `${loadingEmoji()} <i>Готовлю summary переписки…</i>`,
          { parseMode: "HTML", inlineKeyboard: cancelKeyboard },
        );
      }
      const memory = await ctx.runQuery(internal.chatMemory.get, {
        chatId: summary.chatId,
      });
      const lore = await loadChatLore(ctx, summary.chatId);
      const summaryText = await generateAndCacheChatSummary(
        ctx,
        chatSummaryId,
        {
          chatLog,
          mode: resolved.mode,
          context: resolved.context,
          detail: resolved.detail,
          chatStyleNotes: memory?.notes ?? null,
          chatLore: lore,
          modelId: summarizeModelId(chatSettings.summarizeModelKey),
        },
      );
      if (!summaryText)
        throw new Error("Summary model returned empty response");
      if (await isChatSummaryCancelled(ctx, chatSummaryId)) return;

      await ctx.runMutation(internal.chatSummaries.setDisplayed, {
        id: chatSummaryId,
        mode: resolved.mode,
        context: resolved.context,
        detail: resolved.detail,
      });

      // ---- 5. Commit inline -------------------------------------------
      const fresh = await ctx.runQuery(internal.chatSummaries.get, {
        id: chatSummaryId,
      });
      const botUsername = await ctx.runQuery(
        internal.botConfig.getBotUsername,
        {},
      );
      const rendered = renderChatSummaryFinal({
        chatId: summary.chatId,
        summaryText,
        chatLog,
        filterDescription: selection.description,
        messageCount: selection.messageIds.length,
        mode: resolved.mode,
        context: resolved.context,
        detail: resolved.detail,
        wasAutoMode: chatSettings.mode === "auto",
        wasAutoContext: chatSettings.context === "auto",
        debug: debugMode,
      });
      const keyboard = buildChatSummaryButton(botUsername, fresh?.shortId);
      await commitFinal({
        chatId: summary.chatId,
        ackId,
        replyTo: summary.requestMessageId,
        ...rendered,
        keyboard,
      });

      await ctx.runMutation(internal.chatSummaries.setStatus, {
        id: chatSummaryId,
        status: "done",
      });
      void startedAt; // timings are not stored on chatSummaries (yet)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Chat summary failed", message);
      await ctx.runMutation(internal.chatSummaries.setStatus, {
        id: chatSummaryId,
        status: "error",
        error: message,
      });
      if (ackId !== undefined) {
        await editMessageText(
          summary.chatId,
          ackId,
          `Не удалось собрать summary: ${message}`,
        ).catch(() => {});
      }
    }
  },
});

// ---- Selection resolution -------------------------------------------------

interface ResolvedSelection {
  startTs: number;
  endTs: number;
  fromUsername: string | null;
  description: string;
  messages: Doc<"chatMessages">[];
  messageIds: number[];
}

// Token-shaped budget for the chat log we feed the summarizer LLM. ~10k
// tokens of mixed Russian/English ≈ 25k characters of rendered log.
// We render newest-to-oldest and stop accumulating once we hit the cap;
// the rest of the messages are silently dropped (oldest first), which
// matches the user's intent of "summarize the latest of what fits".
const MAX_CHAT_LOG_CHARS = 25000;

// Budget for the filter-agent context window. Same ~2.5 chars/token rule
// as the summarizer → ~25k chars ≈ 10k tokens of recent chat history. We
// intentionally let the filter agent see a LOT of messages so semantic
// queries ("про дедлайны", "обсуждение чая") have actual material to
// match against. Cost is bounded by the cheap classify-stage model.
const FILTER_CONTEXT_CHAR_LIMIT = 25000;
// Per-message snippet length. Bumped from 100 to 200 so the agent can
// recognize topic-relevant messages from a meaningful preview, not just
// the first sentence.
const FILTER_CONTEXT_PER_MSG_CHARS = 200;

async function resolveSelection(
  ctx: { runQuery: any; runMutation: any },
  chatId: number,
  rawArgs: string,
): Promise<ResolvedSelection> {
  // Empty args → gap-based "last session" detector. If even that's empty
  // (bot has nothing stored for this chat) we fall through to the
  // catch-all latest-messages path.
  if (rawArgs.trim().length === 0) {
    const session = await detectLastSession(ctx, chatId);
    if (session.messageIds.length > 0) return session;
    return await fallbackToAnyMessages(
      ctx,
      chatId,
      null,
      "последние доступные сообщения",
    );
  }

  // For the smart filter agent we need a context window of recent
  // messages so the LLM can do semantic ID picking ("про дедлайны",
  // "разговор про чай"). Pull a generous candidate set — the actual cut
  // happens in buildFilterContextLog by char budget, so the only cost
  // here is one DB query.
  const ctxRowsDesc: Doc<"chatMessages">[] = await ctx.runQuery(
    internal.chatMessages.latest,
    { chatId, limit: 2000 },
  );
  const ctxRows = ctxRowsDesc.slice().sort((a, b) => a.ts - b.ts);
  const filterContext = buildFilterContextLog(ctxRows);

  const nowSec = Math.floor(Date.now() / 1000);
  const userMessage =
    `Запрос пользователя: ${rawArgs.trim()}\n\n` +
    (filterContext
      ? `Доступные сообщения в чате (id | время | отправитель | первые ~100 символов):\n${filterContext}`
      : "В чате нет сохранённых сообщений (бот только что добавлен).");

  const raw = await chatComplete({
    provider: CLASSIFY_PROVIDER,
    model: CLASSIFY_MODEL,
    system: buildFilterAgentSystemPrompt(nowSec),
    user: userMessage,
    temperature: 0,
    jsonMode: true,
  });
  const decision = parseFilterResponse(raw, nowSec);

  return await dispatchFilterDecision(ctx, chatId, decision);
}

async function dispatchFilterDecision(
  ctx: { runQuery: any },
  chatId: number,
  decision: FilterDecision,
): Promise<ResolvedSelection> {
  if (decision.kind === "error") {
    throw new Error(
      `Не понял запрос: ${decision.description}. Попробуйте, например, ` +
        "`/summary последний день` или `/summary всё`.",
    );
  }
  if (decision.kind === "all") {
    return await fallbackToAnyMessages(ctx, chatId, null, decision.description);
  }
  if (decision.kind === "range") {
    const sel = await selectionFromFilter(ctx, chatId, {
      startTs: decision.startTs,
      endTs: decision.endTs,
      fromUsername: decision.fromUsername,
      description: decision.description,
    });
    if (sel.messageIds.length > 0) return sel;
    // Range was empty — degrade to "what we have", preserving any
    // username filter the user specified.
    return await fallbackToAnyMessages(
      ctx,
      chatId,
      decision.fromUsername,
      `${decision.description} (расширено до доступных сообщений)`,
    );
  }
  if (decision.kind === "semantic") {
    const hits = await semanticSearchMessages(
      ctx as any,
      chatId,
      decision.query,
      80,
    );
    if (hits.length > 0) {
      const sorted = hits.map((h) => h.message).sort((a, b) => a.ts - b.ts);
      return {
        startTs: sorted[0].ts,
        endTs: sorted[sorted.length - 1].ts,
        fromUsername: null,
        description: decision.description,
        messages: sorted,
        messageIds: sorted.map((m) => m.messageId),
      };
    }
    return await fallbackToAnyMessages(
      ctx,
      chatId,
      null,
      `${decision.description} (vector search пока пуст, взяты последние доступные сообщения)`,
    );
  }
  // kind === "ids" — semantic pick
  if (decision.messageIds.length === 0) {
    return await fallbackToAnyMessages(ctx, chatId, null, decision.description);
  }
  const rows: Doc<"chatMessages">[] = await ctx.runQuery(
    internal.chatMessages.getByIds,
    { chatId, messageIds: decision.messageIds },
  );
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    // LLM hallucinated IDs that don't exist — fall back to latest.
    return await fallbackToAnyMessages(ctx, chatId, null, decision.description);
  }
  return {
    startTs: sorted[0].ts,
    endTs: sorted[sorted.length - 1].ts,
    fromUsername: null,
    description: decision.description,
    messages: sorted,
    messageIds: sorted.map((m) => m.messageId),
  };
}

// Falls back to the latest N messages stored for the chat, optionally
// filtered by username. Returns an empty selection only if the chat has
// literally zero stored messages.
async function fallbackToAnyMessages(
  ctx: { runQuery: any },
  chatId: number,
  fromUsername: string | null,
  description: string,
): Promise<ResolvedSelection> {
  // Take a generous number of latest rows; the actual token-budget cut
  // happens at render time in buildChatLog.
  const latest: Doc<"chatMessages">[] = await ctx.runQuery(
    internal.chatMessages.latest,
    { chatId, limit: 2000 },
  );
  let filtered = latest;
  if (fromUsername) {
    const lc = fromUsername.toLowerCase();
    filtered = filtered.filter((m) => m.fromUsername?.toLowerCase() === lc);
  }
  filtered = filtered.slice().sort((a, b) => a.ts - b.ts);
  if (filtered.length === 0) {
    return {
      startTs: 0,
      endTs: 0,
      fromUsername,
      description,
      messages: [],
      messageIds: [],
    };
  }
  return {
    startTs: filtered[0].ts,
    endTs: filtered[filtered.length - 1].ts,
    fromUsername,
    description,
    messages: filtered,
    messageIds: filtered.map((m) => m.messageId),
  };
}

// Sorts messages ascending and trims them down to fit the token budget,
// keeping the newest end. The actual cut happens in buildChatLog when we
// render — here we only fetch and order.
async function selectionFromFilter(
  ctx: { runQuery: any },
  chatId: number,
  filter: {
    startTs: number;
    endTs: number;
    fromUsername: string | null;
    description: string;
  },
): Promise<ResolvedSelection> {
  const messages: Doc<"chatMessages">[] = await ctx.runQuery(
    internal.chatMessages.range,
    {
      chatId,
      startTs: filter.startTs,
      endTs: filter.endTs,
      fromUsername: filter.fromUsername ?? undefined,
    },
  );
  const kept = messages.slice().sort((a, b) => a.ts - b.ts);
  return {
    startTs: kept.length > 0 ? kept[0].ts : filter.startTs,
    endTs: kept.length > 0 ? kept[kept.length - 1].ts : filter.endTs,
    fromUsername: filter.fromUsername,
    description: filter.description,
    messages: kept,
    messageIds: kept.map((m) => m.messageId),
  };
}

// Walks back through the latest messages until a 30-minute gap is found.
// "Last session" = the trailing run of messages before the gap.
async function detectLastSession(
  ctx: { runQuery: any },
  chatId: number,
): Promise<ResolvedSelection> {
  const latest: Doc<"chatMessages">[] = await ctx.runQuery(
    internal.chatMessages.latest,
    { chatId, limit: MAX_SESSION_LOOKBACK },
  );
  if (latest.length === 0) {
    return {
      startTs: 0,
      endTs: 0,
      fromUsername: null,
      description: "пустой чат",
      messages: [],
      messageIds: [],
    };
  }
  // `latest` is descending; flip to ascending and walk back from the end.
  const sorted = latest.slice().sort((a, b) => a.ts - b.ts);
  const gapSec = SESSION_GAP_MINUTES * 60;
  let startIdx = sorted.length - 1;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const gap = sorted[i + 1].ts - sorted[i].ts;
    if (gap >= gapSec) break;
    startIdx = i;
  }
  const session = sorted.slice(startIdx);
  return {
    startTs: session[0].ts,
    endTs: session[session.length - 1].ts,
    fromUsername: null,
    description: `последняя серия (${session.length} сообщений)`,
    messages: session,
    messageIds: session.map((m) => m.messageId),
  };
}

// ---- Chat log builder -----------------------------------------------------

// Renders the message rows into a single hand-readable transcript that
// the summarizer LLM can chew on. Voice transcripts are spliced in from
// the voiceMessages cache; photos/videos/etc. become bracketed markers.
//
// Applies the token-shaped budget by walking newest-to-oldest and
// accumulating until MAX_CHAT_LOG_CHARS — the oldest messages are
// silently dropped if they don't fit. Returns the final log plus the
// list of messages that actually made it in (so callers can update
// timestamps/counts to match).
async function buildChatLog(
  ctx: { runQuery: any },
  messages: Doc<"chatMessages">[],
  budgetChars: number = MAX_CHAT_LOG_CHARS,
  chatId?: number,
): Promise<{ log: string; usedMessages: Doc<"chatMessages">[] }> {
  // Pre-fetch transcripts for any voice/audio/video_note rows that have a
  // shortId set.
  const shortIds = Array.from(
    new Set(
      messages
        .map((m) => m.voiceShortId)
        .filter((s): s is string => typeof s === "string"),
    ),
  );
  const transcripts = new Map<string, string>();
  for (const sid of shortIds) {
    const v: Doc<"voiceMessages"> | null = await ctx.runQuery(
      internal.voiceMessages.getByShortId,
      { shortId: sid },
    );
    if (v?.transcript) transcripts.set(sid, v.transcript);
  }

  // Pre-fetch nickname overrides for this chat.
  let nicknameMap: Map<number, string> | undefined;
  const effectiveChatId = chatId ?? messages[0]?.chatId;
  if (effectiveChatId) {
    const nickRows = await ctx.runQuery(internal.chatNicknames.allForChat, {
      chatId: effectiveChatId,
    });
    if (nickRows.length > 0) {
      nicknameMap = new Map(nickRows.map((r: any) => [r.userId, r.nickname]));
    }
  }

  // Walk newest → oldest, accumulating lines that fit the budget.
  const lines: string[] = [];
  const usedReversed: Doc<"chatMessages">[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = formatChatMessage(messages[i], transcripts, nicknameMap);
    if (line.length === 0) continue;
    const cost = line.length + 1; // +1 for the newline
    if (used + cost > budgetChars && lines.length > 0) break;
    lines.push(line);
    usedReversed.push(messages[i]);
    used += cost;
  }
  lines.reverse();
  usedReversed.reverse();
  return { log: lines.join("\n"), usedMessages: usedReversed };
}

// Compact context shown to the FILTER agent so it can do semantic ID
// picking. Each line: `[id N | YYYY-MM-DD HH:MM] Имя Фамилия: <первые 100 символов>`.
// Walks newest → oldest, capped at FILTER_CONTEXT_CHAR_LIMIT.
function buildFilterContextLog(messages: Doc<"chatMessages">[]): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const sender = senderDisplayName(m);
    const time = new Date(m.ts * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    let body: string;
    switch (m.mediaKind) {
      case "voice":
      case "audio":
      case "video_note":
        body = `[${m.mediaKind === "video_note" ? "видеокружок" : m.mediaKind}]${m.text ? " " + m.text : ""}`;
        break;
      case "photo":
        body = m.text ? `[фото] ${m.text}` : "[фото]";
        break;
      case "video":
        body = m.text ? `[видео] ${m.text}` : "[видео]";
        break;
      default:
        body = m.text ?? "";
    }
    if (body.length > FILTER_CONTEXT_PER_MSG_CHARS) {
      body = body.slice(0, FILTER_CONTEXT_PER_MSG_CHARS - 1) + "…";
    }
    if (!body) continue;
    const line = `[id ${m.messageId} | ${time}] ${sender}: ${body}`;
    const cost = line.length + 1;
    if (used + cost > FILTER_CONTEXT_CHAR_LIMIT && lines.length > 0) break;
    lines.push(line);
    used += cost;
  }
  return lines.reverse().join("\n");
}

// Human-friendly sender name. Priority: chat nickname (set via /name) →
// "Имя Фамилия" → "Имя" → "@username" → fallback id. The LLM works much
// better when participants are referred to by recognizable names, so
// nickname overrides let the chat customise how people appear in summaries.
function senderDisplayName(
  msg: {
    fromFirstName?: string;
    fromLastName?: string;
    fromName?: string;
    fromUsername?: string;
    fromId?: number;
  },
  nicknameMap?: Map<number, string>,
): string {
  if (nicknameMap && msg.fromId !== undefined) {
    const nick = nicknameMap.get(msg.fromId);
    if (nick) return nick;
  }
  const first = msg.fromFirstName ?? msg.fromName;
  const last = msg.fromLastName;
  const full = [first, last].filter((s) => s && s.length > 0).join(" ");
  if (full.length > 0) return full;
  if (msg.fromUsername) return `@${msg.fromUsername}`;
  return `user${msg.fromId ?? "?"}`;
}

function formatChatMessage(
  msg: Doc<"chatMessages">,
  transcripts: Map<string, string>,
  nicknameMap?: Map<number, string>,
): string {
  const sender = senderDisplayName(msg, nicknameMap);
  const time = new Date(msg.ts * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const idTag = `id:${msg.messageId}`;
  let body = "";
  switch (msg.mediaKind) {
    case "voice":
    case "audio":
    case "video_note": {
      const tag =
        msg.mediaKind === "video_note"
          ? "видеокружок"
          : msg.mediaKind === "audio"
            ? "аудио"
            : "голосовое";
      const t = msg.voiceShortId
        ? transcripts.get(msg.voiceShortId)
        : undefined;
      body = t ? `[${tag}] ${t}` : `[${tag} без расшифровки]`;
      break;
    }
    case "photo":
      body = msg.text ? `[фото] ${msg.text}` : "[фото]";
      break;
    case "video":
      body = msg.text ? `[видео] ${msg.text}` : "[видео]";
      break;
    case "document":
      body = msg.text ? `[файл] ${msg.text}` : "[файл]";
      break;
    case "sticker":
      body = "[стикер]";
      break;
    default:
      body = msg.text ?? "";
  }
  if (!body) return "";
  return `[${idTag} | ${time}] ${sender}: ${body}`;
}

// ---- Router (chat summary version) ---------------------------------------

interface ResolvedChatSummary {
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
}

async function resolveChatSummarySettings(
  ctx: { runQuery: any; runMutation: any },
  summaryId: Id<"chatSummaries">,
  chatLog: string,
  settings: { mode: ModeKey; context: ContextKey; detail: Detail },
): Promise<ResolvedChatSummary> {
  let mode: ModeKey = settings.mode;
  let context: ContextKey = settings.context;
  if (mode !== "auto" && context !== "auto") {
    return {
      mode: mode as Exclude<ModeKey, "auto">,
      context: context as Exclude<ContextKey, "auto">,
      detail: settings.detail,
    };
  }
  const existing = await ctx.runQuery(internal.chatSummaries.get, {
    id: summaryId,
  });
  if (existing?.autoMode && existing?.autoContext) {
    if (mode === "auto") mode = existing.autoMode as ModeKey;
    if (context === "auto") context = existing.autoContext as ContextKey;
    if (mode !== "auto" && context !== "auto") {
      return {
        mode: mode as Exclude<ModeKey, "auto">,
        context: context as Exclude<ContextKey, "auto">,
        detail: settings.detail,
      };
    }
  }
  const raw = await chatComplete({
    provider: CLASSIFY_PROVIDER,
    model: CLASSIFY_MODEL,
    system: ROUTER_SYSTEM_PROMPT,
    user: `Лог переписки в чате:\n"""\n${chatLog}\n"""`,
    temperature: 0,
    jsonMode: true,
  });
  const routed = parseRouterResponse(raw);
  await ctx.runMutation(internal.chatSummaries.setAutoResolution, {
    id: summaryId,
    autoMode: routed.mode,
    autoContext: routed.context,
  });
  return {
    mode: mode === "auto" ? routed.mode : (mode as Exclude<ModeKey, "auto">),
    context:
      context === "auto"
        ? routed.context
        : (context as Exclude<ContextKey, "auto">),
    detail: settings.detail,
  };
}

// ---- Generator + cache (chat summary) ------------------------------------

interface GenerateChatSummaryArgs {
  chatLog: string;
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
  chatStyleNotes?: string | null;
  chatLore?: string | null;
  modelId?: string | null;
}

export async function getOrGenerateChatSummary(
  ctx: { runQuery: any; runMutation: any },
  summaryId: Id<"chatSummaries">,
  args: GenerateChatSummaryArgs,
): Promise<{ text: string; cached: boolean }> {
  const cached = await ctx.runQuery(internal.chatSummaryTexts.findCached, {
    chatSummaryId: summaryId,
    mode: args.mode,
    context: args.context,
    detail: args.detail,
  });
  if (cached) return { text: cached.text, cached: true };
  const text = await generateAndCacheChatSummary(ctx, summaryId, args);
  return { text, cached: false };
}

async function generateAndCacheChatSummary(
  ctx: { runQuery: any; runMutation: any },
  summaryId: Id<"chatSummaries">,
  args: GenerateChatSummaryArgs,
): Promise<string> {
  const system = buildChatSummaryPrompt(
    args.mode,
    args.context,
    args.detail,
    args.chatStyleNotes ?? null,
    args.chatLore ?? null,
  );
  const text = await chatComplete({
    provider: SUMMARIZE_PROVIDER,
    model: args.modelId ?? SUMMARIZE_MODEL,
    system,
    user: `Лог переписки:\n"""\n${args.chatLog}\n"""`,
    temperature: 0.4,
  });
  if (!text) throw new Error("Chat summary model returned empty response");
  await ctx.runMutation(internal.chatSummaryTexts.store, {
    chatSummaryId: summaryId,
    mode: args.mode,
    context: args.context,
    detail: args.detail,
    text,
  });
  return text;
}

// ---- Final rendering (chat summary) --------------------------------------

interface ChatSummaryRenderArgs {
  chatId: number;
  summaryText: string;
  chatLog: string; // we don't render this inline, just used for size hints
  filterDescription: string;
  messageCount: number;
  mode: Exclude<ModeKey, "auto">;
  context: Exclude<ContextKey, "auto">;
  detail: Detail;
  wasAutoMode: boolean;
  wasAutoContext: boolean;
  debug: boolean;
}

export function renderChatSummaryFinal(
  args: ChatSummaryRenderArgs,
): RenderedMessage {
  const headerLine = `<b>Summary переписки</b> · ${escapeHtml(args.filterDescription)} · ${args.messageCount} сообщений`;
  // Convert markdown → HTML, then resolve `msg:ID` hrefs into real
  // Telegram deep-links (t.me/c/CHANNEL_ID/MSG_ID).
  const rawHtml = markdownToTelegramHtml(args.summaryText);
  const resolved = resolveMessageLinks(rawHtml, args.chatId);

  // The summary itself goes inside a collapsed expandable blockquote so
  // it doesn't clutter the chat. The header stays visible above it.
  // No chat-log excerpt — the "Открыть в боте" button is the escape
  // hatch for people who want to see the raw messages or re-style.
  let body = `${headerLine}\n\n<blockquote expandable>${resolved}</blockquote>`;

  if (args.debug) {
    const modeLabel = args.wasAutoMode ? `auto → ${args.mode}` : args.mode;
    const ctxLabel = args.wasAutoContext
      ? `auto → ${args.context}`
      : args.context;
    const debugLines = [
      `<b>Стиль:</b> ${escapeHtml(modeLabel)}`,
      `<b>Контекст:</b> ${escapeHtml(ctxLabel)}`,
      `<b>Детальность:</b> ${args.detail}`,
      `<b>Модели:</b> router=${escapeHtml(CLASSIFY_PROVIDER)}/${escapeHtml(CLASSIFY_MODEL)}, ` +
        `summary=${escapeHtml(SUMMARIZE_PROVIDER)}/${escapeHtml(SUMMARIZE_MODEL)}`,
    ];
    body += `\n\n<blockquote expandable>${debugLines.join("\n")}</blockquote>`;
  }

  // Rich variant: same content, but the summary lives in a collapsed
  // <details> block and can use the full 32k budget instead of being
  // split across messages. Only used by commitFinal when the classic
  // rendering overflows a single message.
  const richSummary = summaryMarkdownToRichMarkdown(
    resolveMessageLinksMarkdown(args.summaryText, args.chatId),
  );
  const richParts = [
    `**Summary переписки** · ${args.filterDescription} · ${args.messageCount} сообщений`,
    [
      `<details><summary>Пересказ</summary>`,
      "",
      richSummary,
      "",
      `</details>`,
    ].join("\n"),
  ];
  if (args.debug) {
    const modeLabel = args.wasAutoMode ? `auto → ${args.mode}` : args.mode;
    const ctxLabel = args.wasAutoContext
      ? `auto → ${args.context}`
      : args.context;
    richParts.push(
      [
        `<details><summary>Debug</summary>`,
        "",
        `**Стиль:** ${modeLabel}`,
        `**Контекст:** ${ctxLabel}`,
        `**Детальность:** ${args.detail}`,
        `**Модели:** router=${CLASSIFY_PROVIDER}/${CLASSIFY_MODEL}, summary=${SUMMARIZE_PROVIDER}/${SUMMARIZE_MODEL}`,
        "",
        `</details>`,
      ].join("\n"),
    );
  }
  const richMarkdown = richParts.join("\n\n");

  // Everything is in summaryHtml; quoteHtml is empty so commitFinal
  // doesn't wrap another blockquote around nothing.
  return {
    summaryHtml: body,
    quoteHtml: "",
    richMarkdown:
      richMarkdown.length <= RICH_TEXT_LIMIT ? richMarkdown : undefined,
  };
}

export function buildChatSummaryButton(
  botUsername: string | undefined | null,
  shortId: string | undefined | null,
): InlineKeyboard | undefined {
  if (!shortId) return undefined;
  const row: InlineKeyboard[number] = [];
  if (botUsername) {
    row.push({
      text: "Открыть в боте",
      url: `https://t.me/${botUsername}?start=c${shortId}`,
    });
  }
  row.push({ text: "❌ Удалить", callback_data: `dc:${shortId}` });
  return [row];
}

// Builds a chat log on demand for a given chat-summary id. Used by the DM
// picker when regenerating with new settings — the messageIds selection
// is frozen on the row, only the summary text changes.
export async function buildChatLogFor(
  ctx: { runQuery: any },
  summary: Doc<"chatSummaries">,
): Promise<string> {
  if (summary.messageIds.length === 0) return "";
  // We don't have a "by message_ids" query, so do a range fetch and then
  // filter to the frozen ids. This keeps the schema simple.
  const range: Doc<"chatMessages">[] = await ctx.runQuery(
    internal.chatMessages.range,
    {
      chatId: summary.chatId,
      startTs: summary.startTs,
      endTs: summary.endTs,
      fromUsername: summary.fromUsername ?? undefined,
    },
  );
  const idSet = new Set(summary.messageIds);
  const filtered = range
    .filter((m) => idSet.has(m.messageId))
    .sort((a, b) => a.ts - b.ts);
  const built = await buildChatLog(ctx, filtered);
  return built.log;
}

// =====================================================================
// ================ Reply-to-summary Q&A (bot.ts hook) =================
// =====================================================================

export interface QaArgs {
  chatId: number;
  question: string;
  questionMessageId: number;
  voice?: Doc<"voiceMessages"> | null;
  chatSummary?: Doc<"chatSummaries"> | null;
  // Text of the bot's previous Q&A answer the user replied to (follow-up
  // questions), if any.
  quotedAnswer?: string | null;
}

// Answers a question asked as a reply to a summary message. The prompt
// carries both the displayed summary and the full source (transcript or
// chat log) plus the chat's style/lore, so the bot clarifies in character.
export async function answerSummaryQuestion(
  ctx: { runQuery: any; runMutation: any },
  args: QaArgs,
): Promise<void> {
  const { chatId } = args;
  await sendChatAction(chatId, "typing");

  const settings = await ctx.runQuery(internal.chatSettings.getResolved, {
    chatId,
  });
  const memory = await ctx.runQuery(internal.chatMemory.get, { chatId });
  const lore = await loadChatLore(ctx, chatId);

  let sourceKind: "voice" | "chatSummary";
  let summaryText = "";
  let sourceText = "";
  if (args.voice) {
    sourceKind = "voice";
    const voice = args.voice;
    if (
      voice.displayedMode &&
      voice.displayedContext &&
      voice.displayedDetail !== undefined
    ) {
      const cached = await ctx.runQuery(internal.summaries.findCached, {
        voiceMessageId: voice._id,
        mode: voice.displayedMode,
        context: voice.displayedContext,
        detail: voice.displayedDetail,
      });
      summaryText = cached?.text ?? "";
    }
    sourceText =
      voice.transcriptSegments && voice.transcriptSegments.length > 0
        ? formatTimestampedTranscript(voice.transcriptSegments)
        : (voice.transcript ?? "");
  } else if (args.chatSummary) {
    sourceKind = "chatSummary";
    const summary = args.chatSummary;
    if (
      summary.displayedMode &&
      summary.displayedContext &&
      summary.displayedDetail !== undefined
    ) {
      const cached = await ctx.runQuery(internal.chatSummaryTexts.findCached, {
        chatSummaryId: summary._id,
        mode: summary.displayedMode,
        context: summary.displayedContext,
        detail: summary.displayedDetail,
      });
      summaryText = cached?.text ?? "";
    }
    sourceText = await buildChatLogFor(ctx, summary);
  } else {
    return;
  }
  if (!sourceText && !summaryText) return;

  const system = buildSummaryQaPrompt(
    sourceKind,
    memory?.notes ?? null,
    lore,
  );
  const userParts: string[] = [];
  if (summaryText) userParts.push(`Summary:\n"""\n${summaryText}\n"""`);
  if (sourceText) {
    userParts.push(
      `${sourceKind === "voice" ? "Полная расшифровка" : "Лог переписки"}:\n"""\n${sourceText}\n"""`,
    );
  }
  if (args.quotedAnswer) {
    userParts.push(
      `Твой предыдущий ответ, на который реплаит пользователь:\n"""\n${args.quotedAnswer}\n"""`,
    );
  }
  userParts.push(`Сообщение пользователя:\n"""\n${args.question}\n"""`);

  const text = await chatComplete({
    provider: SUMMARIZE_PROVIDER,
    model: summarizeModelId(settings.summarizeModelKey),
    system,
    user: userParts.join("\n\n"),
    temperature: 0.5,
  });
  if (!text) return;

  const html = markdownToTelegramHtml(text);
  const chunks = splitHtmlSafely(html, TG_TEXT_LIMIT);
  let replyTo = args.questionMessageId;
  for (const chunk of chunks) {
    const sent = await sendMessage(chatId, chunk, {
      parseMode: "HTML",
      replyToMessageId: replyTo,
    });
    replyTo = sent.message_id;
    // Register the answer so replies to it continue the thread.
    await ctx.runMutation(internal.qaMessages.create, {
      chatId,
      messageId: sent.message_id,
      voiceShortId: args.voice?.shortId,
      chatSummaryShortId: args.chatSummary?.shortId,
    });
  }
}

// =====================================================================
// =================== Chat memory (style observer) ====================
// =====================================================================

// Min interval between two memory refreshes for the same chat. Acts as
// dedup window — if multiple incoming messages all schedule a refresh
// in quick succession, only the first one actually does work.
const MEMORY_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// How many recent messages we feed the observer. ~300 is enough to
// capture vocabulary, jokes, register without ballooning the prompt.
const MEMORY_REFRESH_MESSAGE_LIMIT = 300;
// Char budget for the rendered observer log.
const MEMORY_REFRESH_LOG_BUDGET = 20000;

export const refreshChatMemory = internalAction({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }): Promise<void> => {
    // Re-check freshness inside the action so duplicate scheduling from
    // the message dispatcher is harmless.
    const existing = await ctx.runQuery(internal.chatMemory.get, { chatId });
    if (
      existing &&
      Date.now() - existing.lastUpdatedAt < MEMORY_REFRESH_MIN_INTERVAL_MS
    ) {
      return;
    }

    const latest: Doc<"chatMessages">[] = await ctx.runQuery(
      internal.chatMessages.latest,
      { chatId, limit: MEMORY_REFRESH_MESSAGE_LIMIT },
    );
    if (latest.length === 0) return;
    const sorted = latest.slice().sort((a, b) => a.ts - b.ts);

    // Compact rendering — same shape as the filter agent context, just
    // with a bigger budget.
    const log = renderForMemoryObserver(sorted, MEMORY_REFRESH_LOG_BUDGET);
    if (log.length === 0) return;

    const user =
      `Текущие заметки об этом чате:\n` +
      `"""\n${existing?.notes ?? "(пока заметок нет, ты видишь чат впервые)"}\n"""\n\n` +
      `Свежий лог сообщений (${sorted.length} штук):\n` +
      `"""\n${log}\n"""`;

    let updated: string;
    try {
      updated = await chatComplete({
        provider: CLASSIFY_PROVIDER,
        model: CLASSIFY_MODEL,
        system: MEMORY_REFRESH_SYSTEM_PROMPT,
        user,
        temperature: 0.3,
      });
    } catch (err) {
      console.warn("refreshChatMemory chatComplete failed", err);
      return;
    }
    if (!updated || updated.trim().length === 0) return;

    await ctx.runMutation(internal.chatMemory.upsert, {
      chatId,
      notes: updated.trim(),
    });
  },
});

// Same per-message format as buildFilterContextLog but with a bigger
// budget and slightly more snippet per message — the observer benefits
// from more vocabulary samples than the filter agent.
function renderForMemoryObserver(
  messages: Doc<"chatMessages">[],
  budgetChars: number,
): string {
  const PER_MSG_CAP = 250;
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const sender =
      [m.fromFirstName ?? m.fromName, m.fromLastName]
        .filter((s) => s && s.length > 0)
        .join(" ") ||
      (m.fromUsername ? `@${m.fromUsername}` : `user${m.fromId ?? "?"}`);
    let body: string;
    switch (m.mediaKind) {
      case "voice":
      case "audio":
      case "video_note":
        body = m.text
          ? `[${m.mediaKind}] ${m.text}`
          : `[${m.mediaKind} без расшифровки]`;
        break;
      case "photo":
        body = m.text ? `[фото] ${m.text}` : "[фото]";
        break;
      case "video":
        body = m.text ? `[видео] ${m.text}` : "[видео]";
        break;
      case "sticker":
        body = "[стикер]";
        break;
      default:
        body = m.text ?? "";
    }
    if (body.length > PER_MSG_CAP) body = body.slice(0, PER_MSG_CAP - 1) + "…";
    if (!body) continue;
    const line = `${sender}: ${body}`;
    const cost = line.length + 1;
    if (used + cost > budgetChars && lines.length > 0) break;
    lines.push(line);
    used += cost;
  }
  return lines.reverse().join("\n");
}
