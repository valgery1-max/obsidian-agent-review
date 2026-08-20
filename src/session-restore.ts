import { interruptCodexActivity } from "./activity";
import { findFeedbackTarget, returnFeedbackToDraft } from "./comments";
import { createInlineChanges } from "./inline-changes";
import { activityChangeTurnId, type TurnVersionRecord } from "./turn-outcome";
import type { CodexActivity, ReviewComment, ReviewInlineChange } from "./types";

/**
 * Picking the session back up.
 *
 * A turn that was running when the application closed never reported back, so its comments would
 * otherwise wait for an answer that is not coming: they go back to the queue with the reason.
 * The rest is repair of state written by earlier versions — the entries are keyed, so running it
 * again changes nothing.
 */

export type ActivityMap = Record<string, CodexActivity>;

/** Ends a turn that was interrupted by the application closing, and frees its comments. */
export function finishInterruptedActivity(
  activity: CodexActivity,
  comments: ReviewComment[],
  completedAt: string,
  reason: string,
  commentMessage: string
): boolean {
  if (!interruptCodexActivity(activity, reason, completedAt)) return false;
  for (const id of activity.commentIds) {
    const target = findFeedbackTarget(comments, id);
    const status = target?.followUp?.status ?? target?.comment.status;
    if (status !== "sent") continue;
    returnFeedbackToDraft(comments, id, { kind: "interrupted", message: commentMessage });
  }
  return true;
}

/** Fills in which task and turn answered a comment, for entries written before that was stored. */
export function backfillReviewResponseRoutes(
  activities: ActivityMap,
  comments: ReviewComment[]
): boolean {
  let changed = false;
  for (const activity of Object.values(activities)) {
    if (activity.source !== "review" || !activity.turnId) continue;
    for (const id of activity.commentIds) {
      const target = findFeedbackTarget(comments, id);
      if (!target) continue;
      const response = target.followUp ?? target.comment;
      if (!response.threadId) {
        response.threadId = activity.threadId;
        changed = true;
      }
      if (!response.turnId) {
        response.turnId = activity.turnId;
        changed = true;
      }
      if (!response.provider) {
        response.provider = activity.provider;
        changed = true;
      }
    }
  }
  return changed;
}

export interface FileVersionRecord extends TurnVersionRecord {
  filePath: string;
}

/** The document versions every finished turn should have left behind. */
export function backfillVersionsFromActivities(activities: ActivityMap): FileVersionRecord[] {
  const records: FileVersionRecord[] = [];
  for (const activity of Object.values(activities)) {
    const beforeText = activity.documentTextBefore ?? activity.beforeText;
    const afterText = activity.documentTextAfter ?? activity.afterText;
    if (afterText === undefined || beforeText === afterText) continue;
    const turnId = activityChangeTurnId(activity);
    records.push(
      {
        filePath: activity.filePath,
        text: beforeText,
        source: "before_codex",
        createdAt: activity.startedAt,
        originId: `${turnId}:before`
      },
      {
        filePath: activity.filePath,
        text: afterText,
        source: "codex",
        createdAt: activity.completedAt ?? activity.startedAt,
        originId: `${turnId}:after`
      }
    );
  }
  return records;
}

/**
 * Rebuilds the inline changes of turns that predate them. Turns with a working copy are skipped:
 * their snapshots describe the copy, not the document, and diffing them against it would invent
 * changes that were never made.
 */
export function backfillInlineChangesFromActivities(
  activities: ActivityMap,
  comments: ReviewComment[],
  inlineChanges: ReviewInlineChange[],
  makeId: () => string
): ReviewInlineChange[] {
  const restored: ReviewInlineChange[] = [];
  for (const activity of Object.values(activities)) {
    if (activity.workingCopyPath) continue;
    if (
      activity.afterText === undefined
      || activity.beforeText === activity.afterText
      || activity.commentIds.length === 0
    ) continue;
    if (activity.inlineChangesSettledAt) continue;
    const turnId = activityChangeTurnId(activity);
    if (inlineChanges.some((change) => change.turnId === turnId)) continue;
    if (restored.some((change) => change.turnId === turnId)) continue;
    const activityIds = new Set(activity.commentIds);
    const relatedComments = comments.filter((comment) => {
      const included = activityIds.has(comment.id)
        || comment.followUps.some((followUp) => activityIds.has(followUp.id));
      return included && comment.status !== "accepted" && comment.status !== "resolved";
    });
    restored.push(...createInlineChanges(
      activity.filePath,
      turnId,
      activity.beforeText,
      activity.afterText,
      relatedComments,
      makeId,
      activity.completedAt ?? activity.startedAt
    ));
  }
  return restored;
}
