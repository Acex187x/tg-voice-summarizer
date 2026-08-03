import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Mode/context keys are validated in code (see prompts.ts) rather than via
// a strict v.union here, so that adding a new mode doesn't require a
// schema migration. We still store them as strings for consistency.

export default defineSchema({
  // Every incoming voice / video note goes here so we can look it up by
  // shortId, cache its transcript, and drive the DM picker off the row.
  voiceMessages: defineTable({
    chatId: v.number(),
    chatTitle: v.optional(v.string()),
    messageId: v.number(),
    fromId: v.optional(v.number()),
    fromName: v.optional(v.string()),
    fileId: v.string(),
    // Which kind of Telegram media this is — used purely for telemetry and
    // so we know whether to label it "голосовое" or "видеокружок" in the UI.
    mediaKind: v.optional(
      v.union(v.literal("voice"), v.literal("audio"), v.literal("video_note")),
    ),
    durationSec: v.optional(v.number()),
    // Short base62 id used in deep-links and callback_data.
    shortId: v.optional(v.string()),
    transcript: v.optional(v.string()),
    // Segment-level timestamps from Whisper (verbose_json). Used to build
    // the timestamped transcript that powers per-topic timecodes in the
    // "sections" summary mode. Absent for old rows and for transcription
    // models that can't produce timestamps.
    transcriptSegments: v.optional(
      v.array(
        v.object({
          start: v.number(),
          end: v.number(),
          text: v.string(),
        }),
      ),
    ),

    // Router-resolved concrete values (mode/context that "auto" maps to
    // for this specific voice). Cached here so we don't re-run the router
    // on every cache-miss for this voice.
    autoMode: v.optional(v.string()),
    autoContext: v.optional(v.string()),

    // Currently displayed summary in the chat message (for author-driven
    // "apply to chat" edits). Resolved, not "auto".
    displayedMode: v.optional(v.string()),
    displayedContext: v.optional(v.string()),
    displayedDetail: v.optional(v.number()),

    status: v.union(
      v.literal("pending"),
      v.literal("transcribing"),
      v.literal("routing"),
      v.literal("classifying"), // legacy status name — kept for old rows
      v.literal("summarizing"),
      v.literal("ignored"),
      v.literal("done"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    // Set to true when the user clicks the delete button on the ack
    // message during processing. The pipeline checks this between
    // stages and bails out without further edits/sends.
    cancelled: v.optional(v.boolean()),
    // The bot's reply message in the source chat. Instantly posted as
    // "Обрабатываю…", then edited with progress and the final summary.
    ackMessageId: v.optional(v.number()),
    // Business-mode voices are received from a managed private chat but
    // answered privately to the business account owner instead of the
    // customer-facing dialog.
    businessConnectionId: v.optional(v.string()),
    businessUserChatId: v.optional(v.number()),
    timings: v.optional(
      v.object({
        transcribeMs: v.optional(v.number()),
        routerMs: v.optional(v.number()),
        classifyMs: v.optional(v.number()), // legacy name
        summarizeMs: v.optional(v.number()),
        totalMs: v.optional(v.number()),
      }),
    ),

    // === Legacy fields from pre-router schema versions ===
    // Never set by new code. Kept optional so pre-existing rows still
    // validate. Safe to remove after a dev-db reset.
    detectedTypeId: v.optional(v.id("voiceTypes")),
    detectedTypeName: v.optional(v.string()),
    summary: v.optional(v.string()),
    replyMessageId: v.optional(v.number()),
  })
    .index("by_chat_message", ["chatId", "messageId"])
    .index("by_status", ["status"])
    .index("by_short_id", ["shortId"])
    // Lookup by the bot's summary message in the source chat — used by
    // the reply-to-summary Q&A flow.
    .index("by_chat_ack", ["chatId", "ackMessageId"]),

  businessConnections: defineTable({
    connectionId: v.string(),
    userId: v.number(),
    userChatId: v.number(),
    isEnabled: v.boolean(),
    rights: v.optional(v.any()),
    connectedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_connection", ["connectionId"]),

  // Summary cache — one row per unique (voice, mode, context, detail)
  // combination. Mode and context are always concrete keys (never "auto")
  // so picking "auto" shares the cache with explicit picks that resolve
  // to the same values.
  summaries: defineTable({
    voiceMessageId: v.id("voiceMessages"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    text: v.string(),
  }).index("by_voice_settings", [
    "voiceMessageId",
    "mode",
    "context",
    "detail",
  ]),

  // Per-chat defaults used when a new voice arrives. If a chat has no row,
  // fall back to the hard-coded defaults in prompts.ts.
  chatSettings: defineTable({
    chatId: v.number(),
    defaultMode: v.string(),
    defaultContext: v.string(),
    defaultDetail: v.number(),
    // Summarizer model KEY from models.SUMMARIZE_MODEL_OPTIONS ("gemini" /
    // "grok"), toggled via /modal. Absent → default key.
    summarizeModel: v.optional(v.string()),
    // Quiet mode (/quiet): the bot doesn't post summaries publicly;
    // instead a reaction on a voice message gets the reactor an ephemeral
    // summary. Requires the bot to be a chat admin (both for reaction
    // updates and for at-will ephemeral sends).
    quietMode: v.optional(v.boolean()),
  }).index("by_chat", ["chatId"]),

  // Per-chat nickname overrides. When set, the bot uses this name instead
  // of the Telegram first_name/last_name for that user in summaries and
  // chat logs. Set via `/name <nickname>` as a reply to someone's message.
  chatNicknames: defineTable({
    chatId: v.number(),
    userId: v.number(),
    nickname: v.string(),
  })
    .index("by_chat_user", ["chatId", "userId"])
    .index("by_chat", ["chatId"]),

  // Manual lore notes per chat. Added by anyone via `/lore <text>`.
  // Injected into every summary prompt alongside the auto-generated
  // chatMemory so the LLM knows things observers can't detect from the
  // message stream alone.
  chatLore: defineTable({
    chatId: v.number(),
    text: v.string(),
    addedById: v.optional(v.number()),
    addedByName: v.optional(v.string()),
    addedAt: v.number(),
  }).index("by_chat", ["chatId"]),

  // Persistent free-form notes about each chat's communication style.
  // Refreshed in the background as new messages flow in (see
  // processing.ts → refreshChatMemory). Injected into every summary
  // prompt so the bot mimics the chat's voice instead of producing
  // sterile assistant-speak.
  chatMemory: defineTable({
    chatId: v.number(),
    notes: v.string(),
    lastUpdatedAt: v.number(),
    updateCount: v.optional(v.number()),
  }).index("by_chat", ["chatId"]),

  // ---- Chat-summary feature ----------------------------------------------

  // Every group message we observe gets stored here so /summary can pull
  // a time range and feed it to the summarizer. Voices/audios/video notes
  // store a back-reference to voiceMessages.shortId so we can splice their
  // transcript into the chat log when summarizing.
  chatMessages: defineTable({
    chatId: v.number(),
    messageId: v.number(),
    ts: v.number(), // unix seconds (Telegram message.date)
    fromId: v.optional(v.number()),
    // Legacy single-name field — old rows have this. New code prefers
    // fromFirstName + fromLastName so the chat log fed to the LLM uses
    // human-friendly real names instead of @handles.
    fromName: v.optional(v.string()),
    fromFirstName: v.optional(v.string()),
    fromLastName: v.optional(v.string()),
    fromUsername: v.optional(v.string()),
    text: v.optional(v.string()), // text or caption
    mediaKind: v.optional(
      v.union(
        v.literal("text"),
        v.literal("photo"),
        v.literal("video"),
        v.literal("voice"),
        v.literal("audio"),
        v.literal("video_note"),
        v.literal("document"),
        v.literal("sticker"),
        v.literal("other"),
      ),
    ),
    voiceShortId: v.optional(v.string()),
    replyToMessageId: v.optional(v.number()),
    importedFromDump: v.optional(v.boolean()),
    importSource: v.optional(v.string()),
    importedAt: v.optional(v.number()),
  })
    .index("by_chat_ts", ["chatId", "ts"])
    .index("by_chat_message", ["chatId", "messageId"])
    .index("by_chat_imported", ["chatId", "importedFromDump"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["chatId"],
    }),

  messageEmbeddings: defineTable({
    chatId: v.number(),
    chatMessageId: v.id("chatMessages"),
    messageId: v.number(),
    ts: v.number(),
    fromId: v.optional(v.number()),
    fromUsername: v.optional(v.string()),
    mediaKind: v.optional(v.string()),
    chunkIndex: v.number(),
    chunkText: v.string(),
    embedding: v.array(v.float64()),
    embeddingModel: v.string(),
    embeddingDimensions: v.number(),
    embeddingVersion: v.number(),
    contentHash: v.string(),
    embeddedAt: v.number(),
  })
    .index("by_chat_message_chunk", ["chatId", "messageId", "chunkIndex"])
    .index("by_chat_chunk_index", ["chatId", "chunkIndex"])
    .index("by_chat_embedded_at", ["chatId", "embeddedAt"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["chatId"],
    }),

  chatIndexStats: defineTable({
    chatId: v.number(),
    messageTotal: v.number(),
    positiveMessages: v.number(),
    importedMessages: v.number(),
    liveMessages: v.number(),
    nonPositiveMessages: v.number(),
    minMessageId: v.optional(v.number()),
    maxMessageId: v.optional(v.number()),
    minPositiveMessageId: v.optional(v.number()),
    maxPositiveMessageId: v.optional(v.number()),
    firstTs: v.optional(v.number()),
    lastTs: v.optional(v.number()),
    firstDateMessageId: v.optional(v.number()),
    lastDateMessageId: v.optional(v.number()),
    embeddedMessages: v.number(),
    embeddingChunks: v.number(),
    minEmbeddedMessageId: v.optional(v.number()),
    maxEmbeddedMessageId: v.optional(v.number()),
    lastEmbeddedAt: v.optional(v.number()),
    embeddingModel: v.optional(v.string()),
    embeddingVersion: v.optional(v.number()),
    embeddingDimensions: v.optional(v.number()),
    rebuiltAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_chat", ["chatId"]),

  searchRequests: defineTable({
    chatId: v.number(),
    requesterId: v.number(),
    requestMessageId: v.number(),
    ackMessageId: v.optional(v.number()),
    parentSearchRequestId: v.optional(v.id("searchRequests")),
    mode: v.optional(v.union(v.literal("search"), v.literal("ask"))),
    query: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("searching"),
      v.literal("done"),
      v.literal("error"),
    ),
    resultMessageIds: v.optional(v.array(v.number())),
    outputMessageIds: v.optional(v.array(v.number())),
    resultText: v.optional(v.string()),
    traceStorageId: v.optional(v.id("_storage")),
    traceUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_chat_created", ["chatId", "createdAt"])
    .index("by_chat_ack", ["chatId", "ackMessageId"]),

  chatImportJobs: defineTable({
    chatId: v.optional(v.number()),
    exportChatId: v.optional(v.number()),
    exportChatType: v.optional(v.string()),
    exportChatName: v.optional(v.string()),
    fileId: v.string(),
    fileName: v.optional(v.string()),
    fileMimeType: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    chunkStorageIds: v.optional(v.array(v.id("_storage"))),
    nextMessageIndex: v.optional(v.number()),
    nextChunkIndex: v.optional(v.number()),
    requesterId: v.number(),
    requestChatId: v.number(),
    requestMessageId: v.number(),
    ackMessageId: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("downloading"),
      v.literal("importing"),
      v.literal("indexing"),
      v.literal("done"),
      v.literal("error"),
    ),
    totalMessages: v.optional(v.number()),
    importedMessages: v.optional(v.number()),
    skippedMessages: v.optional(v.number()),
    indexedMessages: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_chat_created", ["chatId", "createdAt"]),

  // One row per /summary request. The selected message_ids are FROZEN
  // here at request time — re-rendering with a different mode/context/
  // detail does not re-run the filter, only the summarizer.
  chatSummaries: defineTable({
    chatId: v.number(),
    shortId: v.optional(v.string()),
    requesterId: v.number(),
    requestMessageId: v.number(),
    ackMessageId: v.optional(v.number()),

    // The frozen selection.
    startTs: v.number(),
    endTs: v.number(),
    fromUsername: v.optional(v.string()),
    filterDescription: v.optional(v.string()),
    messageIds: v.array(v.number()),

    // Auto-resolved mode/context (router result, cached once per request).
    autoMode: v.optional(v.string()),
    autoContext: v.optional(v.string()),

    // Currently displayed in the source chat — used by "apply to chat".
    displayedMode: v.optional(v.string()),
    displayedContext: v.optional(v.string()),
    displayedDetail: v.optional(v.number()),

    status: v.union(
      v.literal("pending"),
      v.literal("filtering"),
      v.literal("routing"),
      v.literal("summarizing"),
      v.literal("done"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    cancelled: v.optional(v.boolean()),
  })
    .index("by_short_id", ["shortId"])
    .index("by_chat_ack", ["chatId", "ackMessageId"]),

  // Cache for chat-summary text by (request, mode, context, detail). Same
  // pattern as voice `summaries`, just keyed against chatSummaries.
  chatSummaryTexts: defineTable({
    chatSummaryId: v.id("chatSummaries"),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    text: v.string(),
  }).index("by_settings", ["chatSummaryId", "mode", "context", "detail"]),

  // Picker session for chat summaries. Mirrors userSession but for the
  // chat-summary deep-link flow (`/start c<shortId>`).
  chatSummarySession: defineTable({
    userId: v.number(),
    chatSummaryShortId: v.string(),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    pickerMessageId: v.optional(v.number()),
    view: v.union(
      v.literal("main"),
      v.literal("mode"),
      v.literal("context"),
      v.literal("detail"),
    ),
    updatedAt: v.number(),
  }).index("by_user_summary", ["userId", "chatSummaryShortId"]),

  // The bot's own Q&A answer messages (replies to questions asked under a
  // summary). Stored so a follow-up reply to the bot's answer keeps the
  // link back to the source voice / chat summary.
  qaMessages: defineTable({
    chatId: v.number(),
    messageId: v.number(), // the bot's answer message id in the chat
    voiceShortId: v.optional(v.string()),
    chatSummaryShortId: v.optional(v.string()),
  }).index("by_chat_message", ["chatId", "messageId"]),

  // ---- end of chat-summary feature ---------------------------------------

  // Per-user-per-voice picker state. When a user opens a voice via the
  // deep-link, we materialize a row here so subsequent button clicks know
  // which mode/context/detail they're currently looking at.
  userSession: defineTable({
    userId: v.number(),
    voiceShortId: v.string(),
    mode: v.string(),
    context: v.string(),
    detail: v.number(),
    // The message_id of the picker message in the user's DM, so callbacks
    // can edit it in place instead of spawning new messages.
    pickerMessageId: v.optional(v.number()),
    // Current sub-picker (or "main" if on the top view).
    view: v.union(
      v.literal("main"),
      v.literal("mode"),
      v.literal("context"),
      v.literal("detail"),
    ),
    updatedAt: v.number(),
  }).index("by_user_voice", ["userId", "voiceShortId"]),

  // === LEGACY — kept only so Convex can validate pre-existing rows ===
  // Nothing in the new code writes to either of these. Safe to delete
  // after a dev-db reset.
  voiceTypes: defineTable({
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    detectionHints: v.optional(v.string()),
    summaryPrompt: v.optional(v.string()),
  }),
  adminState: defineTable({
    adminId: v.optional(v.number()),
    chatId: v.optional(v.number()),
    state: v.optional(v.string()),
    draft: v.optional(v.any()),
    targetTypeId: v.optional(v.id("voiceTypes")),
    editField: v.optional(v.string()),
  }),

  // Singleton. Two unrelated things:
  //   1. Webhook URL + secret we last registered with Telegram.
  //   2. Per-stage LLM model selection and debug mode.
  botConfig: defineTable({
    webhookUrl: v.optional(v.string()),
    webhookSecret: v.optional(v.string()),
    webhookRegisteredAt: v.optional(v.number()),
    botUsername: v.optional(v.string()),

    // === LEGACY: model fields used to live here ===
    // The bot's model selection now lives in `convex/models.ts` in code.
    // These fields are kept optional so pre-existing rows still validate
    // against the schema; new code never reads or writes them. Safe to
    // delete after a dev-db reset.
    transcribeModel: v.optional(v.string()),
    classifyProvider: v.optional(
      v.union(v.literal("openai"), v.literal("openrouter")),
    ),
    classifyModel: v.optional(v.string()),
    summarizeProvider: v.optional(
      v.union(v.literal("openai"), v.literal("openrouter")),
    ),
    summarizeModel: v.optional(v.string()),

    debugMode: v.optional(v.boolean()),
  }),
});
