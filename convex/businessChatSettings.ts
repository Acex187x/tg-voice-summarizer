import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Per-conversation settings for Telegram Business mode. Rows are
// materialized on first voice sighting (upsertSeen) so the DM /settings
// panel has a conversation list to render toggles for.

export const get = internalQuery({
  args: { connectionId: v.string(), peerChatId: v.number() },
  handler: async (ctx, { connectionId, peerChatId }) => {
    return await ctx.db
      .query("businessChatSettings")
      .withIndex("by_connection_peer", (q) =>
        q.eq("connectionId", connectionId).eq("peerChatId", peerChatId),
      )
      .unique();
  },
});

// Most recently active conversations first — that's the order the DM
// settings panel lists them in.
export const listByConnection = internalQuery({
  args: { connectionId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { connectionId, limit }) => {
    return await ctx.db
      .query("businessChatSettings")
      .withIndex("by_connection_seen", (q) =>
        q.eq("connectionId", connectionId),
      )
      .order("desc")
      .take(limit ?? 20);
  },
});

export const upsertSeen = internalMutation({
  args: {
    connectionId: v.string(),
    peerChatId: v.number(),
    peerName: v.optional(v.string()),
  },
  handler: async (ctx, { connectionId, peerChatId, peerName }) => {
    const existing = await ctx.db
      .query("businessChatSettings")
      .withIndex("by_connection_peer", (q) =>
        q.eq("connectionId", connectionId).eq("peerChatId", peerChatId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastSeenAt: Date.now(),
        ...(peerName ? { peerName } : {}),
      });
      return;
    }
    await ctx.db.insert("businessChatSettings", {
      connectionId,
      peerChatId,
      peerName,
      autoSendTranscript: false,
      lastSeenAt: Date.now(),
    });
  },
});

// Flips autoSendTranscript for a conversation. Returns the new value.
export const toggleAutoSend = internalMutation({
  args: { connectionId: v.string(), peerChatId: v.number() },
  handler: async (ctx, { connectionId, peerChatId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("businessChatSettings")
      .withIndex("by_connection_peer", (q) =>
        q.eq("connectionId", connectionId).eq("peerChatId", peerChatId),
      )
      .unique();
    if (existing) {
      const next = existing.autoSendTranscript !== true;
      await ctx.db.patch(existing._id, { autoSendTranscript: next });
      return next;
    }
    await ctx.db.insert("businessChatSettings", {
      connectionId,
      peerChatId,
      autoSendTranscript: true,
      lastSeenAt: Date.now(),
    });
    return true;
  },
});
