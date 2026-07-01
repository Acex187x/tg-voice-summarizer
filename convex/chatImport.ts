import { v } from "convex/values";
import { parser as createJsonParser } from "clarinet";
import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { downloadFile, editMessageText, escapeHtml, getFilePath } from "./telegram";

const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const IMPORT_BATCH_SIZE = 100;
const IMPORT_MESSAGES_PER_ACTION = 500;
const IMPORT_STORAGE_CHUNK_SIZE = 500;

type ExportTextPart = string | { type?: string; text?: string };
type ExportMessage = {
  id?: unknown;
  type?: unknown;
  date_unixtime?: unknown;
  from?: unknown;
  from_id?: unknown;
  text?: unknown;
  reply_to_message_id?: unknown;
  photo?: unknown;
  file?: unknown;
  file_name?: unknown;
  media_type?: unknown;
  mime_type?: unknown;
  sticker_emoji?: unknown;
  duration_seconds?: unknown;
};
type ExportRoot = {
  name?: unknown;
  type?: unknown;
  id?: unknown;
  messages?: unknown;
};

function flattenTelegramExportText(text: unknown): string {
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return "";
  return (text as ExportTextPart[])
    .map((part) => (typeof part === "string" ? part : part.text ?? ""))
    .join("");
}

function parseExportFromId(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^user(\d+)$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function exportChatIdToTelegramChatId(type: string, id: number): number {
  if (type === "private_supergroup" || type === "supergroup" || type === "channel") {
    return Number(`-100${id}`);
  }
  return -Math.abs(id);
}

function detectExportMediaKind(
  message: ExportMessage,
):
  | "text"
  | "photo"
  | "video"
  | "voice"
  | "audio"
  | "video_note"
  | "document"
  | "sticker"
  | "other" {
  if (message.media_type === "sticker" || message.sticker_emoji) return "sticker";
  if (message.photo) return "photo";
  if (message.mime_type === "video/mp4") return "video";
  if (
    typeof message.mime_type === "string" &&
    (message.mime_type.startsWith("audio/") || message.mime_type === "application/ogg")
  ) {
    return "audio";
  }
  if (message.file) return "document";
  const text = flattenTelegramExportText(message.text).trim();
  return text ? "text" : "other";
}

function mediaFallbackText(message: ExportMessage, kind: ReturnType<typeof detectExportMediaKind>): string {
  if (kind === "photo") return "[фото]";
  if (kind === "video") return "[видео]";
  if (kind === "sticker") {
    const emoji = typeof message.sticker_emoji === "string" ? ` ${message.sticker_emoji}` : "";
    return `[стикер${emoji}]`;
  }
  if (kind === "document" || kind === "audio") {
    const name = typeof message.file_name === "string" ? `: ${message.file_name}` : "";
    return `[файл${name}]`;
  }
  return "";
}

function normalizeExportMessage(chatId: number, message: ExportMessage) {
  const messageId = Number(message.id);
  const ts = Number(message.date_unixtime);
  if (!Number.isFinite(messageId) || !Number.isFinite(ts)) return null;
  if (message.type !== "message") return null;

  const mediaKind = detectExportMediaKind(message);
  let text = flattenTelegramExportText(message.text).trim();
  if (!text) text = mediaFallbackText(message, mediaKind);

  const fromId = parseExportFromId(message.from_id);
  const fromName = typeof message.from === "string" ? message.from : undefined;
  const replyTo = Number(message.reply_to_message_id);

  return {
    chatId,
    messageId,
    ts,
    fromId,
    fromFirstName: fromName,
    text: text || undefined,
    mediaKind,
    replyToMessageId: Number.isFinite(replyTo) ? replyTo : undefined,
    importedFromDump: true,
    importSource: "telegram_json_export",
    importedAt: Date.now(),
  };
}

type ImportStats = {
  chatId: number | null;
  exportChatId: number | null;
  exportChatType: string | null;
  exportChatName: string | null;
  totalMessages: number;
  importedMessages: number;
  skippedMessages: number;
};

type PreparedDump = {
  chatId: number;
  exportChatId: number;
  exportChatType: string;
  exportChatName: string | null;
  messages: ExportMessage[];
};
type NormalizedExportMessage = NonNullable<ReturnType<typeof normalizeExportMessage>>;
type PreparedChunkedDump = {
  chatId: number;
  exportChatId: number;
  exportChatType: string;
  exportChatName: string | null;
  totalMessages: number;
  skippedMessages: number;
  chunkStorageIds: Id<"_storage">[];
};

type Frame =
  | {
      type: "object";
      value: Record<string, unknown>;
      key: string | null;
      isMessage: boolean;
    }
  | {
      type: "array";
      value: unknown[] | null;
      isMessagesArray: boolean;
    };

async function importDumpFromTextChunks(
  ctx: { runMutation: any },
  job: Doc<"chatImportJobs">,
  chunks: AsyncIterable<string>,
): Promise<ImportStats> {
  const p = createJsonParser();
  const stack: Frame[] = [];
  const root: Record<string, unknown> = {};
  const batch: ReturnType<typeof normalizeExportMessage>[] = [];
  const stats: ImportStats = {
    chatId: null,
    exportChatId: null,
    exportChatType: null,
    exportChatName: null,
    totalMessages: 0,
    importedMessages: 0,
    skippedMessages: 0,
  };
  let parseError: Error | null = null;
  let resolvedPatched = false;
  let lastProgressEditAt = 0;

  const flush = async () => {
    const rows = batch.splice(0, batch.length);
    for (const row of rows) {
      if (!row) continue;
      await ctx.runMutation(internal.chatMessages.upsert, row);
      stats.importedMessages++;
    }
  };

  const maybeEditProgress = async (force = false) => {
    if (job.ackMessageId === undefined) return;
    const now = Date.now();
    if (!force && now - lastProgressEditAt < 4000) return;
    lastProgressEditAt = now;
    await editMessageText(
      job.requestChatId,
      job.ackMessageId,
      `<b>Импортирую dump…</b>\n` +
        `Прочитано сообщений: ${stats.totalMessages}\n` +
        `Импортировано/обновлено: ${stats.importedMessages}\n` +
        `Пропущено: ${stats.skippedMessages}`,
      { parseMode: "HTML" },
    ).catch(() => {});
  };

  const maybeResolveChat = () => {
    if (stats.chatId !== null) return;
    const exportChatId = Number(root.id);
    const exportChatType = typeof root.type === "string" ? root.type : "unknown";
    if (!Number.isFinite(exportChatId)) return;
    stats.exportChatId = exportChatId;
    stats.exportChatType = exportChatType;
    stats.exportChatName = typeof root.name === "string" ? root.name : null;
    stats.chatId = exportChatIdToTelegramChatId(exportChatType, exportChatId);
  };

  const addValue = (value: unknown) => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    if (parent.type === "object") {
      if (parent.key === null) return;
      parent.value[parent.key] = value;
      if (stack.length === 1) root[parent.key] = value;
      parent.key = null;
      return;
    }
    if (parent.isMessagesArray) return;
    parent.value?.push(value);
  };

  p.onerror = (err: Error) => {
    parseError = err;
    p.resume();
  };
  p.onopenobject = (firstKey: string | undefined) => {
    const parent = stack[stack.length - 1];
    const isMessage =
      parent?.type === "array" &&
      parent.isMessagesArray &&
      !stack.some((f) => f.type === "object" && f.isMessage);
    const obj: Record<string, unknown> = {};
    addValue(obj);
    stack.push({ type: "object", value: obj, key: firstKey ?? null, isMessage });
  };
  p.onkey = (key: string) => {
    const top = stack[stack.length - 1];
    if (top?.type === "object") top.key = key;
  };
  p.onopenarray = () => {
    const parent = stack[stack.length - 1];
    const isMessagesArray =
      parent?.type === "object" && stack.length === 1 && parent.key === "messages";
    if (isMessagesArray) {
      maybeResolveChat();
      if (parent.type === "object") parent.key = null;
      stack.push({ type: "array", value: null, isMessagesArray: true });
      return;
    }
    const arr: unknown[] = [];
    addValue(arr);
    stack.push({ type: "array", value: arr, isMessagesArray: false });
  };
  p.onvalue = (value: unknown) => {
    addValue(value);
  };
  p.oncloseobject = () => {
    const frame = stack.pop();
    if (!frame || frame.type !== "object") return;
    if (frame.isMessage) {
      stats.totalMessages++;
      maybeResolveChat();
      if (stats.chatId === null) {
        stats.skippedMessages++;
        return;
      }
      const normalized = normalizeExportMessage(
        stats.chatId,
        frame.value as ExportMessage,
      );
      if (normalized) {
        batch.push(normalized);
      } else {
        stats.skippedMessages++;
      }
    }
  };
  p.onclosearray = () => {
    stack.pop();
  };

  for await (const chunk of chunks) {
    if (parseError) throw parseError;
    p.write(chunk);
    maybeResolveChat();
    if (!resolvedPatched && stats.chatId !== null) {
      const isPrivateRequest = job.requestChatId === job.requesterId;
      if (!isPrivateRequest && job.requestChatId !== stats.chatId) {
        throw new Error(
          `Dump от другого чата: export maps to ${stats.chatId}, а команда пришла из ${job.requestChatId}.`,
        );
      }
      await ctx.runMutation(internal.chatImportJobs.setResolvedChat, {
        id: job._id,
        chatId: stats.chatId,
        exportChatId: stats.exportChatId ?? 0,
        exportChatType: stats.exportChatType ?? "unknown",
        exportChatName: stats.exportChatName ?? undefined,
      });
      resolvedPatched = true;
    }
    if (batch.length >= IMPORT_BATCH_SIZE) {
      await flush();
      await ctx.runMutation(internal.chatImportJobs.patchProgress, {
        id: job._id,
        status: "importing",
        totalMessages: stats.totalMessages,
        importedMessages: stats.importedMessages,
        skippedMessages: stats.skippedMessages,
      });
      await maybeEditProgress();
    }
  }
  p.close();
  if (parseError) throw parseError;
  await flush();
  if (stats.chatId === null) throw new Error("В dump нет числового id чата.");
  await maybeEditProgress(true);
  return stats;
}

async function prepareDumpInMemory(
  chunks: AsyncIterable<string>,
): Promise<PreparedDump> {
  let text = "";
  for await (const chunk of chunks) {
    text += chunk;
  }
  const root = JSON.parse(text) as ExportRoot;
  if (!root || !Array.isArray(root.messages)) {
    throw new Error("Файл не похож на Telegram JSON export: нет массива messages.");
  }
  const exportChatId = Number(root.id);
  const exportChatType = typeof root.type === "string" ? root.type : "unknown";
  if (!Number.isFinite(exportChatId)) {
    throw new Error("В dump нет числового id чата.");
  }
  return {
    chatId: exportChatIdToTelegramChatId(exportChatType, exportChatId),
    exportChatId,
    exportChatType,
    exportChatName: typeof root.name === "string" ? root.name : null,
    messages: root.messages as ExportMessage[],
  };
}

async function prepareDumpToStorageChunks(
  ctx: { storage: any; runMutation: any },
  job: Doc<"chatImportJobs">,
  chunks: AsyncIterable<string>,
): Promise<PreparedChunkedDump> {
  const p = createJsonParser();
  const stack: Frame[] = [];
  const root: Record<string, unknown> = {};
  const chunk: NormalizedExportMessage[] = [];
  const chunkStorageIds: Id<"_storage">[] = [];
  const stats = {
    chatId: null as number | null,
    exportChatId: null as number | null,
    exportChatType: null as string | null,
    exportChatName: null as string | null,
    totalMessages: 0,
    skippedMessages: 0,
  };
  let parseError: Error | null = null;
  let resolvedPatched = false;
  let lastProgressEditAt = 0;

  const maybeResolveChat = () => {
    if (stats.chatId !== null) return;
    const exportChatId = Number(root.id);
    const exportChatType = typeof root.type === "string" ? root.type : "unknown";
    if (!Number.isFinite(exportChatId)) return;
    stats.exportChatId = exportChatId;
    stats.exportChatType = exportChatType;
    stats.exportChatName = typeof root.name === "string" ? root.name : null;
    stats.chatId = exportChatIdToTelegramChatId(exportChatType, exportChatId);
  };

  const ensureResolvedAndAllowed = async () => {
    maybeResolveChat();
    if (stats.chatId === null || resolvedPatched) return;
    const isPrivateRequest = job.requestChatId === job.requesterId;
    if (!isPrivateRequest && job.requestChatId !== stats.chatId) {
      throw new Error(
        `Dump от другого чата: export maps to ${stats.chatId}, а команда пришла из ${job.requestChatId}.`,
      );
    }
    await ctx.runMutation(internal.chatImportJobs.setResolvedChat, {
      id: job._id,
      chatId: stats.chatId,
      exportChatId: stats.exportChatId ?? 0,
      exportChatType: stats.exportChatType ?? "unknown",
      exportChatName: stats.exportChatName ?? undefined,
    });
    resolvedPatched = true;
  };

  const storeChunk = async () => {
    if (chunk.length === 0) return;
    const rows = chunk.splice(0, IMPORT_STORAGE_CHUNK_SIZE);
    const storageId = await ctx.storage.store(
      new Blob([JSON.stringify(rows)], {
        type: "application/json",
      }),
    );
    chunkStorageIds.push(storageId as Id<"_storage">);
  };

  const maybeEditProgress = async (force = false) => {
    if (job.ackMessageId === undefined) return;
    const now = Date.now();
    if (!force && now - lastProgressEditAt < 4000) return;
    lastProgressEditAt = now;
    await editMessageText(
      job.requestChatId,
      job.ackMessageId,
      `<b>Подготавливаю dump…</b>\n` +
        `Чат: ${escapeHtml(String(stats.exportChatName ?? stats.chatId ?? "определяю"))}\n` +
        `Прочитано сообщений: ${stats.totalMessages}\n` +
        `Подготовлено chunks: ${chunkStorageIds.length}\n` +
        `Пропущено: ${stats.skippedMessages}`,
      { parseMode: "HTML" },
    ).catch(() => {});
  };

  const addValue = (value: unknown) => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    if (parent.type === "object") {
      if (parent.key === null) return;
      parent.value[parent.key] = value;
      if (stack.length === 1) root[parent.key] = value;
      parent.key = null;
      return;
    }
    if (parent.isMessagesArray) return;
    parent.value?.push(value);
  };

  p.onerror = (err: Error) => {
    parseError = err;
    p.resume();
  };
  p.onopenobject = (firstKey: string | undefined) => {
    const parent = stack[stack.length - 1];
    const isMessage =
      parent?.type === "array" &&
      parent.isMessagesArray &&
      !stack.some((f) => f.type === "object" && f.isMessage);
    const obj: Record<string, unknown> = {};
    addValue(obj);
    stack.push({ type: "object", value: obj, key: firstKey ?? null, isMessage });
  };
  p.onkey = (key: string) => {
    const top = stack[stack.length - 1];
    if (top?.type === "object") top.key = key;
  };
  p.onopenarray = () => {
    const parent = stack[stack.length - 1];
    const isMessagesArray =
      parent?.type === "object" && stack.length === 1 && parent.key === "messages";
    if (isMessagesArray) {
      maybeResolveChat();
      if (parent.type === "object") parent.key = null;
      stack.push({ type: "array", value: null, isMessagesArray: true });
      return;
    }
    const arr: unknown[] = [];
    addValue(arr);
    stack.push({ type: "array", value: arr, isMessagesArray: false });
  };
  p.onvalue = (value: unknown) => {
    addValue(value);
  };
  p.oncloseobject = () => {
    const frame = stack.pop();
    if (!frame || frame.type !== "object") return;
    if (frame.isMessage) {
      stats.totalMessages++;
      maybeResolveChat();
      if (stats.chatId === null) {
        stats.skippedMessages++;
        return;
      }
      const normalized = normalizeExportMessage(stats.chatId, frame.value as ExportMessage);
      if (normalized) chunk.push(normalized);
      else stats.skippedMessages++;
    }
  };
  p.onclosearray = () => {
    stack.pop();
  };

  for await (const textChunk of chunks) {
    if (parseError) throw parseError;
    p.write(textChunk);
    await ensureResolvedAndAllowed();
    while (chunk.length >= IMPORT_STORAGE_CHUNK_SIZE) {
      await storeChunk();
      await ctx.runMutation(internal.chatImportJobs.setStoredDump, {
        id: job._id,
        chunkStorageIds,
        totalMessages: stats.totalMessages,
        nextMessageIndex: 0,
        nextChunkIndex: 0,
      });
      await maybeEditProgress();
    }
  }
  p.close();
  if (parseError) throw parseError;
  await ensureResolvedAndAllowed();
  await storeChunk();
  if (stats.chatId === null || stats.exportChatId === null || stats.exportChatType === null) {
    throw new Error("В dump нет числового id чата.");
  }
  await maybeEditProgress(true);
  return {
    chatId: stats.chatId,
    exportChatId: stats.exportChatId,
    exportChatType: stats.exportChatType,
    exportChatName: stats.exportChatName,
    totalMessages: stats.totalMessages,
    skippedMessages: stats.skippedMessages,
    chunkStorageIds,
  };
}

async function* blobByteChunks(blob: Blob): AsyncIterable<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* plainTextChunks(blob: Blob): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of blobByteChunks(blob)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function* gunzipTextChunks(blob: Blob): AsyncIterable<string> {
  const queue: string[] = [];
  let streamError: Error | null = null;
  const decoder = new TextDecoder();
  const gunzip = new Gunzip((data: Uint8Array, final: boolean) => {
    const text = decoder.decode(data, { stream: !final });
    if (text) queue.push(text);
    if (final) {
      const tail = decoder.decode();
      if (tail) queue.push(tail);
    }
  });
  for await (const chunk of blobByteChunks(blob)) {
    try {
      gunzip.push(chunk, false);
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err));
    }
    if (streamError) throw streamError;
    while (queue.length > 0) yield queue.shift()!;
  }
  try {
    gunzip.push(new Uint8Array(), true);
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }
  if (streamError) throw streamError;
  while (queue.length > 0) yield queue.shift()!;
}

async function* zipTextChunks(blob: Blob): AsyncIterable<string> {
  const queue: string[] = [];
  let streamError: Error | null = null;
  let foundJson = false;
  const decoder = new TextDecoder();
  const unzip = new Unzip((file) => {
    const isJson = file.name.toLowerCase().endsWith(".json");
    if (!isJson || foundJson) return;
    foundJson = true;
    file.ondata = (err, data, final) => {
      if (err) {
        streamError = err;
        return;
      }
      const text = decoder.decode(data, { stream: !final });
      if (text) queue.push(text);
      if (final) {
        const tail = decoder.decode();
        if (tail) queue.push(tail);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of blobByteChunks(blob)) {
    unzip.push(chunk, false);
    if (streamError) throw streamError;
    while (queue.length > 0) yield queue.shift()!;
  }
  unzip.push(new Uint8Array(), true);
  if (streamError) throw streamError;
  while (queue.length > 0) yield queue.shift()!;
  if (!foundJson) throw new Error("В ZIP-архиве не найден JSON-файл. Ожидал result.json.");
}

function dumpTextChunks(blob: Blob, fileName?: string, mimeType?: string): AsyncIterable<string> {
  const lower = (fileName ?? "").toLowerCase();
  const mime = (mimeType ?? "").toLowerCase();
  if (lower.endsWith(".zip") || mime.includes("zip")) return zipTextChunks(blob);
  if (lower.endsWith(".json.gz") || mime.includes("gzip")) return gunzipTextChunks(blob);
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
    throw new Error("tar.gz пока не поддерживается потоково. Загрузите ZIP или result.json.gz.");
  }
  return plainTextChunks(blob);
}

export const processChatImportJob = internalAction({
  args: { importJobId: v.id("chatImportJobs") },
  handler: async (ctx, { importJobId }): Promise<void> => {
    const job = (await ctx.runQuery(internal.chatImportJobs.get, {
      id: importJobId,
    })) as Doc<"chatImportJobs"> | null;
    if (!job) return;

    try {
      await ctx.runMutation(internal.chatImportJobs.patchProgress, {
        id: importJobId,
        status: "downloading",
      });
      if (job.ackMessageId !== undefined) {
        await editMessageText(
          job.requestChatId,
          job.ackMessageId,
          "Загружаю dump чата…",
        ).catch(() => {});
      }

      const filePath = await getFilePath(job.fileId);
      const blob = await downloadFile(filePath);
      if (blob.size > MAX_IMPORT_FILE_BYTES) {
        throw new Error(
          `Dump слишком большой (${Math.round(blob.size / 1024 / 1024)} MB). Лимит v1: 50 MB.`,
        );
      }
      const prepared = await prepareDumpToStorageChunks(
        ctx,
        job,
        dumpTextChunks(blob, job.fileName, job.fileMimeType),
      );
      const isPrivateRequest = job.requestChatId === job.requesterId;
      if (!isPrivateRequest && job.requestChatId !== prepared.chatId) {
        throw new Error(
          `Dump от другого чата: export maps to ${prepared.chatId}, а команда пришла из ${job.requestChatId}.`,
        );
      }
      await ctx.runMutation(internal.chatImportJobs.setResolvedChat, {
        id: importJobId,
        chatId: prepared.chatId,
        exportChatId: prepared.exportChatId,
        exportChatType: prepared.exportChatType,
        exportChatName: prepared.exportChatName ?? undefined,
      });
      await ctx.runMutation(internal.chatImportJobs.setStoredDump, {
        id: importJobId,
        chunkStorageIds: prepared.chunkStorageIds,
        totalMessages: prepared.totalMessages,
        nextMessageIndex: 0,
        nextChunkIndex: 0,
      });
      await ctx.runMutation(internal.chatImportJobs.patchProgress, {
        id: importJobId,
        status: "importing",
        totalMessages: prepared.totalMessages,
        skippedMessages: prepared.skippedMessages,
      });
      if (job.ackMessageId !== undefined) {
        await editMessageText(
          job.requestChatId,
          job.ackMessageId,
          `<b>Импортирую dump…</b>\n` +
            `Чат: ${escapeHtml(String(prepared.exportChatName ?? prepared.chatId))}\n` +
            `Всего сообщений: ${prepared.totalMessages}\n` +
            `Chunks: ${prepared.chunkStorageIds.length}\n` +
            `Импортировано/обновлено: 0\n` +
            `Пропущено: ${prepared.skippedMessages}`,
          { parseMode: "HTML" },
        ).catch(() => {});
      }
      await ctx.scheduler.runAfter(0, internal.chatImport.processChatImportBatch, {
        importJobId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.chatImportJobs.patchProgress, {
        id: importJobId,
        status: "error",
        error: message,
      });
      if (job.ackMessageId !== undefined) {
        await editMessageText(
          job.requestChatId,
          job.ackMessageId,
          `Не удалось импортировать dump: ${escapeHtml(message)}`,
          { parseMode: "HTML" },
        ).catch(() => {});
      }
    }
  },
});

export const processChatImportBatch = internalAction({
  args: { importJobId: v.id("chatImportJobs") },
  handler: async (ctx, { importJobId }): Promise<void> => {
    const job = (await ctx.runQuery(internal.chatImportJobs.get, {
      id: importJobId,
    })) as Doc<"chatImportJobs"> | null;
    if (!job || job.chatId === undefined) return;
    try {
      const chunkStorageIds = job.chunkStorageIds;
      let imported = job.importedMessages ?? 0;
      let skipped = job.skippedMessages ?? 0;

      if (chunkStorageIds && chunkStorageIds.length > 0) {
        const chunkIndex = job.nextChunkIndex ?? 0;
        const chunkStorageId = chunkStorageIds[chunkIndex];
        if (!chunkStorageId) {
          await finishImportJob(ctx, job, importJobId, imported, skipped, job.totalMessages ?? imported + skipped);
          return;
        }

        const blob = await ctx.storage.get(chunkStorageId);
        if (!blob) throw new Error(`Chunk ${chunkIndex + 1} не найден в storage.`);
        const messages = JSON.parse(await blob.text()) as NormalizedExportMessage[];
        for (const normalized of messages) {
          await ctx.runMutation(internal.chatMessages.upsert, normalized);
          imported++;
        }

        const nextChunkIndex = chunkIndex + 1;
        await ctx.runMutation(internal.chatImportJobs.setNextMessageIndex, {
          id: importJobId,
          nextMessageIndex: imported,
          nextChunkIndex,
          importedMessages: imported,
          skippedMessages: skipped,
        });
        if (job.ackMessageId !== undefined) {
          await editMessageText(
            job.requestChatId,
            job.ackMessageId,
            `<b>Импортирую dump…</b>\n` +
              `Чат: ${escapeHtml(String(job.exportChatName ?? job.chatId))}\n` +
              `Chunks: ${nextChunkIndex}/${chunkStorageIds.length}\n` +
              `Сообщений обработано: ${imported + skipped}/${job.totalMessages ?? "?"}\n` +
              `Импортировано/обновлено: ${imported}\n` +
              `Пропущено: ${skipped}`,
            { parseMode: "HTML" },
          ).catch(() => {});
        }

        if (nextChunkIndex < chunkStorageIds.length) {
          await ctx.scheduler.runAfter(0, internal.chatImport.processChatImportBatch, {
            importJobId,
          });
          return;
        }
        await finishImportJob(ctx, job, importJobId, imported, skipped, job.totalMessages ?? imported + skipped);
        return;
      }

      if (!job.storageId) throw new Error("Сохранённый dump не найден в storage.");
      const blob = await ctx.storage.get(job.storageId);
      if (!blob) throw new Error("Сохранённый dump не найден в storage.");
      const messages = JSON.parse(await blob.text()) as ExportMessage[];
      const start = job.nextMessageIndex ?? 0;
      const end = Math.min(start + IMPORT_MESSAGES_PER_ACTION, messages.length);

      for (let i = start; i < end; i++) {
        const normalized = normalizeExportMessage(job.chatId, messages[i]);
        if (!normalized) skipped++;
        else {
          await ctx.runMutation(internal.chatMessages.upsert, normalized);
          imported++;
        }
      }

      await ctx.runMutation(internal.chatImportJobs.setNextMessageIndex, {
        id: importJobId,
        nextMessageIndex: end,
        importedMessages: imported,
        skippedMessages: skipped,
      });
      if (end < messages.length) {
        await ctx.scheduler.runAfter(0, internal.chatImport.processChatImportBatch, {
          importJobId,
        });
        return;
      }
      await finishImportJob(ctx, job, importJobId, imported, skipped, messages.length);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.chatImportJobs.patchProgress, {
        id: importJobId,
        status: "error",
        error: message,
      });
      if (job.ackMessageId !== undefined) {
        await editMessageText(
          job.requestChatId,
          job.ackMessageId,
          `Не удалось импортировать dump: ${escapeHtml(message)}`,
          { parseMode: "HTML" },
        ).catch(() => {});
      }
    }
  },
});

async function finishImportJob(
  ctx: { runMutation: any; scheduler: any },
  job: Doc<"chatImportJobs">,
  importJobId: Doc<"chatImportJobs">["_id"],
  imported: number,
  skipped: number,
  totalMessages: number,
): Promise<void> {
  await ctx.runMutation(internal.chatImportJobs.patchProgress, {
    id: importJobId,
    status: "indexing",
    totalMessages,
    importedMessages: imported,
    skippedMessages: skipped,
  });
  await ctx.scheduler.runAfter(0, internal.vectorSearch.backfillMessageEmbeddings, {
    chatId: job.chatId!,
  });
  await ctx.runMutation(internal.chatImportJobs.patchProgress, {
    id: importJobId,
    status: "done",
    indexedMessages: 0,
  });
  if (job.ackMessageId !== undefined) {
    await editMessageText(
      job.requestChatId,
      job.ackMessageId,
      `<b>Dump импортирован</b>\n` +
        `Чат: ${escapeHtml(String(job.exportChatName ?? job.chatId))}\n` +
        `Сообщений в файле: ${totalMessages}\n` +
        `Импортировано/обновлено: ${imported}\n` +
        `Пропущено: ${skipped}\n\n` +
        `Индексация запущена в фоне. /search начнёт находить историю по мере готовности.`,
      { parseMode: "HTML" },
    ).catch(() => {});
  }
}
