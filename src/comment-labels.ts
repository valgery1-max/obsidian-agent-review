import { agentName } from "./agent-client";
import { commentHasUnreadAttention, workingAgentProvider } from "./comments";
import type { ReviewComment, ReviewCommentIssue, ReviewCommentStatus } from "./types";

/**
 * Подписи состояний комментария.
 *
 * Человек должен видеть словами, что происходит с его замечанием: ушло оно агенту, готово, ждёт
 * решения. Правило одно на все поверхности продукта, поэтому живёт в ядре — иначе плагин и
 * приложение начнут называть одно и то же по-разному.
 */

export const COMMENT_STATUS_LABELS: Record<ReviewCommentStatus, string> = {
  draft: "Ожидает отправки",
  sent: "Агент работает",
  addressed: "Готово",
  needs_attention: "Требуется внимание",
  accepted: "Принято",
  resolved: "Завершено"
};

export function commentStatusLabel(comment: ReviewComment): string {
  return comment.status === "sent"
    ? `${agentName(workingAgentProvider(comment))} работает`
    : COMMENT_STATUS_LABELS[comment.status];
}

/** Стадия показывается не всегда: у отвеченного и прочитанного комментария она лишний шум. */
export function showsCommentStatus(comment: ReviewComment): boolean {
  if (comment.status === "addressed") return false;
  return !(comment.status === "needs_attention" && !commentHasUnreadAttention(comment));
}

export function isRetryableCommentIssue(issue: ReviewCommentIssue): boolean {
  return issue.kind === "processing_failed" || issue.kind === "interrupted" || issue.kind === "missing_response";
}

export function commentIssueLabel(issue: ReviewCommentIssue): string {
  if (isRetryableCommentIssue(issue)) return "Можно отправить повторно";
  return issue.kind === "conflicting_changes" ? "Правка не перенесена" : "Что требуется";
}
