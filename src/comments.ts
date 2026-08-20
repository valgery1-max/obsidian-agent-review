import { locateComment } from "./anchors";
import { normalizeAgentProvider } from "./agent-client";
import type {
  AgentProvider,
  CodexReviewCommentResult,
  ReviewComment,
  ReviewCommentFollowUp,
  ReviewCommentIssue,
  ReviewCommentStatus
} from "./types";

export type CommentScope = "active" | "all";

export function isActiveComment(comment: ReviewComment): boolean {
  return comment.status !== "accepted" && comment.status !== "resolved";
}

export function commentHasUnreadAttention(comment: ReviewComment): boolean {
  if (!isActiveComment(comment)) return false;
  const attentionFollowUps = comment.followUps.filter((followUp) => followUp.status === "needs_attention");
  const mainNeedsAttention = comment.status === "needs_attention"
    && (Boolean(comment.issue) || attentionFollowUps.length === 0)
    && !comment.issue?.seenAt;
  return mainNeedsAttention || attentionFollowUps.some((followUp) => !followUp.issue?.seenAt);
}

export function markCommentAttentionSeen(
  comments: ReviewComment[],
  id: string,
  seenAt: string
): boolean {
  const target = findFeedbackTarget(comments, id);
  if (!target) return false;
  let changed = false;
  const markIssue = (status: ReviewCommentStatus | ReviewCommentFollowUp["status"], issue?: ReviewCommentIssue) => {
    if (status !== "needs_attention" || !issue || issue.seenAt) return;
    issue.seenAt = seenAt;
    changed = true;
  };

  if (target.followUp) {
    markIssue(target.followUp.status, target.followUp.issue);
    return changed;
  }
  markIssue(target.comment.status, target.comment.issue);
  for (const followUp of target.comment.followUps) markIssue(followUp.status, followUp.issue);
  return changed;
}

export function prepareCommentForFollowUp(comment: ReviewComment): void {
  comment.issue = undefined;
  for (const followUp of comment.followUps) {
    if (followUp.status === "needs_attention") followUp.status = "addressed";
    followUp.issue = undefined;
  }
  if (comment.status === "accepted" || comment.status === "resolved" || comment.status === "needs_attention") {
    comment.status = "addressed";
  }
}

export function clearCommentAttention(comment: ReviewComment): void {
  comment.issue = undefined;
  for (const followUp of comment.followUps) {
    if (followUp.status === "needs_attention") followUp.status = "addressed";
    followUp.issue = undefined;
  }
}

export interface CommentActionAvailability {
  canAcceptChanges: boolean;
  canCancelChanges: boolean;
  canResolve: boolean;
  canReopen: boolean;
}

export function commentActionAvailability(
  comment: ReviewComment,
  hasInlineChanges: boolean
): CommentActionAvailability {
  const canReopen = comment.status === "accepted" || comment.status === "resolved";
  const canReviewChanges = hasInlineChanges
    && (comment.status === "addressed" || comment.status === "needs_attention");
  const canResolve = !hasInlineChanges && (
    (comment.status === "addressed" && Boolean(comment.agentResponse))
    || comment.status === "needs_attention"
  );
  return {
    canAcceptChanges: canReviewChanges,
    canCancelChanges: canReviewChanges,
    canResolve,
    canReopen
  };
}

export function isUnsentDraftComment(comment: ReviewComment): boolean {
  return comment.status === "draft" && !comment.sentAt;
}

export function removeUnsentDraftComment(comments: ReviewComment[], id: string): ReviewComment[] {
  const target = comments.find((comment) => comment.id === id);
  if (!target || !isUnsentDraftComment(target)) return comments;
  return comments.filter((comment) => comment.id !== id);
}

export function isDraftFollowUp(followUp: ReviewCommentFollowUp): boolean {
  return followUp.status === "draft";
}

export function canAddCommentFollowUp(comment: ReviewComment): boolean {
  return comment.status === "sent" || Boolean(comment.agentResponse);
}

export function responseAgentProvider(
  comment: ReviewComment,
  followUp?: ReviewCommentFollowUp
): AgentProvider {
  return normalizeAgentProvider(followUp?.provider ?? comment.provider);
}

export function workingAgentProvider(comment: ReviewComment): AgentProvider {
  const activeFollowUp = [...comment.followUps].reverse().find((followUp) => followUp.status === "sent");
  return responseAgentProvider(comment, activeFollowUp);
}

export function reviewTurnIdsForFile(comments: ReviewComment[], filePath: string): Set<string> {
  const ids = new Set<string>();
  for (const comment of comments) {
    if (comment.filePath !== filePath) continue;
    if (comment.turnId) ids.add(comment.turnId);
    for (const followUp of comment.followUps) {
      if (followUp.turnId) ids.add(followUp.turnId);
    }
  }
  return ids;
}

export function reviewTurnNeedsAttention(
  comments: ReviewComment[],
  filePath: string,
  turnId: string
): boolean {
  return comments.some((comment) => {
    if (comment.filePath !== filePath) return false;
    if (comment.turnId === turnId && comment.status === "needs_attention") return true;
    return comment.followUps.some((followUp) =>
      followUp.turnId === turnId && followUp.status === "needs_attention"
    );
  });
}

export function updateDraftFollowUp(
  comments: ReviewComment[],
  commentId: string,
  followUpId: string,
  feedback: string
): boolean {
  const comment = comments.find((item) => item.id === commentId);
  const followUp = comment?.followUps.find((item) => item.id === followUpId);
  const normalized = feedback.trim();
  if (!followUp || !isDraftFollowUp(followUp) || !normalized) return false;
  followUp.feedback = normalized;
  return true;
}

export function removeDraftFollowUp(
  comments: ReviewComment[],
  commentId: string,
  followUpId: string
): boolean {
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) return false;
  const index = comment.followUps.findIndex((item) => item.id === followUpId && isDraftFollowUp(item));
  if (index < 0) return false;
  comment.followUps.splice(index, 1);
  return true;
}

export interface FeedbackTarget {
  comment: ReviewComment;
  followUp?: ReviewCommentFollowUp;
}

export function findFeedbackTarget(comments: ReviewComment[], id: string): FeedbackTarget | undefined {
  for (const comment of comments) {
    if (comment.id === id) return { comment };
    const followUp = comment.followUps.find((item) => item.id === id);
    if (followUp) return { comment, followUp };
  }
  return undefined;
}

export function hasCompletedReviewContext(
  comments: ReviewComment[],
  filePath: string,
  threadId: string
): boolean {
  if (!threadId) return false;
  return comments.some((comment) =>
    comment.filePath === filePath
    && (
      (comment.threadId === threadId && Boolean(comment.respondedAt))
      || comment.followUps.some((followUp) => followUp.threadId === threadId && Boolean(followUp.respondedAt))
    )
  );
}

export function applyFeedbackResult(
  comments: ReviewComment[],
  result: CodexReviewCommentResult,
  respondedAt: string
): boolean {
  const target = findFeedbackTarget(comments, result.id);
  if (!target) return false;
  const issue: ReviewCommentIssue | undefined = result.status === "needs_attention"
    ? { kind: "user_input_required", message: result.requiredAction }
    : undefined;

  if (target.followUp) {
    target.followUp.status = result.status;
    target.followUp.agentResponse = result.response;
    target.followUp.respondedAt = respondedAt;
    target.followUp.issue = issue;
    target.comment.status = result.status;
  } else {
    target.comment.status = result.status;
    target.comment.agentResponse = result.response;
    target.comment.respondedAt = respondedAt;
    target.comment.issue = issue;
  }
  return true;
}

export function markFeedbackNeedsAttention(
  comments: ReviewComment[],
  id: string,
  issue: ReviewCommentIssue,
  response: string,
  respondedAt: string
): boolean {
  return applyFeedbackResult(comments, {
    id,
    status: "needs_attention",
    response,
    requiredAction: issue.message
  }, respondedAt) && setFeedbackIssue(comments, id, issue);
}

/**
 * Flags a comment whose agent edits could not be transferred to the document, keeping the answer
 * the agent already wrote.
 */
export function markFeedbackUnappliedChanges(
  comments: ReviewComment[],
  id: string,
  issue: ReviewCommentIssue
): boolean {
  const target = findFeedbackTarget(comments, id);
  if (!target) return false;
  if (target.followUp) target.followUp.status = "needs_attention";
  target.comment.status = "needs_attention";
  return setFeedbackIssue(comments, id, issue);
}

function setFeedbackIssue(comments: ReviewComment[], id: string, issue: ReviewCommentIssue): boolean {
  const target = findFeedbackTarget(comments, id);
  if (!target) return false;
  if (target.followUp) target.followUp.issue = issue;
  else target.comment.issue = issue;
  return true;
}

export function returnFeedbackToDraft(
  comments: ReviewComment[],
  id: string,
  issue: ReviewCommentIssue
): boolean {
  const target = findFeedbackTarget(comments, id);
  if (!target) return false;

  if (target.followUp) {
    target.followUp.status = "draft";
    target.followUp.sentAt = undefined;
    target.followUp.agentResponse = undefined;
    target.followUp.respondedAt = undefined;
    target.followUp.issue = issue;
    target.comment.status = target.comment.agentResponse ? "addressed" : "draft";
  } else {
    target.comment.status = "draft";
    target.comment.sentAt = undefined;
    target.comment.agentResponse = undefined;
    target.comment.respondedAt = undefined;
    target.comment.issue = issue;
  }
  return true;
}

export function prepareFeedbackForRetry(comments: ReviewComment[], id: string): boolean {
  const prepared = returnFeedbackToDraft(comments, id, {
    kind: "interrupted",
    message: "Комментарий подготовлен к повторной отправке."
  });
  if (!prepared) return false;
  clearFeedbackIssue(comments, id);
  return true;
}

export function clearFeedbackIssue(comments: ReviewComment[], id: string): void {
  const target = findFeedbackTarget(comments, id);
  if (!target) return;
  if (target.followUp) target.followUp.issue = undefined;
  else target.comment.issue = undefined;
}

export function commentsForFile(
  comments: ReviewComment[],
  filePath: string | undefined,
  scope: CommentScope,
  currentText?: string
): ReviewComment[] {
  if (!filePath) return [];
  const fileComments = comments
    .filter((comment) => comment.filePath === filePath)
    .filter((comment) => scope === "all" || isActiveComment(comment));

  if (scope === "all") {
    return fileComments.sort(compareChronologically);
  }

  return fileComments.sort((left, right) => {
    const positionDifference = commentPosition(left, currentText) - commentPosition(right, currentText);
    return positionDifference || compareChronologically(left, right);
  });
}

function commentPosition(comment: ReviewComment, currentText?: string): number {
  if (comment.kind === "document") return -1;
  if (currentText !== undefined) {
    const location = locateComment(currentText, comment);
    if (location) return location.from;
  }
  return comment.fromOffset;
}

function compareChronologically(left: ReviewComment, right: ReviewComment): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export interface FileCommentStatusCounts {
  total: number;
  ready: number;
  attention: number;
}

export function commentStatusCountsForFile(
  comments: ReviewComment[],
  filePath: string | undefined
): FileCommentStatusCounts {
  if (!filePath) return { total: 0, ready: 0, attention: 0 };
  const fileComments = comments.filter((comment) => comment.filePath === filePath);
  return {
    total: fileComments.length,
    ready: fileComments.reduce((count, comment) => count
      + (comment.status === "draft" ? 1 : 0)
      + comment.followUps.filter((followUp) => followUp.status === "draft").length, 0),
    attention: fileComments.filter(commentHasUnreadAttention).length
  };
}

export type NavigableCommentStatus = "ready" | "attention";

export function nextCommentInStatus(
  comments: ReviewComment[],
  status: NavigableCommentStatus,
  activeCommentId: string | null
): ReviewComment | undefined {
  const matching = comments.filter((comment) => status === "ready"
    ? comment.status === "draft" || comment.followUps.some((followUp) => followUp.status === "draft")
    : commentHasUnreadAttention(comment)
  );
  if (matching.length === 0) return undefined;
  const activeIndex = matching.findIndex((comment) => comment.id === activeCommentId);
  if (activeIndex < 0) return matching[0];
  return matching[activeIndex + 1];
}

export function draftFeedbackCountForFile(comments: ReviewComment[], filePath: string | undefined): number {
  return commentStatusCountsForFile(comments, filePath).ready;
}
