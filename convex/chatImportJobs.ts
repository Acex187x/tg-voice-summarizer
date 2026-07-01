import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const get = internalQuery({
  args: { id: v.id("chatImportJobs") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const create = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("chatImportJobs", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const patchProgress = internalMutation({
  args: {
    id: v.id("chatImportJobs"),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("downloading"),
        v.literal("importing"),
        v.literal("indexing"),
        v.literal("done"),
        v.literal("error"),
      ),
    ),
    totalMessages: v.optional(v.number()),
    importedMessages: v.optional(v.number()),
    skippedMessages: v.optional(v.number()),
    indexedMessages: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...patch }) => {
    await ctx.db.patch(id, {
      ...patch,
      ...(patch.status === "done" || patch.status === "error"
        ? { finishedAt: Date.now() }
        : {}),
    });
  },
});

export const setStoredDump = internalMutation({
  args: {
    id: v.id("chatImportJobs"),
    storageId: v.optional(v.id("_storage")),
    chunkStorageIds: v.optional(v.array(v.id("_storage"))),
    totalMessages: v.number(),
    nextMessageIndex: v.number(),
    nextChunkIndex: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { id, storageId, chunkStorageIds, totalMessages, nextMessageIndex, nextChunkIndex },
  ) => {
    await ctx.db.patch(id, {
      ...(storageId !== undefined ? { storageId } : {}),
      ...(chunkStorageIds !== undefined ? { chunkStorageIds } : {}),
      totalMessages,
      nextMessageIndex,
      ...(nextChunkIndex !== undefined ? { nextChunkIndex } : {}),
    });
  },
});

export const setNextMessageIndex = internalMutation({
  args: {
    id: v.id("chatImportJobs"),
    nextMessageIndex: v.number(),
    nextChunkIndex: v.optional(v.number()),
    importedMessages: v.number(),
    skippedMessages: v.number(),
  },
  handler: async (
    ctx,
    { id, nextMessageIndex, nextChunkIndex, importedMessages, skippedMessages },
  ) => {
    await ctx.db.patch(id, {
      nextMessageIndex,
      ...(nextChunkIndex !== undefined ? { nextChunkIndex } : {}),
      importedMessages,
      skippedMessages,
    });
  },
});

export const setResolvedChat = internalMutation({
  args: {
    id: v.id("chatImportJobs"),
    chatId: v.number(),
    exportChatId: v.number(),
    exportChatType: v.string(),
    exportChatName: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...patch }) => {
    await ctx.db.patch(id, patch);
  },
});
