import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { ALERT_WINDOW_MS, type FailureKind, shouldAlert } from "./failures";

// Counts a failure under its throttling key and decides — atomically, so
// a burst of parallel failures yields one DM — whether the admin should
// hear about it now.
export const noteFailure = internalMutation({
  args: {
    key: v.string(),
    kind: v.union(
      v.literal("actionable"),
      v.literal("transient"),
      v.literal("telegram"),
      v.literal("unknown"),
    ),
  },
  handler: async (
    ctx,
    { key, kind },
  ): Promise<{ notify: boolean; count: number }> => {
    const now = Date.now();
    const row = await ctx.db
      .query("adminAlerts")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row) {
      const notify = shouldAlert(kind as FailureKind, 1, undefined, now);
      await ctx.db.insert("adminAlerts", {
        key,
        windowStart: now,
        count: 1,
        lastSentAt: notify ? now : undefined,
      });
      return { notify, count: 1 };
    }
    const fresh = now - row.windowStart > ALERT_WINDOW_MS;
    const count = fresh ? 1 : row.count + 1;
    const notify = shouldAlert(kind as FailureKind, count, row.lastSentAt, now);
    await ctx.db.patch(row._id, {
      windowStart: fresh ? now : row.windowStart,
      count,
      lastSentAt: notify ? now : row.lastSentAt,
    });
    return { notify, count };
  },
});
