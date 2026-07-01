import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

export const get = internalQuery({
  args: { id: v.id("searchRequests") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const findByAckMessage = internalQuery({
  args: { chatId: v.number(), ackMessageId: v.number() },
  handler: async (ctx, { chatId, ackMessageId }) => {
    return await ctx.db
      .query("searchRequests")
      .withIndex("by_chat_ack", (q) =>
        q.eq("chatId", chatId).eq("ackMessageId", ackMessageId),
      )
      .unique();
  },
});

export const findByOutputMessage = internalQuery({
  args: { chatId: v.number(), messageId: v.number() },
  handler: async (ctx, { chatId, messageId }) => {
    const byAck = await ctx.db
      .query("searchRequests")
      .withIndex("by_chat_ack", (q) =>
        q.eq("chatId", chatId).eq("ackMessageId", messageId),
      )
      .unique();
    if (byAck) return byAck;

    const recent = await ctx.db
      .query("searchRequests")
      .withIndex("by_chat_created", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(100);
    return (
      recent.find((row) => row.outputMessageIds?.includes(messageId)) ?? null
    );
  },
});

export const create = internalMutation({
  args: {
    chatId: v.number(),
    requesterId: v.number(),
    requestMessageId: v.number(),
    ackMessageId: v.optional(v.number()),
    parentSearchRequestId: v.optional(v.id("searchRequests")),
    mode: v.optional(v.union(v.literal("search"), v.literal("ask"))),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("searchRequests", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const setStatus = internalMutation({
  args: {
    id: v.id("searchRequests"),
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
  },
  handler: async (
    ctx,
    {
      id,
      status,
      resultMessageIds,
      outputMessageIds,
      resultText,
      traceStorageId,
      traceUrl,
      error,
    },
  ) => {
    await ctx.db.patch(id, {
      status,
      ...(resultMessageIds !== undefined ? { resultMessageIds } : {}),
      ...(outputMessageIds !== undefined ? { outputMessageIds } : {}),
      ...(resultText !== undefined ? { resultText } : {}),
      ...(traceStorageId !== undefined
        ? { traceStorageId: traceStorageId as Id<"_storage"> }
        : {}),
      ...(traceUrl !== undefined ? { traceUrl } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(status === "done" || status === "error"
        ? { finishedAt: Date.now() }
        : {}),
    });
  },
});
