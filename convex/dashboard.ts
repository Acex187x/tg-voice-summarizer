// Read-only queries for the private history dashboard (dashboard/server.py).
//
// Why this file exists: the first dashboard mirrored every table into a local
// SQLite file by calling `_system/cli/tableData` in a loop (every 60 s, later
// every 10 min plus a weekly full pass). That was ~92 GB of Database I/O in one
// billing period. These queries replace the mirror: the dashboard calls them
// only when the user opens the page or clicks a button, and every call reads one
// small, index-bounded page.
//
// Rules for everything in this file:
//   - internalQuery only. Not callable from the public client; the dashboard
//     server calls them over the HTTP API with the deployment admin key.
//   - Every read goes through an index (or the search index) with a hard page
//     limit. No .collect() on big tables, no .filter() scans.
//   - messageEmbeddings is never read.
//   - Return only what the UI renders. Convex bills Database I/O for the whole
//     document it reads, so projection does not cut the bill; it only keeps
//     responses small. The real saving is the number of documents read.
//   - Every response carries `readBytes`: the JSON size of the documents this
//     call read. It approximates the Database I/O of the call; the UI shows it.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";

const MAX_PAGE = 100;
const PREVIEW_CHARS = 600;

const pageArgs = {
  cursor: v.union(v.string(), v.null()),
  numItems: v.number(),
};

function clampPage(p: { cursor: string | null; numItems: number }) {
  return {
    cursor: p.cursor,
    numItems: Math.max(1, Math.min(MAX_PAGE, Math.floor(p.numItems))),
  };
}

function sizeOf(docs: unknown[]): number {
  let n = 0;
  for (const d of docs) if (d) n += JSON.stringify(d).length;
  return n;
}

function preview(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= PREVIEW_CHARS) return text;
  return text.slice(0, PREVIEW_CHARS) + "…";
}

function messageView(m: Doc<"chatMessages">) {
  return {
    _id: m._id,
    chatId: m.chatId,
    messageId: m.messageId,
    ts: m.ts,
    fromId: m.fromId,
    fromName: m.fromName,
    fromFirstName: m.fromFirstName,
    fromLastName: m.fromLastName,
    fromUsername: m.fromUsername,
    text: m.text,
    mediaKind: m.mediaKind,
    voiceShortId: m.voiceShortId,
    replyToMessageId: m.replyToMessageId,
    importedFromDump: m.importedFromDump,
  };
}

function voiceView(v: Doc<"voiceMessages">, full: boolean) {
  return {
    _id: v._id,
    _creationTime: v._creationTime,
    chatId: v.chatId,
    chatTitle: v.chatTitle,
    messageId: v.messageId,
    fromId: v.fromId,
    fromName: v.fromName,
    mediaKind: v.mediaKind,
    durationSec: v.durationSec,
    status: v.status,
    error: v.error,
    transcript: full ? v.transcript : preview(v.transcript),
    transcriptLength: v.transcript?.length ?? 0,
  };
}

function chatSummaryView(s: Doc<"chatSummaries">) {
  return {
    _id: s._id,
    _creationTime: s._creationTime,
    chatId: s.chatId,
    startTs: s.startTs,
    endTs: s.endTs,
    fromUsername: s.fromUsername,
    filterDescription: s.filterDescription,
    messageCount: s.messageIds.length,
    displayedMode: s.displayedMode,
    displayedContext: s.displayedContext,
    status: s.status,
    error: s.error,
  };
}

// Sidebar: one row per chat that has stored messages.
// Reads chatIndexStats (one row per chat), chatImportJobs (one row per
// import) and, for chats without an import title, the latest voice of that
// chat (one document per chat) to get its title.
export const chats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const stats = await ctx.db.query("chatIndexStats").take(500);
    const jobs = await ctx.db.query("chatImportJobs").order("desc").take(200);
    let readBytes = sizeOf(stats) + sizeOf(jobs);

    const titles = new Map<number, string>();
    for (const j of jobs) {
      if (j.chatId !== undefined && j.exportChatName && !titles.has(j.chatId)) {
        titles.set(j.chatId, j.exportChatName);
      }
    }

    const rows = [];
    for (const s of stats) {
      let title = titles.get(s.chatId);
      if (!title) {
        const voice = await ctx.db
          .query("voiceMessages")
          .withIndex("by_chat_message", (q) => q.eq("chatId", s.chatId))
          .order("desc")
          .first();
        readBytes += sizeOf([voice]);
        title = voice?.chatTitle;
      }
      rows.push({
        chatId: s.chatId,
        title: title ?? null,
        messageTotal: s.messageTotal,
        importedMessages: s.importedMessages,
        liveMessages: s.liveMessages,
        firstTs: s.firstTs ?? null,
        lastTs: s.lastTs ?? null,
      });
    }
    rows.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
    return { chats: rows, readBytes };
  },
});

// Message list.
//   - search: full-text search index (optionally within one chat), by relevance.
//   - chatId: by_chat_ts index, optional [fromTs, toTs) window, newest or oldest first.
//   - neither: latest stored messages across all chats (_creationTime order).
//     Imported history is stored at import time, so imports show up where
//     they were imported, not where they were written.
export const messages = internalQuery({
  args: {
    paginationOpts: v.object(pageArgs),
    chatId: v.optional(v.number()),
    fromTs: v.optional(v.number()),
    toTs: v.optional(v.number()),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const opts = clampPage(args.paginationOpts);
    const search = args.search?.trim();
    let result;
    if (search) {
      result = await ctx.db
        .query("chatMessages")
        .withSearchIndex("search_text", (q) =>
          args.chatId === undefined
            ? q.search("text", search)
            : q.search("text", search).eq("chatId", args.chatId),
        )
        .paginate(opts);
    } else if (args.chatId !== undefined) {
      const chatId = args.chatId;
      const { fromTs, toTs } = args;
      result = await ctx.db
        .query("chatMessages")
        .withIndex("by_chat_ts", (q) => {
          const c = q.eq("chatId", chatId);
          if (fromTs !== undefined && toTs !== undefined) return c.gte("ts", fromTs).lt("ts", toTs);
          if (fromTs !== undefined) return c.gte("ts", fromTs);
          if (toTs !== undefined) return c.lt("ts", toTs);
          return c;
        })
        .order(args.order ?? "desc")
        .paginate(opts);
    } else {
      result = await ctx.db
        .query("chatMessages")
        .order(args.order ?? "desc")
        .paginate(opts);
    }
    return {
      items: result.page.map(messageView),
      cursor: result.isDone ? null : result.continueCursor,
      readBytes: sizeOf(result.page),
    };
  },
});

// Voices, newest first. With chatId: by_chat_message index (message order).
// Transcripts are cut to a preview; the detail call returns the full text.
export const voices = internalQuery({
  args: {
    paginationOpts: v.object(pageArgs),
    chatId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const opts = clampPage(args.paginationOpts);
    const chatId = args.chatId;
    const result =
      chatId === undefined
        ? await ctx.db.query("voiceMessages").order("desc").paginate(opts)
        : await ctx.db
            .query("voiceMessages")
            .withIndex("by_chat_message", (q) => q.eq("chatId", chatId))
            .order("desc")
            .paginate(opts);
    return {
      items: result.page.map((x) => voiceView(x, false)),
      cursor: result.isDone ? null : result.continueCursor,
      readBytes: sizeOf(result.page),
    };
  },
});

// /summary requests, newest first. With chatId: by_chat_ack index.
export const chatSummaries = internalQuery({
  args: {
    paginationOpts: v.object(pageArgs),
    chatId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const opts = clampPage(args.paginationOpts);
    const chatId = args.chatId;
    const result =
      chatId === undefined
        ? await ctx.db.query("chatSummaries").order("desc").paginate(opts)
        : await ctx.db
            .query("chatSummaries")
            .withIndex("by_chat_ack", (q) => q.eq("chatId", chatId))
            .order("desc")
            .paginate(opts);
    return {
      items: result.page.map(chatSummaryView),
      cursor: result.isDone ? null : result.continueCursor,
      readBytes: sizeOf(result.page),
    };
  },
});

// One message with its context: the message it replies to, the voice row
// for it (if it is a voice) and that voice's cached summaries.
export const messageDetail = internalQuery({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    const byMessage = (id: number) =>
      ctx.db
        .query("chatMessages")
        .withIndex("by_chat_message", (q) => q.eq("chatId", chatId).eq("messageId", id))
        .first();
    const message = await byMessage(messageId);
    const replyTo =
      message?.replyToMessageId !== undefined ? await byMessage(message.replyToMessageId) : null;
    const voice = await ctx.db
      .query("voiceMessages")
      .withIndex("by_chat_message", (q) => q.eq("chatId", chatId).eq("messageId", messageId))
      .first();
    const summaries = voice
      ? await ctx.db
          .query("summaries")
          .withIndex("by_voice_settings", (q) => q.eq("voiceMessageId", voice._id))
          .take(20)
      : [];
    return {
      message: message ? messageView(message) : null,
      replyTo: replyTo ? messageView(replyTo) : null,
      voice: voice ? voiceView(voice, true) : null,
      summaries: summaries.map((s) => ({
        _id: s._id,
        mode: s.mode,
        context: s.context,
        detail: s.detail,
        text: s.text,
      })),
      readBytes: sizeOf([message, replyTo, voice, ...summaries]),
    };
  },
});

export const voiceDetail = internalQuery({
  args: { voiceId: v.id("voiceMessages") },
  handler: async (ctx, { voiceId }) => {
    const voice = await ctx.db.get(voiceId);
    const summaries = voice
      ? await ctx.db
          .query("summaries")
          .withIndex("by_voice_settings", (q) => q.eq("voiceMessageId", voiceId))
          .take(20)
      : [];
    return {
      voice: voice ? voiceView(voice, true) : null,
      summaries: summaries.map((s) => ({
        _id: s._id,
        mode: s.mode,
        context: s.context,
        detail: s.detail,
        text: s.text,
      })),
      readBytes: sizeOf([voice, ...summaries]),
    };
  },
});

export const chatSummaryDetail = internalQuery({
  args: { chatSummaryId: v.id("chatSummaries") },
  handler: async (ctx, { chatSummaryId }) => {
    const summary = await ctx.db.get(chatSummaryId);
    const texts = summary
      ? await ctx.db
          .query("chatSummaryTexts")
          .withIndex("by_settings", (q) => q.eq("chatSummaryId", chatSummaryId))
          .take(20)
      : [];
    return {
      summary: summary ? chatSummaryView(summary) : null,
      texts: texts.map((t) => ({
        _id: t._id,
        mode: t.mode,
        context: t.context,
        detail: t.detail,
        text: t.text,
      })),
      readBytes: sizeOf([summary, ...texts]),
    };
  },
});
