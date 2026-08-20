import { agentName } from "./agent-client";
import {
  createConversationReviewFromEdits,
  createInlineChangesFromEdits,
  mergeAgentEdits,
  type AgentEditOutcome,
  type AgentMergeResult,
  type DocumentChange
} from "./agent-merge";
import { createAnchor, relocateComment } from "./anchors";
import {
  applyFeedbackResult,
  findFeedbackTarget,
  markFeedbackNeedsAttention,
  markFeedbackUnappliedChanges,
  returnFeedbackToDraft,
  reviewTurnNeedsAttention
} from "./comments";
import { reviewChatCompletionMessage } from "./chat-privacy";
import { commentOwnerResolver, createInlineChanges, refreshInlineChangeLocations } from "./inline-changes";
import { parseReviewResults } from "./review-results";
import type {
  CodexActivity,
  ReviewComment,
  ReviewInlineChange,
  ReviewVersionSource
} from "./types";

/**
 * What a finished agent turn means for Agent Review.
 *
 * Everything here is a decision: which edits belong to the agent, where they go in the document
 * the user has now, which of them cannot be transferred, what happens to every comment of the
 * batch, what is worth keeping as a version and what the user is told. None of it touches the
 * editor, the file system or the interface — the host reads the two texts, calls this, and then
 * carries out what came back.
 */

export interface TurnOutcomeInput {
  activity: CodexActivity;
  /** Turn status reported by the agent runtime. */
  status: string;
  comments: ReviewComment[];
  inlineChanges: ReviewInlineChange[];
  /** The live document as it is now, or null when it is no longer available. */
  documentText: string | null;
  /** The working copy as the agent left it. */
  agentText: string | undefined;
  makeId: () => string;
  now: string;
}

export interface TurnVersionRecord {
  text: string;
  source: ReviewVersionSource;
  createdAt: string;
  originId: string;
}

export interface TurnOutcome {
  /** Edits to apply to the live document, in ascending order and non-overlapping. */
  documentChanges: DocumentChange[];
  /** The document with those edits applied, for hosts that write whole documents. */
  documentText: string | null;
  inlineChanges: ReviewInlineChange[];
  newComments: ReviewComment[];
  versions: TurnVersionRecord[];
  notices: string[];
  merged: AgentMergeResult | null;
}

function unappliedEditMessage(outcome: AgentEditOutcome): string {
  return outcome === "stale"
    ? "Правку агента не удалось перенести: этот фрагмент удалён из документа. Текст агента не восстанавливался."
    : "Правку агента не удалось перенести: этот фрагмент изменился в документе, пока агент работал. Ваш текст сохранён.";
}

export function activityChangeTurnId(activity: CodexActivity): string {
  return activity.turnId || `${activity.filePath}:${activity.completedAt ?? activity.startedAt}`;
}

export function resolveTurnOutcome(input: TurnOutcomeInput): TurnOutcome {
  const { activity, status, comments, documentText, agentText, makeId, now } = input;
  const filePath = activity.filePath;

  activity.status = status === "completed"
    ? "completed"
    : status === "interrupted" ? "interrupted" : "failed";
  activity.completedAt = now;
  activity.afterText = agentText;

  const merged = activity.workingCopyPath && agentText !== undefined && documentText !== null
    ? mergeAgentEdits(activity.beforeText, agentText, documentText)
    : null;
  if (merged && documentText !== null) {
    activity.documentTextBefore = documentText;
    activity.documentTextAfter = merged.text;
    activity.skippedEditCount = merged.skipped.length;
  }

  const versions: TurnVersionRecord[] = [];
  const documentBefore = activity.documentTextBefore ?? activity.beforeText;
  const documentAfter = activity.documentTextAfter ?? activity.afterText;
  if (documentAfter !== undefined && documentBefore !== documentAfter) {
    const turnId = activityChangeTurnId(activity);
    versions.push(
      {
        text: documentBefore,
        source: "before_codex",
        createdAt: activity.startedAt,
        originId: `${turnId}:before`
      },
      {
        text: documentAfter,
        source: "codex",
        createdAt: activity.completedAt,
        originId: `${turnId}:after`
      }
    );
  }

  const newComments: ReviewComment[] = [];
  const changedCommentIds = new Set<string>();
  const unappliedCommentIds = new Map<string, AgentEditOutcome>();
  let inlineChanges = input.inlineChanges;

  if (activity.source === "conversation" && status === "completed" && merged && merged.applied.length > 0) {
    const generated = createConversationReviewFromEdits(
      filePath,
      activity.turnId,
      merged.text,
      merged.applied,
      activity.requestText ?? "",
      parseReviewResults(activity.finalMessage).visibleText,
      makeId,
      activity.completedAt
    );
    for (const comment of generated.comments) {
      comment.threadId = activity.threadId;
      comment.turnId = activity.turnId;
      comment.provider = activity.provider;
    }
    newComments.push(...generated.comments);
    inlineChanges = refreshInlineChangeLocations(merged.text, [
      ...inlineChanges.filter((change) => change.turnId !== activity.turnId),
      ...generated.changes
    ]);
  } else if (activity.commentIds.length > 0 && (merged || activity.afterText !== undefined)) {
    const activityIds = new Set(activity.commentIds);
    const relatedComments = comments.filter((comment) =>
      activityIds.has(comment.id) || comment.followUps.some((followUp) => activityIds.has(followUp.id))
    );
    const newChanges = merged
      ? createInlineChangesFromEdits(
          filePath,
          activity.turnId,
          activity.beforeText,
          merged.text,
          merged.applied,
          relatedComments,
          makeId,
          activity.completedAt
        )
      : createInlineChanges(
          filePath,
          activity.turnId,
          activity.beforeText,
          activity.afterText!,
          relatedComments,
          makeId,
          activity.completedAt
        );
    for (const change of newChanges) changedCommentIds.add(change.commentId);
    if (merged) {
      const resolveOwner = commentOwnerResolver(activity.beforeText, relatedComments);
      for (const edit of merged.skipped) {
        const owner = resolveOwner(edit.baseFrom, edit.baseTo);
        if (owner) unappliedCommentIds.set(owner.id, edit.outcome);
      }
    }
    const replacedCommentIds = new Set(newChanges.map((change) => change.commentId));
    const retained = inlineChanges.filter((change) =>
      change.turnId !== activity.turnId && !replacedCommentIds.has(change.commentId)
    );
    inlineChanges = refreshInlineChangeLocations(
      merged?.text ?? activity.afterText!,
      [...retained, ...newChanges]
    );
  }

  const allComments = [...comments, ...newComments];
  applyAgentResponses(input, allComments, changedCommentIds);

  for (const [commentId, outcome] of unappliedCommentIds) {
    const target = findFeedbackTarget(allComments, commentId);
    const commentStatus = target?.followUp?.status ?? target?.comment.status;
    if (!target || commentStatus === "draft" || commentStatus === "sent") continue;
    markFeedbackUnappliedChanges(allComments, commentId, {
      kind: "conflicting_changes",
      message: unappliedEditMessage(outcome)
    });
  }

  const notices: string[] = [];
  if (merged && merged.skipped.length > 0) {
    notices.push(merged.applied.length > 0
      ? `Часть правок ${agentName(activity.provider)} не перенесена: изменённые фрагменты уже правились вручную`
      : `Правки ${agentName(activity.provider)} не перенесены: изменённые фрагменты уже правились вручную`);
  }

  activity.finalMessage = activity.source === "review"
    ? reviewChatCompletionMessage(
        activity.finalMessage,
        reviewTurnNeedsAttention(allComments, filePath, activity.turnId)
      )
    : parseReviewResults(activity.finalMessage).visibleText;

  return {
    documentChanges: merged?.changes ?? [],
    documentText: merged ? merged.text : null,
    inlineChanges,
    newComments,
    versions,
    notices,
    merged
  };
}

/** Turns the per-comment results of the turn into comment statuses, answers and issues. */
function applyAgentResponses(
  input: TurnOutcomeInput,
  comments: ReviewComment[],
  changedCommentIds: Set<string>
): void {
  const { activity, status, now } = input;
  const parsed = parseReviewResults(activity.finalMessage);
  const expectedIds = activity.followUpId ? [activity.followUpId] : activity.commentIds;
  const expectedSet = new Set(expectedIds);
  const appliedIds = new Set<string>();

  for (const result of parsed.comments) {
    let resultId = result.id;
    if (!expectedSet.has(resultId) && activity.followUpId) {
      const followUpTarget = findFeedbackTarget(comments, activity.followUpId);
      if (followUpTarget?.comment.id === resultId) resultId = activity.followUpId;
    }
    if (!expectedSet.has(resultId)) continue;
    const normalizedResult = resultId === result.id ? result : { ...result, id: resultId };
    if (applyFeedbackResult(comments, normalizedResult, now)) appliedIds.add(resultId);
  }

  const missingIds = expectedIds.filter((id) => !appliedIds.has(id));
  if (status === "completed" && missingIds.length === 1 && parsed.visibleText.trim()) {
    applyFeedbackResult(comments, {
      id: missingIds[0],
      status: "addressed",
      response: parsed.visibleText.trim()
    }, now);
    appliedIds.add(missingIds[0]);
  }

  for (const id of expectedIds) {
    if (appliedIds.has(id)) continue;
    const target = findFeedbackTarget(comments, id);
    const hasChanges = Boolean(target && changedCommentIds.has(target.comment.id));
    if (status === "completed") {
      returnFeedbackToDraft(comments, id, {
        kind: "missing_response",
        message: `${agentName(activity.provider)} завершил пакет без отдельного ответа. Комментарий возвращён в очередь отправки.`
      });
    } else if (hasChanges) {
      markFeedbackNeedsAttention(
        comments,
        id,
        {
          kind: "partial_changes",
          message: "Проверьте выделенные изменения: их можно принять, отменить или уточнить дополнительным комментарием."
        },
        status === "interrupted"
          ? "Обработка была остановлена после внесения части изменений."
          : "Обработка завершилась с ошибкой после внесения части изменений.",
        now
      );
    } else {
      returnFeedbackToDraft(comments, id, {
        kind: status === "interrupted" ? "interrupted" : "processing_failed",
        message: status === "interrupted"
          ? "Обработка была остановлена. Комментарий возвращён в очередь отправки."
          : `${agentName(activity.provider)} не завершил обработку: ${activity.error || String(status)}`
      });
    }
  }
}

/**
 * Moves the anchors of the comments of a turn to the document as it is after the transfer. The
 * host calls this once the edits are in the document, so that anchors follow the live text.
 */
export function relocateTurnCommentAnchors(
  activity: CodexActivity,
  comments: ReviewComment[],
  now: string
): boolean {
  const beforeText = activity.documentTextBefore ?? activity.beforeText;
  const afterText = activity.documentTextAfter ?? activity.afterText;
  if (activity.anchorsRelocatedAt || afterText === undefined || activity.commentIds.length === 0) {
    return false;
  }

  const activityComments = new Set(activity.commentIds);
  for (const comment of comments) {
    const included = activityComments.has(comment.id)
      || comment.followUps.some((followUp) => activityComments.has(followUp.id));
    if (!included || comment.kind !== "selection") continue;
    const location = relocateComment(beforeText, afterText, comment);
    if (!location) continue;
    comment.fromOffset = location.from;
    comment.toOffset = location.to;
    comment.quote = afterText.slice(location.from, location.to);
    comment.anchor = createAnchor(afterText, location.from, location.to);
  }
  activity.anchorsRelocatedAt = now;
  return true;
}
