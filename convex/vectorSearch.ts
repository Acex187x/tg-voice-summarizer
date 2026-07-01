import { v } from "convex/values";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
  SUMMARIZE_MODEL,
  SUMMARIZE_PROVIDER,
} from "./models";
import { createEmbedding, createEmbeddings } from "./openai";
import {
  editMessageText,
  escapeHtml,
  type InlineKeyboard,
  loadingEmoji,
  markdownToTelegramHtml,
  resolveMessageLinks,
  sendMessage,
  splitTextSafely,
  TG_TEXT_LIMIT,
} from "./telegram";

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const SEARCH_VECTOR_LIMIT = 160;
const SUMMARY_VECTOR_LIMIT = 80;
const SEARCH_RENDER_LIMIT = 60;
const SEARCH_AGENT_EVIDENCE_POOL_LIMIT = 300;
const SEARCH_AGENT_ANALYSIS_LIMIT = 180;
const SEARCH_PROGRESS_MIN_INTERVAL_MS = 3500;
const SEARCH_AGENT_MAX_STEPS = 18;
const SEARCH_TRACE_MAX_CHARS = 8_000_000;

function aiSdkModel(provider: string, model: string) {
  if (provider === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    return createOpenAI({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: key,
      headers: {
        "HTTP-Referer": "https://github.com/tg-voice-summarizer",
        "X-Title": "tg-voice-summarizer",
      },
    }).chat(model);
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return createOpenAI({ apiKey: key }).chat(model);
}

function logSearchAgent(event: string, payload: Record<string, unknown>): void {
  console.log(
    `[search-agent] ${event} ${JSON.stringify(payload, (_key, value) => {
      if (typeof value === "string" && value.length > 12000) {
        return `${value.slice(0, 12000)}…[truncated ${value.length - 12000} chars]`;
      }
      return value;
    })}`,
  );
}

type SearchTrace = {
  requestId: string;
  chatId: number;
  query: string;
  startedAt: string;
  chars: number;
  truncated: boolean;
  lines: string[];
};

type SearchHistoryItem = {
  mode: "search" | "ask";
  query: string;
  resultText: string;
  resultMessageIds: number[];
  createdAt: number;
};

type SearchAgentMode = "search" | "ask";

function createSearchTrace(
  requestId: string,
  chatId: number,
  query: string,
): SearchTrace {
  const trace: SearchTrace = {
    requestId,
    chatId,
    query,
    startedAt: new Date().toISOString(),
    chars: 0,
    truncated: false,
    lines: [],
  };
  appendTrace(
    trace,
    "Metadata",
    [
      `- requestId: ${requestId}`,
      `- chatId: ${chatId}`,
      `- query: ${query}`,
      `- startedAt: ${trace.startedAt}`,
    ].join("\n"),
  );
  return trace;
}

function appendTrace(trace: SearchTrace, title: string, body: string): void {
  if (trace.truncated) return;
  const block = `\n\n## ${title}\n\n${body}`;
  if (trace.chars + block.length > SEARCH_TRACE_MAX_CHARS) {
    trace.lines.push(
      `\n\n## Trace Truncated\n\nTrace exceeded ${SEARCH_TRACE_MAX_CHARS} characters. Later events were omitted.`,
    );
    trace.truncated = true;
    return;
  }
  trace.lines.push(block);
  trace.chars += block.length;
}

function appendTraceJson(
  trace: SearchTrace,
  title: string,
  value: unknown,
): void {
  appendTrace(trace, title, `\`\`\`json\n${safeJson(value)}\n\`\`\``);
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      },
      2,
    );
  } catch (err) {
    return JSON.stringify({
      serializationError: err instanceof Error ? err.message : String(err),
      stringValue: String(value),
    });
  }
}

function renderTraceMarkdown(trace: SearchTrace): string {
  return `# /search Agent Trace\n${trace.lines.join("")}\n`;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function chunkText(text: string): string[] {
  const normalized = text.trim();
  if (normalized.length <= CHUNK_SIZE) return normalized ? [normalized] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + CHUNK_SIZE, normalized.length);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", hardEnd);
      if (boundary > start + CHUNK_SIZE * 0.6) end = boundary;
      else {
        const space = normalized.lastIndexOf(" ", hardEnd);
        if (space > start + CHUNK_SIZE * 0.6) end = space;
      }
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function senderDisplayName(msg: Doc<"chatMessages">): string {
  const full = [msg.fromFirstName ?? msg.fromName, msg.fromLastName]
    .filter((s) => s && s.length > 0)
    .join(" ");
  if (full) return full;
  if (msg.fromUsername) return `@${msg.fromUsername}`;
  return `user${msg.fromId ?? "?"}`;
}

async function buildEmbeddableText(
  ctx: { runQuery: any },
  msg: Doc<"chatMessages">,
): Promise<string | null> {
  let body = msg.text?.trim() ?? "";
  if (
    (msg.mediaKind === "voice" ||
      msg.mediaKind === "audio" ||
      msg.mediaKind === "video_note") &&
    msg.voiceShortId
  ) {
    const voice = await ctx.runQuery(internal.voiceMessages.getByShortId, {
      shortId: msg.voiceShortId,
    });
    if (voice?.transcript) body = voice.transcript.trim();
  }

  if (!body) {
    if (msg.mediaKind === "photo") body = "[фото]";
    else if (msg.mediaKind === "video") body = "[видео]";
    else if (msg.mediaKind === "document") body = "[файл]";
    else if (msg.mediaKind === "sticker") body = "[стикер]";
  }
  body = body.trim();
  if (!body) return null;

  const time = new Date(msg.ts * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  return [
    `Автор: ${senderDisplayName(msg)}`,
    `Время: ${time}`,
    `Тип: ${msg.mediaKind ?? "text"}`,
    `Текст: ${body}`,
  ].join("\n");
}

export const indexChatMessage = internalAction({
  args: { chatMessageId: v.id("chatMessages") },
  handler: async (ctx, { chatMessageId }): Promise<number> => {
    return await indexChatMessageNow(ctx, chatMessageId);
  },
});

async function indexChatMessageNow(
  ctx: { runQuery: any; runMutation: any },
  chatMessageId: Id<"chatMessages">,
): Promise<number> {
  const msg = (await ctx.runQuery(internal.chatMessages.get, {
    id: chatMessageId,
  })) as Doc<"chatMessages"> | null;
  if (!msg) return 0;

  const text = await buildEmbeddableText(ctx, msg);
  if (!text) {
    await ctx.runMutation(internal.messageEmbeddings.deleteForMessage, {
      chatId: msg.chatId,
      messageId: msg.messageId,
    });
    return 0;
  }

  const contentHash = await sha256(
    `${EMBEDDING_MODEL}:${EMBEDDING_VERSION}:${normalizeText(text)}`,
  );
  const existing = (await ctx.runQuery(
    internal.messageEmbeddings.findForMessage,
    { chatId: msg.chatId, messageId: msg.messageId },
  )) as Doc<"messageEmbeddings">[];
  if (
    existing.length > 0 &&
    existing.every(
      (row) =>
        row.contentHash === contentHash &&
        row.embeddingModel === EMBEDDING_MODEL &&
        row.embeddingVersion === EMBEDDING_VERSION,
    )
  ) {
    return 0;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;
  const embeddings = await createEmbeddings(
    chunks,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
  );
  return await ctx.runMutation(internal.messageEmbeddings.storeForMessage, {
    chatId: msg.chatId,
    chatMessageId: msg._id,
    messageId: msg.messageId,
    ts: msg.ts,
    fromId: msg.fromId,
    fromUsername: msg.fromUsername,
    mediaKind: msg.mediaKind,
    chunks: chunks.map((chunkText, i) => ({
      chunkIndex: i,
      chunkText,
      embedding: embeddings[i],
    })),
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    embeddingVersion: EMBEDDING_VERSION,
    contentHash,
    embeddedAt: Date.now(),
  });
}

export const backfillMessageEmbeddings = internalAction({
  args: {
    chatId: v.number(),
    cursorTs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { chatId, cursorTs, limit }): Promise<void> => {
    const batchSize = Math.max(1, Math.min(limit ?? 25, 50));
    const rows = (await ctx.runQuery(internal.chatMessages.forBackfill, {
      chatId,
      afterTs: cursorTs,
      limit: batchSize,
    })) as Doc<"chatMessages">[];
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        await indexChatMessageNow(ctx, row._id);
      } catch (err) {
        console.warn(
          "indexChatMessage failed",
          row.chatId,
          row.messageId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const last = rows[rows.length - 1];
    if (rows.length === batchSize) {
      await ctx.scheduler.runAfter(
        1000,
        internal.vectorSearch.backfillMessageEmbeddings,
        {
          chatId,
          cursorTs: last.ts,
          limit: batchSize,
        },
      );
    }
  },
});

export interface SemanticSearchHit {
  message: Doc<"chatMessages">;
  score: number;
  snippet: string;
}

type SearchProgress = {
  chatId: number;
  ackMessageId?: number;
  lastEditAt: number;
};

async function updateSearchProgress(
  progress: SearchProgress | undefined,
  line: string,
  force = false,
): Promise<void> {
  if (!progress || progress.ackMessageId === undefined) return;
  const now = Date.now();
  if (!force && now - progress.lastEditAt < SEARCH_PROGRESS_MIN_INTERVAL_MS)
    return;
  progress.lastEditAt = now;
  await editMessageText(
    progress.chatId,
    progress.ackMessageId,
    `${loadingDots()} <i>${escapeHtml(line)}</i>`,
    { parseMode: "HTML" },
  ).catch((err) => {
    console.warn(
      "search progress edit failed",
      err instanceof Error ? err.message : err,
    );
  });
}

function loadingDots(): string {
  return loadingEmoji();
}

export async function semanticSearchMessages(
  ctx: { vectorSearch: any; runQuery: any },
  chatId: number,
  query: string,
  limit: number = SUMMARY_VECTOR_LIMIT,
  trace?: { requestId?: string; round?: number },
): Promise<SemanticSearchHit[]> {
  logSearchAgent("tool_call.vectorSearch.start", {
    requestId: trace?.requestId,
    round: trace?.round,
    chatId,
    query,
    limit,
  });
  const vector = await createEmbedding(
    query,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
  );
  const raw = (await ctx.vectorSearch("messageEmbeddings", "by_embedding", {
    vector,
    limit,
    filter: (q: any) => q.eq("chatId", chatId),
  })) as Array<{ _id: Id<"messageEmbeddings">; _score: number }>;
  if (raw.length === 0) {
    logSearchAgent("tool_call.vectorSearch.output", {
      requestId: trace?.requestId,
      round: trace?.round,
      query,
      resultCount: 0,
      top: [],
    });
    return [];
  }

  const embeddingRows = (await ctx.runQuery(
    internal.messageEmbeddings.getByIds,
    {
      ids: raw.map((r) => r._id),
    },
  )) as Doc<"messageEmbeddings">[];
  const scoreById = new Map(raw.map((r) => [String(r._id), r._score]));
  const bestByMessage = new Map<
    number,
    { row: Doc<"messageEmbeddings">; score: number }
  >();
  for (const row of embeddingRows) {
    const score = scoreById.get(String(row._id)) ?? 0;
    const prev = bestByMessage.get(row.messageId);
    if (!prev || score > prev.score)
      bestByMessage.set(row.messageId, { row, score });
  }

  const messages = (await ctx.runQuery(internal.chatMessages.getByIds, {
    chatId,
    messageIds: Array.from(bestByMessage.keys()),
  })) as Doc<"chatMessages">[];
  const messageById = new Map(messages.map((m) => [m.messageId, m]));
  const hits = Array.from(bestByMessage.values())
    .map(({ row, score }) => {
      const message = messageById.get(row.messageId);
      if (!message) return null;
      return { message, score, snippet: row.chunkText };
    })
    .filter((x): x is SemanticSearchHit => x !== null)
    .sort((a, b) => b.score - a.score);
  logSearchAgent("tool_call.vectorSearch.output", {
    requestId: trace?.requestId,
    round: trace?.round,
    query,
    resultCount: hits.length,
    top: hits.slice(0, 20).map((hit) => ({
      messageId: hit.message.messageId,
      score: hit.score,
      snippet: describeHit(hit).slice(0, 300),
    })),
  });
  return hits;
}

export const processVectorSearch = internalAction({
  args: { searchRequestId: v.id("searchRequests") },
  handler: async (ctx, { searchRequestId }): Promise<void> => {
    const request = await ctx.runQuery(internal.searchRequests.get, {
      id: searchRequestId,
    });
    if (!request) return;
    try {
      await ctx.runMutation(internal.searchRequests.setStatus, {
        id: searchRequestId,
        status: "searching",
      });
      const mode = (request.mode ?? "search") as SearchAgentMode;
      const history = await loadSearchHistory(ctx, request);
      const { html, reportText, hits, traceStorageId, traceUrl } =
        await runSearchAgent(
          ctx,
          request.chatId,
          request.query,
          String(searchRequestId),
          mode,
          history,
          {
            chatId: request.chatId,
            ackMessageId: request.ackMessageId,
            lastEditAt: 0,
          },
        );
      const top = hits.slice(0, SEARCH_RENDER_LIMIT);
      const outputMessageIds = await commitSearchResult(
        request.chatId,
        request.ackMessageId,
        request.requestMessageId,
        html,
        traceUrl,
      );
      await ctx.runMutation(internal.searchRequests.setStatus, {
        id: searchRequestId,
        status: "done",
        resultMessageIds: top.map((h) => h.message.messageId),
        outputMessageIds,
        resultText: reportText,
        ...(traceStorageId !== undefined ? { traceStorageId } : {}),
        ...(traceUrl !== undefined ? { traceUrl } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.searchRequests.setStatus, {
        id: searchRequestId,
        status: "error",
        error: message,
      });
      if (request.ackMessageId !== undefined) {
        await editMessageText(
          request.chatId,
          request.ackMessageId,
          `Не удалось выполнить поиск: ${escapeHtml(message)}`,
          { parseMode: "HTML" },
        ).catch(() => {});
      }
    }
  },
});

async function loadSearchHistory(
  ctx: { runQuery: any },
  request: Doc<"searchRequests">,
): Promise<SearchHistoryItem[]> {
  const chain: SearchHistoryItem[] = [];
  let parentId = request.parentSearchRequestId;
  const seen = new Set<string>();

  while (parentId && chain.length < 50 && !seen.has(String(parentId))) {
    seen.add(String(parentId));
    const parent = (await ctx.runQuery(internal.searchRequests.get, {
      id: parentId,
    })) as Doc<"searchRequests"> | null;
    if (!parent) break;
    chain.push({
      mode: (parent.mode ?? "search") as SearchAgentMode,
      query: parent.query,
      resultText: parent.resultText ?? parent.error ?? "",
      resultMessageIds: parent.resultMessageIds ?? [],
      createdAt: parent.createdAt,
    });
    parentId = parent.parentSearchRequestId;
  }

  return chain.reverse();
}

async function runSearchAgent(
  ctx: { vectorSearch: any; runQuery: any; storage: any },
  chatId: number,
  query: string,
  requestId: string,
  mode: SearchAgentMode = "search",
  history: SearchHistoryItem[] = [],
  progress?: SearchProgress,
): Promise<{
  html: string;
  reportText: string;
  hits: SemanticSearchHit[];
  traceStorageId?: Id<"_storage">;
  traceUrl?: string;
}> {
  logSearchAgent("run.start", { requestId, chatId, query });
  const trace = createSearchTrace(requestId, chatId, query);
  await updateSearchProgress(progress, "Запускаю поискового агента…", true);
  const byMessage = new Map<
    number,
    SemanticSearchHit & { matchedQueries: string[] }
  >();
  const inspectedMessageIds = new Set<number>();
  const usedQueries: string[] = [];
  const system =
    mode === "ask"
      ? buildAskAgentSystemPrompt()
      : buildSearchAgentSystemPrompt();
  const historyBlock = renderSearchHistoryForAgent(history);
  const prompt =
    `${mode === "ask" ? "Вопрос пользователя" : "Запрос пользователя"}: ${query}\n\n` +
    (historyBlock ? `${historyBlock}\n\n` : "") +
    (mode === "ask"
      ? "Дай конкретный краткий ответ, но сначала сам найди и проверь сообщения-доказательства через инструменты."
      : "Работай как исследователь архива всего чата. Сам решай, сколько раз искать, что уточнять и какие инструменты вызывать.");
  appendTrace(trace, "System Prompt", `\`\`\`text\n${system}\n\`\`\``);
  appendTrace(trace, "User Prompt", `\`\`\`text\n${prompt}\n\`\`\``);

  const result = await generateText({
    model: aiSdkModel(SUMMARIZE_PROVIDER, SUMMARIZE_MODEL),
    system,
    prompt,
    stopWhen: stepCountIs(SEARCH_AGENT_MAX_STEPS),
    temperature: 0.25,
    maxOutputTokens: 2500,
    tools: {
      reportStatus: tool({
        description:
          "Обновляет одну короткую строку статуса для пользователя. Вызывай перед долгими действиями и когда меняется этап работы.",
        inputSchema: z.object({
          status: z.string().describe("Короткий статус до 110 символов."),
        }),
        execute: async ({ status }) => {
          appendTraceJson(trace, "Tool Call: reportStatus input", { status });
          await updateSearchProgress(progress, status, false);
          const output = { ok: true };
          appendTraceJson(trace, "Tool Call: reportStatus output", output);
          return output;
        },
      }),
      searchMessages: tool({
        description:
          "Semantic vector search по всей импортированной и текущей истории чата. Возвращает кандидатов, не доказательства. После него обязательно проверяй важные id через inspectContext/inspectMessages.",
        inputSchema: z.object({
          query: z.string().describe("Короткий semantic-search запрос."),
          limit: z
            .number()
            .min(5)
            .max(80)
            .optional()
            .describe("Сколько результатов вернуть модели. Обычно 20-50."),
          purpose: z
            .string()
            .optional()
            .describe("Зачем ты делаешь этот поиск."),
        }),
        execute: async ({ query: toolQuery, limit, purpose }) => {
          appendTraceJson(trace, "Tool Call: searchMessages input", {
            query: toolQuery,
            limit,
            purpose,
          });
          usedQueries.push(toolQuery);
          await updateSearchProgress(
            progress,
            `Ищу: ${toolQuery.slice(0, 90)}…`,
            false,
          );
          const hits = await semanticSearchMessages(
            ctx,
            chatId,
            toolQuery,
            Math.min(limit ?? 40, 80),
            { requestId },
          );
          for (const hit of hits) {
            const prev = byMessage.get(hit.message.messageId);
            if (!prev || hit.score > prev.score) {
              byMessage.set(hit.message.messageId, {
                ...hit,
                matchedQueries: [toolQuery],
              });
            } else if (!prev.matchedQueries.includes(toolQuery)) {
              prev.matchedQueries.push(toolQuery);
            }
          }
          trimEvidencePool(byMessage);
          const compact = hits.slice(0, limit ?? 40).map((hit) => ({
            id: hit.message.messageId,
            score: Number(hit.score.toFixed(3)),
            warning: "candidate_only_verify_context_before_citing",
            text: describeHit(hit).slice(0, 700),
          }));
          const output = {
            query: toolQuery,
            purpose: purpose ?? null,
            returned: compact.length,
            totalEvidencePool: byMessage.size,
            results: compact,
          };
          appendTraceJson(trace, "Tool Call: searchMessages output", output);
          return output;
        },
      }),
      lexicalSearch: tool({
        description:
          "Full-text search по тексту сообщений. Используй для прямых упоминаний имён, мемов, терминов, фраз и проверки, что тема реально встречается в сообщениях.",
        inputSchema: z.object({
          query: z
            .string()
            .describe("Слова или короткая фраза для full-text поиска."),
          limit: z.number().min(5).max(80).optional(),
          purpose: z.string().optional(),
        }),
        execute: async ({ query: toolQuery, limit, purpose }) => {
          appendTraceJson(trace, "Tool Call: lexicalSearch input", {
            query: toolQuery,
            limit,
            purpose,
          });
          usedQueries.push(`lexical:${toolQuery}`);
          await updateSearchProgress(
            progress,
            `Проверяю прямые упоминания: ${toolQuery.slice(0, 80)}…`,
            false,
          );
          const rows = (await ctx.runQuery(
            internal.chatMessages.lexicalSearch,
            {
              chatId,
              query: toolQuery,
              limit: Math.min(limit ?? 30, 80),
            },
          )) as Doc<"chatMessages">[];
          for (const row of rows) {
            const prev = byMessage.get(row.messageId);
            const hit: SemanticSearchHit & { matchedQueries: string[] } = {
              message: row,
              score: prev?.score ?? 1,
              snippet: row.text ?? `[${row.mediaKind ?? "сообщение"}]`,
              matchedQueries: [
                ...(prev?.matchedQueries ?? []),
                `lexical:${toolQuery}`,
              ],
            };
            byMessage.set(row.messageId, hit);
          }
          trimEvidencePool(byMessage);
          const output = {
            query: toolQuery,
            purpose: purpose ?? null,
            returned: rows.length,
            results: rows.map((row) => ({
              id: row.messageId,
              text: formatMessageForAgent(row, 700),
            })),
          };
          appendTraceJson(trace, "Tool Call: lexicalSearch output", output);
          return output;
        },
      }),
      inspectMessages: tool({
        description:
          "Получить более полный текст конкретных сообщений по id, если нужно проверить детали перед финальным ответом.",
        inputSchema: z.object({
          messageIds: z.array(z.number()).min(1).max(30),
        }),
        execute: async ({ messageIds }) => {
          appendTraceJson(trace, "Tool Call: inspectMessages input", {
            messageIds,
          });
          const rows = (await ctx.runQuery(internal.chatMessages.getByIds, {
            chatId,
            messageIds,
          })) as Doc<"chatMessages">[];
          for (const row of rows) inspectedMessageIds.add(row.messageId);
          const output = {
            messages: rows.map((m) => ({
              id: m.messageId,
              text: formatMessageForAgent(m, 1800),
            })),
          };
          appendTraceJson(trace, "Tool Call: inspectMessages output", output);
          return output;
        },
      }),
      inspectContext: tool({
        description:
          "Показать соседние сообщения вокруг найденных кандидатов. Главный инструмент против вырывания из контекста: используй перед выводами и ссылками.",
        inputSchema: z.object({
          messageIds: z.array(z.number()).min(1).max(8),
          before: z.number().min(1).max(10).optional(),
          after: z.number().min(1).max(10).optional(),
          purpose: z.string().optional(),
        }),
        execute: async ({ messageIds, before, after, purpose }) => {
          appendTraceJson(trace, "Tool Call: inspectContext input", {
            messageIds,
            before,
            after,
            purpose,
          });
          await updateSearchProgress(
            progress,
            "Смотрю контекст вокруг найденных сообщений…",
            false,
          );
          const groups = (await ctx.runQuery(
            internal.chatMessages.contextAroundIds,
            {
              chatId,
              messageIds,
              before: before ?? 6,
              after: after ?? 6,
            },
          )) as Array<{
            targetId: number;
            replyTo: Doc<"chatMessages"> | null;
            messages: Doc<"chatMessages">[];
          }>;
          for (const group of groups) {
            if (group.replyTo) inspectedMessageIds.add(group.replyTo.messageId);
            for (const row of group.messages)
              inspectedMessageIds.add(row.messageId);
          }
          const output = {
            purpose: purpose ?? null,
            contexts: groups.map((group) => ({
              targetId: group.targetId,
              replyTo: group.replyTo
                ? formatMessageForAgent(group.replyTo, 650)
                : null,
              messages: group.messages.map((row) => ({
                id: row.messageId,
                isTarget: row.messageId === group.targetId,
                text: formatMessageForAgent(row, 650),
              })),
            })),
          };
          appendTraceJson(trace, "Tool Call: inspectContext output", output);
          return output;
        },
      }),
    },
    experimental_onStart: (event: any) => {
      logSearchAgent("aiSdk.start", { requestId, event });
      appendTraceJson(trace, "AI SDK Start", event);
    },
    experimental_onStepStart: (event: any) => {
      logSearchAgent("aiSdk.step.start", { requestId, event });
      appendTraceJson(trace, "AI SDK Step Start", event);
    },
    experimental_onToolCallStart: (event: any) => {
      logSearchAgent("aiSdk.tool.start", { requestId, event });
      appendTraceJson(trace, "AI SDK Tool Start", event);
    },
    experimental_onToolCallFinish: (event: any) => {
      logSearchAgent("aiSdk.tool.finish", { requestId, event });
      appendTraceJson(trace, "AI SDK Tool Finish", event);
    },
    onStepFinish: (event: any) => {
      logSearchAgent("aiSdk.step.finish", { requestId, event });
      appendTraceJson(trace, "AI SDK Step Finish", event);
    },
    onFinish: (event: any) => {
      logSearchAgent("aiSdk.finish", { requestId, event });
      appendTraceJson(trace, "AI SDK Finish", event);
    },
  });

  const hits = Array.from(byMessage.values()).sort((a, b) => b.score - a.score);
  if (hits.length === 0) {
    appendTrace(trace, "Final Result", "No hits.");
    const traceArtifact = await storeSearchTrace(ctx, trace);
    const reportText =
      "Ничего похожего не нашёл. Если историю только что импортировали, индекс может ещё строиться.";
    return {
      html: renderNoSearchResults(mode),
      reportText,
      hits: [],
      ...traceArtifact,
    };
  }
  const verifiedHits = hits.filter((hit) =>
    inspectedMessageIds.has(hit.message.messageId),
  );
  const evidence = (verifiedHits.length > 0 ? verifiedHits : hits).slice(
    0,
    SEARCH_AGENT_ANALYSIS_LIMIT,
  );
  await updateSearchProgress(progress, "Публикую ответ…", true);
  const report = result.text;
  appendTrace(trace, "Final Model Text", `\`\`\`markdown\n${report}\n\`\`\``);
  appendTraceJson(trace, "Final Evidence", {
    totalHits: hits.length,
    verifiedHits: verifiedHits.length,
    evidence: evidence.map((hit) => ({
      messageId: hit.message.messageId,
      score: hit.score,
      matchedQueries:
        "matchedQueries" in hit ? (hit as any).matchedQueries : [],
      text: describeHit(hit),
    })),
  });
  const reportHtml = resolveMessageLinks(
    markdownToTelegramHtml(linkifyBareMsgRefs(report)),
    chatId,
  );
  const rendered = renderAgentResponse(mode, reportHtml);
  const html = `${rendered.headerHtml}\n\n<blockquote expandable>${rendered.bodyHtml}</blockquote>`;
  logSearchAgent("run.done", {
    requestId,
    query,
    totalQueries: usedQueries.length,
    totalHits: hits.length,
    verifiedHits: verifiedHits.length,
    analyzedHits: evidence.length,
    htmlLength: html.length,
  });
  appendTrace(trace, "Final Telegram HTML", `\`\`\`html\n${html}\n\`\`\``);
  const traceArtifact = await storeSearchTrace(ctx, trace);
  return { html, reportText: report, hits, ...traceArtifact };
}

function renderSearchHistoryForAgent(history: SearchHistoryItem[]): string {
  if (history.length === 0) return "";
  const blocks = history.map((item, index) => {
    const when = new Date(item.createdAt).toISOString();
    const evidence = item.resultMessageIds.length
      ? `Проверенные/использованные сообщения: ${item.resultMessageIds
          .slice(0, 40)
          .map((id) => `msg:${id}`)
          .join(", ")}`
      : "Проверенные/использованные сообщения: не сохранены";
    const result =
      item.resultText.length > 2500
        ? `${item.resultText.slice(0, 2500).trimEnd()}\n...[обрезано]`
        : item.resultText;
    return [
      `### Шаг ${index + 1} (${when})`,
      `Тип: ${item.mode === "ask" ? "ask" : "search"}`,
      `${item.mode === "ask" ? "Вопрос" : "Запрос"}: ${item.query}`,
      evidence,
      `Ответ агента:\n${result || "(нет сохранённого ответа)"}`,
    ].join("\n");
  });
  return `История предыдущих поисков в этой follow-up цепочке:

${blocks.join("\n\n")}`;
}

function renderAgentResponse(
  mode: SearchAgentMode,
  reportHtml: string,
): { headerHtml: string; bodyHtml: string } {
  const lines = reportHtml.trim().split(/\n+/);
  const first = stripHtml(lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n").trim();

  if (mode === "ask") {
    const answer = first.replace(/^ответ:\s*/i, "").trim() || "Нет ответа";
    return {
      headerHtml: `<b>Ответ:</b> ${escapeHtml(answer)}`,
      bodyHtml: rest || reportHtml,
    };
  }

  const title = first.replace(/^тема:\s*/i, "").trim() || "Поисковый отчёт";
  return {
    headerHtml: `<b>${escapeHtml(title)}</b>`,
    bodyHtml: rest || reportHtml,
  };
}

async function storeSearchTrace(
  ctx: { storage: any },
  trace: SearchTrace,
): Promise<{ traceStorageId?: Id<"_storage">; traceUrl?: string }> {
  try {
    const markdown = renderTraceMarkdown(trace);
    const storageId = (await ctx.storage.store(
      new Blob([markdown], { type: "text/markdown; charset=utf-8" }),
    )) as Id<"_storage">;
    const url = (await ctx.storage.getUrl(storageId)) ?? undefined;
    return { traceStorageId: storageId, traceUrl: url };
  } catch (err) {
    console.warn(
      "search trace store failed",
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

function buildSearchAgentSystemPrompt(): string {
  return `Ты автономный поисковый агент по полному архиву Telegram-чата.

Твоя задача — не сделать summary последних сообщений, а полноценно расследовать запрос пользователя по всей доступной истории чата.

Инструменты:
- searchMessages: semantic vector search по всему архиву. Он хорошо находит похожие смыслы, но может давать ложные совпадения. Считай его источником кандидатов, а не фактов.
- lexicalSearch: full-text search по прямым словам и фразам. Используй его для проверки, что тема/мем/имя реально встречается в чате, и для поиска точных формулировок.
- inspectContext: показывает соседние сообщения вокруг кандидатов. Это обязательный инструмент для любых важных выводов: контекст часто меняет смысл одиночного сообщения.
- inspectMessages: проверь полный текст конкретных сообщений, если нужно разобрать детали.
- reportStatus: коротко сообщай пользователю, что ты сейчас делаешь. Статус должен быть одной строкой, без markdown.

Как работать:
- Сам решай план. Нет фиксированных раундов.
- Начинай широко: найди разные названия темы через searchMessages и lexicalSearch.
- Потом сузуйся: выбери сильные кандидаты и обязательно вызови inspectContext вокруг них.
- Не используй одиночный vector-hit как доказательство. Если сообщение не содержит тему явно, оно годится только если контекст вокруг него подтверждает связь.
- Отбрасывай кандидаты, где связь с запросом держится только на смутной semantic-похожести.
- Делай несколько поисков, пока не почувствуешь, что evidence достаточно и контекст проверен.
- Если evidence противоречивый или слабый, честно скажи.
- Не привязывайся к авторам или датам, если вопрос не про людей/время.
- Не перечисляй сырой лог. Делай связный рассказ/объяснение.
- В финальном ответе ссылайся только на сообщения, которые ты проверил через inspectContext или inspectMessages.

Follow-up режим:
- Пользователь может написать новый /search ответом на предыдущий поисковый отчёт. Тогда в prompt будет блок "История предыдущих поисков".
- История — это рабочая память диалога поиска: предыдущие запросы, выводы агента и message id, которые использовались как evidence.
- Используй историю, чтобы понять указательные слова и эллипсис: "а она?", "найди ещё", "а до этого", "покажи смешное", "а где он отвечал" и т.п.
- Не воспринимай прошлый ответ как доказательство сам по себе. Это гипотеза и контекст. Если новый ответ опирается на старый тезис, перепроверь важные сообщения через inspectContext или inspectMessages.
- Если follow-up просит расширить/уточнить прошлый поиск, не начинай с нуля смыслово: продолжай от прошлой темы, но запускай инструменты снова и ищи новые или более точные подтверждения.
- Если follow-up меняет тему, явно переключись на новую тему, но учитывай историю только там, где она помогает снять неоднозначность.
- Если пользователь просит "ещё", "другие примеры", "похожие", старайся не повторять те же самые сообщения из предыдущего ответа, кроме случаев когда нужно сослаться на них для контекста.
- Если история противоречит новым найденным данным, честно объясни расхождение и степень уверенности.

Формат финального ответа для Telegram:
- Пиши обычным Markdown без HTML-тегов.
- Первая строка ОБЯЗАТЕЛЬНО должна быть коротким названием найденной темы в одно предложение, без markdown-ссылок. Формат: "Тема: <короткий title>". Не повторяй запрос пользователя дословно.
- После первой строки дай подробный поисковый отчёт с доказательными ссылками.
- Ссылки на сообщения ставь ТОЛЬКО как markdown-ссылки вида [короткое описание](msg:12345).
- Никогда не пиши голые [msg:12345], используй [текст](msg:12345).
- Никогда не пиши списки ссылок внутри одних скобок: [msg:1, msg:2] запрещено.
- Если нужно сослаться на несколько сообщений, пиши отдельные ссылки: [первое](msg:1), [второе](msg:2).
- В конце ответа не добавляй отдельный список найденных сообщений. Вставляй ссылки прямо в рассказ там, где они подтверждают конкретный тезис.
- Не используй Markdown blockquote через ">": бот сам завернёт финальный рассказ в Telegram quote.
- Не используй таблицы.
- Не используй вложенные списки глубже одного уровня.
- Не начинай с фразы "Вот отчёт".
- После title финал должен быть полноценным рассказом по запросу: тезис, контекст, детали, выводы, степень уверенности.`;
}

function buildAskAgentSystemPrompt(): string {
  return `Ты автономный question-answering агент по полному архиву Telegram-чата.

Твоя задача — дать КОНКРЕТНЫЙ КРАТКИЙ ОТВЕТ на вопрос пользователя, опираясь только на проверенные сообщения из истории чата.

Это не общий поиск и не summary. Пользователь ожидает ответ вида: "да/нет/вот кто/вот когда/вот почему", подкреплённый ссылками на сообщения.

Инструменты:
- searchMessages: semantic vector search по всему архиву. Он хорошо находит похожие смыслы, но может давать ложные совпадения. Считай его источником кандидатов, а не фактов.
- lexicalSearch: full-text search по прямым словам и фразам. Используй его для имён, терминов, мемов, точных цитат и проверки явных упоминаний.
- inspectContext: показывает соседние сообщения вокруг кандидатов. Обязателен перед тем, как использовать найденное сообщение как доказательство.
- inspectMessages: получить полный текст конкретных сообщений, если надо проверить формулировку.
- reportStatus: коротко сообщай пользователю, что ты сейчас делаешь. Статус должен быть одной строкой, без markdown.

Как работать:
- Сначала переформулируй вопрос для себя: какой факт надо установить и какие сообщения могут быть доказательством.
- Запускай инструменты заново для каждого вопроса. Не отвечай только по памяти или по прошлому ответу.
- Используй semantic и lexical search по необходимости, но не делай лишних широких раундов, если вопрос простой.
- Перед финальным ответом проверь ключевые сообщения через inspectContext или inspectMessages.
- Ответ должен быть доказательным: каждый нетривиальный факт должен иметь ссылку на конкретное сообщение.
- Если evidence слабый, противоречивый или отсутствует, скажи это прямо. Не додумывай.
- Если вопрос предполагает "да/нет", начни с "Да", "Нет" или "Скорее да/нет", потом дай 1–3 коротких основания со ссылками.
- Если спрашивают "кто/когда/где/что именно", начни с прямого ответа, потом ссылки.
- Если в истории несколько возможных трактовок, коротко перечисли варианты и объясни, какой лучше подтверждён.

Follow-up режим:
- Пользователь может написать /ask ответом на предыдущий /ask или /search. Тогда в prompt будет история цепочки.
- Используй историю для понимания местоимений и эллипсиса: "а он?", "а когда?", "а почему?", "а есть пруф?".
- История не является доказательством. Если ссылаешься на прошлый тезис, заново проверь исходные сообщения инструментами.
- Если пользователь просит "пруф", "докажи", "где это было", сфокусируйся на ссылках и минимальном объяснении.

Формат финального ответа для Telegram:
- Пиши обычным Markdown без HTML-тегов.
- Первая строка ОБЯЗАТЕЛЬНО должна быть коротким прямым ответом в одно предложение, без markdown-ссылок. Формат: "Ответ: <короткий ответ>".
- Не повторяй вопрос пользователя после "Ответ:". Отвечай содержательно: например "Ответ: Милфа — это Гошкова." вместо "Ответ: кто такая милфа?".
- После первой строки дай подробное, но всё ещё компактное обоснование с пруфами и ссылками.
- Краткость важнее полноты: обычно 2–6 предложений или 3–5 коротких буллетов.
- Не начинай с "Вот ответ".
- Не делай длинный поисковый отчёт, хронологию или список всех найденных сообщений.
- Ссылки на сообщения ставь ТОЛЬКО как markdown-ссылки вида [короткое описание](msg:12345).
- Никогда не пиши голые [msg:12345], используй [текст](msg:12345).
- Если нужно несколько доказательств, ставь отдельные ссылки рядом с соответствующими тезисами.
- Не добавляй отдельный список ссылок в конце, если ссылки уже стоят в ответе.
- Не используй Markdown blockquote через ">": бот сам завернёт финальный ответ в Telegram quote.
- Не используй таблицы.
- Если ответа нет, напиши коротко: "Не нашёл надёжного подтверждения" и укажи, что именно проверял.`;
}

function trimEvidencePool(
  byMessage: Map<number, SemanticSearchHit & { matchedQueries: string[] }>,
): void {
  if (byMessage.size <= SEARCH_AGENT_EVIDENCE_POOL_LIMIT) return;
  const keep = new Set(
    Array.from(byMessage.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_AGENT_EVIDENCE_POOL_LIMIT)
      .map((hit) => hit.message.messageId),
  );
  for (const messageId of byMessage.keys()) {
    if (!keep.has(messageId)) byMessage.delete(messageId);
  }
}

function messageUrl(chatId: number, messageId: number): string {
  const channelId = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${channelId}/${messageId}`;
}

function linkifyBareMsgRefs(text: string): string {
  return text
    .replace(/\[((?:\s*msg:\d+\s*,?)+)\]/g, (_match, refs: string) => {
      const ids = refs.match(/\d+/g) ?? [];
      return ids
        .map((id, index) => `[сообщение ${index + 1}](msg:${id})`)
        .join(", ");
    })
    .replace(/(?<!\()\bmsg:(\d+)\b/g, "[сообщение](msg:$1)");
}

function renderNoSearchResults(mode: SearchAgentMode): string {
  const title =
    mode === "ask"
      ? "<b>Ответ:</b> подтверждения нет"
      : "<b>Ничего не найдено</b>";
  return (
    `${title}\n\n` +
    "Ничего похожего не нашёл. Если историю только что импортировали, индекс может ещё строиться."
  );
}

function renderSearchResults(
  chatId: number,
  hits: SemanticSearchHit[],
): string {
  const lines = [`<b>Найденные сообщения</b>`, ""];
  hits.forEach((hit, index) => {
    const m = hit.message;
    const time = new Date(m.ts * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    const sender = escapeHtml(senderDisplayName(m));
    const score = hit.score.toFixed(3);
    const snippet = escapeHtml(hit.snippet).slice(0, 1200);
    lines.push(
      `${index + 1}. <a href="${messageUrl(chatId, m.messageId)}">${time}</a> · ${sender} · ${score}`,
      `<blockquote expandable>${snippet}</blockquote>`,
      "",
    );
  });
  return lines.join("\n").trim();
}

function describeHit(hit: SemanticSearchHit): string {
  const textMatch = hit.snippet.match(/(?:^|\n)Текст:\s*([\s\S]*)$/);
  let text = (textMatch?.[1] ?? hit.message.text ?? hit.snippet)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) text = `[${hit.message.mediaKind ?? "сообщение"}]`;
  if (text.length > 160) text = text.slice(0, 157).trimEnd() + "...";
  return text;
}

function formatMessageForAgent(
  msg: Doc<"chatMessages">,
  maxChars: number,
): string {
  const time = new Date(msg.ts * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const sender = senderDisplayName(msg);
  let text = (msg.text ?? `[${msg.mediaKind ?? "сообщение"}]`)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) text = `[${msg.mediaKind ?? "сообщение"}]`;
  if (text.length > maxChars)
    text = text.slice(0, maxChars - 3).trimEnd() + "...";
  const reply = msg.replyToMessageId ? ` replyTo:${msg.replyToMessageId}` : "";
  return `id:${msg.messageId}${reply} ${time} ${sender}: ${text}`;
}

async function commitSearchResult(
  chatId: number,
  ackId: number | undefined,
  replyTo: number,
  html: string,
  traceUrl?: string,
): Promise<number[]> {
  const keyboard = traceUrl
    ? ([
        [{ text: "Скачать trace .md", url: traceUrl }],
      ] satisfies InlineKeyboard)
    : undefined;
  try {
    return await commitSearchResultHtml(chatId, ackId, replyTo, html, keyboard);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/can't parse entities|Bad Request/i.test(message)) throw err;
    logSearchAgent("telegram.parse_error_retry", {
      chatId,
      replyTo,
      error: message,
    });
    const fallback = telegramHtmlToPlainText(html);
    return await commitSearchResultPlain(
      chatId,
      ackId,
      replyTo,
      fallback,
      keyboard,
    );
  }
}

async function commitSearchResultHtml(
  chatId: number,
  ackId: number | undefined,
  replyTo: number,
  html: string,
  keyboard?: InlineKeyboard,
): Promise<number[]> {
  const chunks = splitTelegramHtmlSafely(html, TG_TEXT_LIMIT);
  const messageIds: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const opts = keyboard ? { inlineKeyboard: keyboard } : {};
    if (i === 0 && ackId !== undefined) {
      await editMessageText(chatId, ackId, chunks[i], {
        parseMode: "HTML",
        ...opts,
      });
      messageIds.push(ackId);
    } else {
      const sent = await sendMessage(chatId, chunks[i], {
        parseMode: "HTML",
        replyToMessageId: i === 0 ? replyTo : undefined,
        ...opts,
      });
      messageIds.push(sent.message_id);
    }
  }
  return messageIds;
}

function splitTelegramHtmlSafely(html: string, maxLen: number): string[] {
  if (html.length <= maxLen) return [html];
  const chunks: string[] = [];

  const append = (part: string) => {
    if (part.length === 0) return;
    const current = chunks[chunks.length - 1] ?? "";
    if (current && current.length + part.length + 1 <= maxLen) {
      chunks[chunks.length - 1] = `${current}\n${part}`;
    } else {
      chunks.push(part);
    }
  };

  const appendPlainSegment = (segment: string) => {
    for (const part of splitTextSafely(segment.trim(), maxLen)) append(part);
  };

  let cursor = 0;
  const quoteRe = /<blockquote expandable>([\s\S]*?)<\/blockquote>/g;
  let match: RegExpExecArray | null;
  while ((match = quoteRe.exec(html)) !== null) {
    appendPlainSegment(html.slice(cursor, match.index));

    const quoteBody = match[1];
    const overhead = "<blockquote expandable></blockquote>".length;
    const quoteChunks = splitTextSafely(
      quoteBody,
      Math.max(500, maxLen - overhead),
    );
    for (const quoteChunk of quoteChunks) {
      append(`<blockquote expandable>${quoteChunk}</blockquote>`);
    }
    cursor = match.index + match[0].length;
  }

  appendPlainSegment(html.slice(cursor));
  return chunks.length > 0 ? chunks : splitTextSafely(html, maxLen);
}

async function commitSearchResultPlain(
  chatId: number,
  ackId: number | undefined,
  replyTo: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<number[]> {
  const chunks = splitTextSafely(text, TG_TEXT_LIMIT);
  const messageIds: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const opts = keyboard ? { inlineKeyboard: keyboard } : {};
    if (i === 0 && ackId !== undefined) {
      await editMessageText(chatId, ackId, chunks[i], opts);
      messageIds.push(ackId);
    } else {
      const sent = await sendMessage(chatId, chunks[i], {
        replyToMessageId: i === 0 ? replyTo : undefined,
        ...opts,
      });
      messageIds.push(sent.message_id);
    }
  }
  return messageIds;
}

function telegramHtmlToPlainText(html: string): string {
  return html
    .replace(
      /<a href="([^"]+)">([\s\S]*?)<\/a>/g,
      (_m, url: string, text: string) => {
        return `${stripHtml(text)} (${url})`;
      },
    )
    .replace(/<\/(?:blockquote|b|i|s|u|code|pre)>/g, "")
    .replace(
      /<(?:blockquote expandable|blockquote|b|i|s|u|code|pre)[^>]*>/g,
      "",
    )
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
