import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { editMessageText, escapeHtml, sendMessage } from "./telegram";

const MESSAGE_BATCH_SIZE = 500;
const EMBEDDING_BATCH_SIZE = 100;

function pct(n: number, d: number): string {
  if (d <= 0) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmtDateMs(ms: number | null): string {
  if (ms === null) return "n/a";
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function fmtDateSec(sec: number | null): string {
  if (sec === null) return "n/a";
  return new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export const processIndexStats = internalAction({
  args: {
    chatId: v.number(),
    requestMessageId: v.number(),
    ackMessageId: v.optional(v.number()),
    forceRebuild: v.optional(v.boolean()),
  },
  handler: async (ctx, { chatId, ackMessageId, forceRebuild }): Promise<void> => {
    const existing = (await ctx.runQuery(internal.chatIndexStats.get, {
      chatId,
    })) as Doc<"chatIndexStats"> | null;
    if (existing && !forceRebuild) {
      await sendStats(ctx, chatId, ackMessageId, existing, false);
      return;
    }
    if (!existing && !forceRebuild) {
      const html =
        `<b>Index stats</b>\n` +
        `Чат: <code>${chatId}</code>\n\n` +
        `Счётчики ещё не инициализированы для этого чата.\n` +
        `Запусти один раз <code>/indexstats rebuild</code>; после этого обычный ` +
        `<code>/indexstats</code> будет быстрым и будет читать сохранённые счётчики.`;
      if (ackMessageId !== undefined) {
        await editMessageText(chatId, ackMessageId, html, { parseMode: "HTML" });
      } else {
        await sendMessage(chatId, html, { parseMode: "HTML" });
      }
      return;
    }

    if (ackMessageId !== undefined) {
      await editMessageText(
        chatId,
        ackMessageId,
        "<i>Первый запуск: пересобираю index stats…</i>",
        { parseMode: "HTML" },
      ).catch(() => {});
    }

    const rebuilt = await rebuildStats(ctx, chatId, ackMessageId);
    await ctx.runMutation(internal.chatIndexStats.replace, rebuilt);
    const row = (await ctx.runQuery(internal.chatIndexStats.get, {
      chatId,
    })) as Doc<"chatIndexStats">;
    await sendStats(ctx, chatId, ackMessageId, row, true);
  },
});

async function rebuildStats(
  ctx: { runQuery: any },
  chatId: number,
  ackMessageId: number | undefined,
) {
  let messageTotal = 0;
  let positiveMessages = 0;
  let importedMessages = 0;
  let liveMessages = 0;
  let nonPositiveMessages = 0;
  let minMessageId: number | undefined;
  let maxMessageId: number | undefined;
  let minPositiveMessageId: number | undefined;
  let maxPositiveMessageId: number | undefined;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let firstDateMessageId: number | undefined;
  let lastDateMessageId: number | undefined;
  let afterMessageId: number | undefined;

  while (true) {
    const batch = (await ctx.runQuery(internal.chatMessages.statsBatchByMessageId, {
      chatId,
      afterMessageId,
      limit: MESSAGE_BATCH_SIZE,
    })) as Doc<"chatMessages">[];
    if (batch.length === 0) break;
    for (const row of batch) {
      messageTotal++;
      if (row.importedFromDump) importedMessages++;
      else liveMessages++;
      minMessageId = minMessageId === undefined ? row.messageId : Math.min(minMessageId, row.messageId);
      maxMessageId = maxMessageId === undefined ? row.messageId : Math.max(maxMessageId, row.messageId);
      if (row.messageId > 0) {
        positiveMessages++;
        minPositiveMessageId =
          minPositiveMessageId === undefined
            ? row.messageId
            : Math.min(minPositiveMessageId, row.messageId);
        maxPositiveMessageId =
          maxPositiveMessageId === undefined
            ? row.messageId
            : Math.max(maxPositiveMessageId, row.messageId);
      } else {
        nonPositiveMessages++;
      }
      if (firstTs === undefined || row.ts < firstTs) {
        firstTs = row.ts;
        firstDateMessageId = row.messageId;
      }
      if (lastTs === undefined || row.ts > lastTs) {
        lastTs = row.ts;
        lastDateMessageId = row.messageId;
      }
    }
    afterMessageId = batch[batch.length - 1].messageId;
    if (ackMessageId !== undefined && messageTotal % 5000 === 0) {
      await editMessageText(chatId, ackMessageId, `<i>Считаю сообщения: ${messageTotal}</i>`, {
        parseMode: "HTML",
      }).catch(() => {});
    }
    if (batch.length < MESSAGE_BATCH_SIZE) break;
  }

  let embeddingChunks = 0;
  const embedded = new Set<number>();
  let minEmbeddedMessageId: number | undefined;
  let maxEmbeddedMessageId: number | undefined;
  let lastEmbeddedAt: number | undefined;
  let embeddingModel: string | undefined;
  let embeddingVersion: number | undefined;
  let embeddingDimensions: number | undefined;
  afterMessageId = undefined;

  while (true) {
    const batch = (await ctx.runQuery(
      internal.messageEmbeddings.statsBatchByMessageId,
      { chatId, afterMessageId, limit: EMBEDDING_BATCH_SIZE },
    )) as Doc<"messageEmbeddings">[];
    if (batch.length === 0) break;
    for (const row of batch) {
      embeddingChunks++;
      embedded.add(row.messageId);
      minEmbeddedMessageId =
        minEmbeddedMessageId === undefined
          ? row.messageId
          : Math.min(minEmbeddedMessageId, row.messageId);
      maxEmbeddedMessageId =
        maxEmbeddedMessageId === undefined
          ? row.messageId
          : Math.max(maxEmbeddedMessageId, row.messageId);
      if (lastEmbeddedAt === undefined || row.embeddedAt > lastEmbeddedAt) {
        lastEmbeddedAt = row.embeddedAt;
        embeddingModel = row.embeddingModel;
        embeddingVersion = row.embeddingVersion;
        embeddingDimensions = row.embeddingDimensions;
      }
    }
    afterMessageId = batch[batch.length - 1].messageId;
    if (batch.length < EMBEDDING_BATCH_SIZE) break;
  }

  return {
    chatId,
    messageTotal,
    positiveMessages,
    importedMessages,
    liveMessages,
    nonPositiveMessages,
    minMessageId,
    maxMessageId,
    minPositiveMessageId,
    maxPositiveMessageId,
    firstTs,
    lastTs,
    firstDateMessageId,
    lastDateMessageId,
    embeddedMessages: embedded.size,
    embeddingChunks,
    minEmbeddedMessageId,
    maxEmbeddedMessageId,
    lastEmbeddedAt,
    embeddingModel,
    embeddingVersion,
    embeddingDimensions,
  };
}

async function sendStats(
  ctx: { runMutation?: any },
  chatId: number,
  ackMessageId: number | undefined,
  stats: Doc<"chatIndexStats">,
  rebuilt: boolean,
): Promise<void> {
  const latestId = stats.maxPositiveMessageId ?? 0;
  const missingByLatest = latestId > 0 ? Math.max(0, latestId - stats.positiveMessages) : 0;
  const storedCoverage = pct(stats.positiveMessages, latestId);
  const vectorCoverageAll = pct(stats.embeddedMessages, stats.messageTotal);
  const vectorCoveragePositive = pct(stats.embeddedMessages, stats.positiveMessages);

  const html =
      `<b>Index stats</b>\n` +
      `Чат: <code>${chatId}</code>\n\n` +
      `<b>Сообщения в БД</b>\n` +
      `Всего строк: <code>${stats.messageTotal}</code>\n` +
      `Положительных message_id: <code>${stats.positiveMessages}</code>\n` +
      `Неположительных/служебных id: <code>${stats.nonPositiveMessages}</code>\n` +
      `Из dump: <code>${stats.importedMessages}</code>\n` +
      `Live от бота: <code>${stats.liveMessages}</code>\n` +
      `Диапазон всех message_id: <code>${stats.minMessageId ?? "n/a"}..${stats.maxMessageId ?? "n/a"}</code>\n` +
      `Диапазон положительных id: <code>${stats.minPositiveMessageId ?? "n/a"}..${stats.maxPositiveMessageId ?? "n/a"}</code>\n` +
      `Покрытие по latest id: <code>${stats.positiveMessages}/${latestId}</code> (${storedCoverage})\n` +
      `Недостаёт по latest id: <code>${missingByLatest}</code>\n` +
      `Период по ts: <code>${fmtDateSec(stats.firstTs ?? null)} — ${fmtDateSec(stats.lastTs ?? null)}</code>\n` +
      `Первое/последнее по дате message_id: <code>${stats.firstDateMessageId ?? "n/a"}..${stats.lastDateMessageId ?? "n/a"}</code>\n\n` +
      `<b>Векторный индекс</b>\n` +
      `Векторизировано сообщений: <code>${stats.embeddedMessages}</code>\n` +
      `Embedding chunks: <code>${stats.embeddingChunks}</code>\n` +
      `Покрытие от всех строк: <code>${vectorCoverageAll}</code>\n` +
      `Покрытие от положительных id: <code>${vectorCoveragePositive}</code>\n` +
      `Диапазон embedded message_id: <code>${stats.minEmbeddedMessageId ?? "n/a"}..${stats.maxEmbeddedMessageId ?? "n/a"}</code>\n` +
      `Последняя индексация: <code>${fmtDateMs(stats.lastEmbeddedAt ?? null)}</code>\n` +
      `Модель: <code>${escapeHtml(
        stats.embeddingModel
          ? `${stats.embeddingModel} v${stats.embeddingVersion} / ${stats.embeddingDimensions}d`
          : "n/a",
      )}</code>\n\n` +
      `<i>${rebuilt ? "Статистика пересобрана и сохранена." : "Статистика прочитана из сохранённых счётчиков."} ` +
      `Дыры по id/media breakdown тут намеренно не считаются.</i>`;

    if (ackMessageId !== undefined) {
      await editMessageText(chatId, ackMessageId, html, { parseMode: "HTML" });
    } else {
      await sendMessage(chatId, html, { parseMode: "HTML" });
    }
}
