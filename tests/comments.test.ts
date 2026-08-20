import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFeedbackResult,
  canAddCommentFollowUp,
  clearFeedbackIssue,
  commentActionAvailability,
  commentHasUnreadAttention,
  commentStatusCountsForFile,
  commentsForFile,
  draftFeedbackCountForFile,
  hasCompletedReviewContext,
  isDraftFollowUp,
  isUnsentDraftComment,
  markFeedbackNeedsAttention,
  markCommentAttentionSeen,
  nextCommentInStatus,
  prepareCommentForFollowUp,
  prepareFeedbackForRetry,
  removeDraftFollowUp,
  removeUnsentDraftComment,
  responseAgentProvider,
  reviewTurnIdsForFile,
  reviewTurnNeedsAttention,
  returnFeedbackToDraft,
  updateDraftFollowUp,
  workingAgentProvider
} from "../src/comments";
import { createAnchor } from "../src/anchors";
import type { ReviewComment, ReviewCommentStatus } from "../src/types";

function comment(id: string, filePath: string, createdAt: string, status: ReviewCommentStatus): ReviewComment {
  return {
    id,
    filePath,
    kind: "document",
    quote: "",
    anchor: { prefix: "", quote: "", suffix: "" },
    fromOffset: 0,
    toOffset: 0,
    feedback: id,
    createdAt,
    status,
    followUps: []
  };
}

const comments = [
  comment("old-active", "article.md", "2026-08-10T10:00:00.000Z", "draft"),
  comment("accepted", "article.md", "2026-08-10T11:00:00.000Z", "accepted"),
  comment("resolved", "article.md", "2026-08-10T12:00:00.000Z", "resolved"),
  comment("new-active", "article.md", "2026-08-10T13:00:00.000Z", "needs_attention"),
  comment("other-file", "other.md", "2026-08-10T14:00:00.000Z", "draft")
];

test("active comments follow their anchors in the current document", () => {
  const originalText = "Первый абзац.\n\nВторой абзац.\n\nТретий абзац.";
  const currentText = "Третий абзац.\n\nПервый абзац.\n\nВторой абзац.";
  const first = comment("first", "article.md", "2026-08-10T13:00:00.000Z", "needs_attention");
  first.kind = "selection";
  first.quote = "Первый абзац.";
  first.fromOffset = originalText.indexOf(first.quote);
  first.toOffset = first.fromOffset + first.quote.length;
  first.anchor = createAnchor(originalText, first.fromOffset, first.toOffset);

  const third = comment("third", "article.md", "2026-08-10T10:00:00.000Z", "draft");
  third.kind = "selection";
  third.quote = "Третий абзац.";
  third.fromOffset = originalText.indexOf(third.quote);
  third.toOffset = third.fromOffset + third.quote.length;
  third.anchor = createAnchor(originalText, third.fromOffset, third.toOffset);

  const accepted = comment("accepted-first", "article.md", "2026-08-10T09:00:00.000Z", "accepted");
  accepted.kind = "selection";
  accepted.quote = first.quote;
  accepted.fromOffset = first.fromOffset;
  accepted.toOffset = first.toOffset;
  accepted.anchor = first.anchor;

  assert.deepEqual(
    commentsForFile([third, accepted, first], "article.md", "active", currentText).map((item) => item.id),
    ["third", "first"]
  );
});

test("all comments contain only the current file from oldest to newest", () => {
  assert.deepEqual(
    commentsForFile(comments, "article.md", "all").map((item) => item.id),
    ["old-active", "accepted", "resolved", "new-active"]
  );
});

test("offers only actions that match the comment state", () => {
  const draft = comment("draft", "article.md", "2026-08-10T10:00:00.000Z", "draft");
  const sent = comment("sent", "article.md", "2026-08-10T10:01:00.000Z", "sent");
  const addressed = comment("addressed", "article.md", "2026-08-10T10:02:00.000Z", "addressed");
  addressed.agentResponse = "Готово";
  const attention = comment("attention", "article.md", "2026-08-10T10:03:00.000Z", "needs_attention");
  const accepted = comment("accepted", "article.md", "2026-08-10T10:04:00.000Z", "accepted");
  const resolved = comment("resolved", "article.md", "2026-08-10T10:05:00.000Z", "resolved");

  assert.deepEqual(commentActionAvailability(draft, false), {
    canAcceptChanges: false, canCancelChanges: false, canResolve: false, canReopen: false
  });
  assert.deepEqual(commentActionAvailability(sent, false), {
    canAcceptChanges: false, canCancelChanges: false, canResolve: false, canReopen: false
  });
  assert.deepEqual(commentActionAvailability(addressed, true), {
    canAcceptChanges: true, canCancelChanges: true, canResolve: false, canReopen: false
  });
  assert.deepEqual(commentActionAvailability(addressed, false), {
    canAcceptChanges: false, canCancelChanges: false, canResolve: true, canReopen: false
  });
  assert.deepEqual(commentActionAvailability(attention, true), {
    canAcceptChanges: true, canCancelChanges: true, canResolve: false, canReopen: false
  });
  assert.deepEqual(commentActionAvailability(attention, false), {
    canAcceptChanges: false, canCancelChanges: false, canResolve: true, canReopen: false
  });
  assert.equal(commentActionAvailability(accepted, false).canReopen, true);
  assert.equal(commentActionAvailability(resolved, false).canReopen, true);
});

test("draft count includes saved additional comments", () => {
  const withFollowUp = comment("answered", "article.md", "2026-08-10T15:00:00.000Z", "addressed");
  withFollowUp.followUps.push({
    id: "follow-up-draft",
    feedback: "Добавить пример",
    createdAt: "2026-08-10T15:01:00.000Z",
    status: "draft"
  });

  assert.equal(draftFeedbackCountForFile([...comments, withFollowUp], "article.md"), 2);
});

test("allows another follow-up while Codex is still processing the branch", () => {
  const processing = comment("processing", "article.md", "2026-08-10T15:00:00.000Z", "sent");
  const answered = comment("answered", "article.md", "2026-08-10T15:01:00.000Z", "addressed");
  answered.agentResponse = "Готово";
  const draft = comment("draft", "article.md", "2026-08-10T15:02:00.000Z", "draft");

  assert.equal(canAddCommentFollowUp(processing), true);
  assert.equal(canAddCommentFollowUp(answered), true);
  assert.equal(canAddCommentFollowUp(draft), false);
});

test("keeps a queued follow-up untouched when the active Codex response arrives", () => {
  const parent = comment("parent", "article.md", "2026-08-10T15:03:00.000Z", "sent");
  parent.agentResponse = "Первый ответ";
  parent.followUps.push(
    {
      id: "active-follow-up",
      feedback: "Текущее уточнение",
      createdAt: "2026-08-10T15:04:00.000Z",
      status: "sent"
    },
    {
      id: "queued-follow-up",
      feedback: "Следующее уточнение",
      createdAt: "2026-08-10T15:05:00.000Z",
      status: "draft"
    }
  );

  applyFeedbackResult([parent], {
    id: "active-follow-up",
    status: "addressed",
    response: "Ответ на текущее уточнение"
  }, "2026-08-10T15:06:00.000Z");

  assert.equal(parent.followUps[0].status, "addressed");
  assert.equal(parent.followUps[1].status, "draft");
  assert.equal(parent.followUps[1].agentResponse, undefined);
});

test("keeps the actual agent on every response in a mixed comment thread", () => {
  const parent = comment("parent", "article.md", "2026-08-10T15:07:00.000Z", "sent");
  parent.provider = "codex";
  parent.agentResponse = "Ответ Codex";
  parent.followUps.push({
    id: "claude-follow-up",
    feedback: "Уточнение для Claude",
    createdAt: "2026-08-10T15:08:00.000Z",
    status: "addressed",
    provider: "claude",
    agentResponse: "Ответ Claude"
  }, {
    id: "codex-follow-up",
    feedback: "Следующее уточнение для Codex",
    createdAt: "2026-08-10T15:09:00.000Z",
    status: "sent",
    provider: "codex"
  });

  assert.equal(responseAgentProvider(parent), "codex");
  assert.equal(responseAgentProvider(parent, parent.followUps[0]), "claude");
  assert.equal(workingAgentProvider(parent), "codex");
});

test("recognizes review turns from main and additional comments", () => {
  const parent = comment("parent", "article.md", "2026-08-10T15:09:00.000Z", "addressed");
  parent.turnId = "codex-turn";
  parent.followUps.push({
    id: "claude-follow-up",
    feedback: "Уточнение",
    createdAt: "2026-08-10T15:10:00.000Z",
    status: "needs_attention",
    turnId: "claude-turn",
    provider: "claude"
  });

  assert.deepEqual([...reviewTurnIdsForFile([parent], "article.md")], ["codex-turn", "claude-turn"]);
  assert.equal(reviewTurnNeedsAttention([parent], "article.md", "codex-turn"), false);
  assert.equal(reviewTurnNeedsAttention([parent], "article.md", "claude-turn"), true);
  assert.equal(reviewTurnIdsForFile([parent], "other.md").size, 0);
});

test("summarizes ready and attention comments for the current file", () => {
  const ready = comment("ready", "article.md", "2026-08-10T15:10:00.000Z", "draft");
  ready.followUps.push({
    id: "ready-follow-up",
    feedback: "Еще одно уточнение",
    createdAt: "2026-08-10T15:11:00.000Z",
    status: "draft"
  });
  const attention = comment("attention", "article.md", "2026-08-10T15:12:00.000Z", "needs_attention");
  const resolved = comment("resolved", "article.md", "2026-08-10T15:13:00.000Z", "resolved");

  assert.deepEqual(commentStatusCountsForFile([ready, attention, resolved], "article.md"), {
    total: 3,
    ready: 2,
    attention: 1
  });
});

test("moves through comments of one status and stops on the last one", () => {
  const firstReady = comment("ready-1", "article.md", "2026-08-10T15:10:00.000Z", "draft");
  const unrelated = comment("answered", "article.md", "2026-08-10T15:11:00.000Z", "addressed");
  const secondReady = comment("ready-2", "article.md", "2026-08-10T15:12:00.000Z", "addressed");
  secondReady.followUps.push({
    id: "ready-follow-up",
    feedback: "Ещё один вопрос",
    createdAt: "2026-08-10T15:13:00.000Z",
    status: "draft"
  });
  const attention = comment("attention", "article.md", "2026-08-10T15:14:00.000Z", "needs_attention");
  const ordered = [firstReady, unrelated, secondReady, attention];

  assert.equal(nextCommentInStatus(ordered, "ready", null)?.id, "ready-1");
  assert.equal(nextCommentInStatus(ordered, "ready", "ready-1")?.id, "ready-2");
  assert.equal(nextCommentInStatus(ordered, "ready", "ready-2"), undefined);
  assert.equal(nextCommentInStatus(ordered, "attention", null)?.id, "attention");
  assert.equal(nextCommentInStatus(ordered, "attention", "attention"), undefined);
});

test("opening an attention comment clears only its unread signal", () => {
  const attention = comment("attention", "article.md", "2026-08-10T15:14:00.000Z", "needs_attention");
  attention.agentResponse = "Нужен выбор пользователя.";
  attention.issue = {
    kind: "user_input_required",
    message: "Выберите один из вариантов."
  };

  assert.equal(commentHasUnreadAttention(attention), true);
  assert.equal(markCommentAttentionSeen([attention], attention.id, "2026-08-10T15:15:00.000Z"), true);
  assert.equal(commentHasUnreadAttention(attention), false);
  assert.equal(attention.status, "needs_attention");
  assert.equal(attention.issue?.message, "Выберите один из вариантов.");
  assert.equal(attention.issue?.seenAt, "2026-08-10T15:15:00.000Z");
  assert.equal(commentStatusCountsForFile([attention], "article.md").attention, 0);
  assert.equal(nextCommentInStatus([attention], "attention", null), undefined);
});

test("opening a thread acknowledges attention in its additional comments", () => {
  const parent = comment("parent", "article.md", "2026-08-10T15:16:00.000Z", "needs_attention");
  parent.agentResponse = "Первый ответ";
  parent.followUps.push({
    id: "follow-up",
    feedback: "Уточнение",
    createdAt: "2026-08-10T15:17:00.000Z",
    status: "needs_attention",
    issue: { kind: "user_input_required", message: "Уточните аудиторию." }
  });

  assert.equal(markCommentAttentionSeen([parent], parent.id, "2026-08-10T15:18:00.000Z"), true);
  assert.equal(parent.followUps[0].issue?.seenAt, "2026-08-10T15:18:00.000Z");
  assert.equal(commentHasUnreadAttention(parent), false);
});

test("a saved follow-up closes the previous attention request", () => {
  const parent = comment("parent", "article.md", "2026-08-10T15:19:00.000Z", "needs_attention");
  parent.agentResponse = "Нужна редакционная политика.";
  parent.issue = { kind: "user_input_required", message: "Приложите правила." };
  parent.followUps.push({
    id: "old-follow-up",
    feedback: "Первая попытка",
    createdAt: "2026-08-10T15:20:00.000Z",
    status: "needs_attention",
    issue: { kind: "user_input_required", message: "Уточните область действия." }
  });

  prepareCommentForFollowUp(parent);

  assert.equal(parent.status, "addressed");
  assert.equal(parent.issue, undefined);
  assert.equal(parent.followUps[0].status, "addressed");
  assert.equal(parent.followUps[0].issue, undefined);
});

test("deletes only a draft that has never been sent", () => {
  const unsent = comment("unsent", "article.md", "2026-08-10T16:00:00.000Z", "draft");
  const reopened = comment("reopened", "article.md", "2026-08-10T17:00:00.000Z", "draft");
  reopened.sentAt = "2026-08-10T17:01:00.000Z";
  const source = [unsent, reopened];

  assert.equal(isUnsentDraftComment(unsent), true);
  assert.equal(isUnsentDraftComment(reopened), false);
  assert.deepEqual(removeUnsentDraftComment(source, unsent.id).map((item) => item.id), ["reopened"]);
  assert.equal(removeUnsentDraftComment(source, reopened.id), source);
});

test("edits only the selected draft follow-up", () => {
  const parent = comment("parent", "article.md", "2026-08-10T18:00:00.000Z", "addressed");
  parent.followUps.push(
    { id: "first", feedback: "Первый", createdAt: "2026-08-10T18:01:00.000Z", status: "draft" },
    { id: "sent", feedback: "Отправленный", createdAt: "2026-08-10T18:02:00.000Z", status: "sent" }
  );

  assert.equal(isDraftFollowUp(parent.followUps[0]), true);
  assert.equal(updateDraftFollowUp([parent], parent.id, "first", "  Исправленный  "), true);
  assert.equal(parent.followUps[0].feedback, "Исправленный");
  assert.equal(updateDraftFollowUp([parent], parent.id, "sent", "Новый текст"), false);
  assert.equal(parent.followUps[1].feedback, "Отправленный");
});

test("deletes one draft follow-up without removing its branch or siblings", () => {
  const parent = comment("parent", "article.md", "2026-08-10T19:00:00.000Z", "addressed");
  parent.followUps.push(
    { id: "remove", feedback: "Удалить", createdAt: "2026-08-10T19:01:00.000Z", status: "draft" },
    { id: "keep", feedback: "Оставить", createdAt: "2026-08-10T19:02:00.000Z", status: "draft" },
    { id: "sent", feedback: "Отправленный", createdAt: "2026-08-10T19:03:00.000Z", status: "sent" }
  );
  const source = [parent];

  assert.equal(removeDraftFollowUp(source, parent.id, "remove"), true);
  assert.equal(source[0], parent);
  assert.deepEqual(parent.followUps.map((item) => item.id), ["keep", "sent"]);
  assert.equal(removeDraftFollowUp(source, parent.id, "sent"), false);
});

test("recognizes completed review context only in the same file and task", () => {
  const reviewed = comment("reviewed", "article.md", "2026-08-10T20:00:00.000Z", "addressed");
  reviewed.threadId = "thread-one";
  reviewed.respondedAt = "2026-08-10T20:01:00.000Z";

  assert.equal(hasCompletedReviewContext([reviewed], "article.md", "thread-one"), true);
  assert.equal(hasCompletedReviewContext([reviewed], "other.md", "thread-one"), false);
  assert.equal(hasCompletedReviewContext([reviewed], "article.md", "thread-two"), false);

  reviewed.followUps.push({
    id: "claude-reply",
    feedback: "Уточнение",
    createdAt: "2026-08-10T20:02:00.000Z",
    status: "addressed",
    threadId: "claude-thread",
    provider: "claude",
    respondedAt: "2026-08-10T20:03:00.000Z"
  });
  assert.equal(hasCompletedReviewContext([reviewed], "article.md", "claude-thread"), true);
});

test("stores the action required by Codex on the matching comment", () => {
  const target = comment("target", "article.md", "2026-08-10T21:00:00.000Z", "sent");
  const applied = applyFeedbackResult([target], {
    id: target.id,
    status: "needs_attention",
    response: "Источник не найден.",
    requiredAction: "Укажите источник утверждения."
  }, "2026-08-10T21:01:00.000Z");

  assert.equal(applied, true);
  assert.equal(target.status, "needs_attention");
  assert.deepEqual(target.issue, {
    kind: "user_input_required",
    message: "Укажите источник утверждения."
  });
});

test("returns a failed main comment to an editable draft with a visible reason", () => {
  const target = comment("target", "article.md", "2026-08-10T22:00:00.000Z", "sent");
  target.sentAt = "2026-08-10T22:01:00.000Z";
  const issue = { kind: "processing_failed" as const, message: "Codex потерял соединение." };

  assert.equal(returnFeedbackToDraft([target], target.id, issue), true);
  assert.equal(target.status, "draft");
  assert.equal(target.sentAt, undefined);
  assert.equal(isUnsentDraftComment(target), true);
  assert.deepEqual(target.issue, issue);
  clearFeedbackIssue([target], target.id);
  assert.equal(target.issue, undefined);
});

test("returns only a failed follow-up to draft and keeps its parent answered", () => {
  const parent = comment("parent", "article.md", "2026-08-10T23:00:00.000Z", "sent");
  parent.agentResponse = "Первый ответ";
  parent.followUps.push({
    id: "follow-up",
    feedback: "Уточнение",
    createdAt: "2026-08-10T23:01:00.000Z",
    sentAt: "2026-08-10T23:02:00.000Z",
    status: "sent"
  });

  returnFeedbackToDraft([parent], "follow-up", {
    kind: "interrupted",
    message: "Обработка была остановлена."
  });

  assert.equal(parent.status, "addressed");
  assert.equal(parent.followUps[0].status, "draft");
  assert.equal(parent.followUps[0].sentAt, undefined);
});

test("can mark a missing individual response as actionable", () => {
  const target = comment("target", "article.md", "2026-08-11T00:00:00.000Z", "sent");
  markFeedbackNeedsAttention(
    [target],
    target.id,
    { kind: "missing_response", message: "Отправьте комментарий повторно." },
    "Codex завершил пакет без отдельного ответа.",
    "2026-08-11T00:01:00.000Z"
  );

  assert.equal(target.status, "needs_attention");
  assert.equal(target.issue?.kind, "missing_response");
});

test("returns a missing response to the same clean state as a new draft", () => {
  const target = comment("target", "article.md", "2026-08-11T01:00:00.000Z", "needs_attention");
  target.sentAt = "2026-08-11T01:01:00.000Z";
  target.agentResponse = "Codex не передал отдельный ответ.";
  target.respondedAt = "2026-08-11T01:02:00.000Z";
  target.issue = { kind: "missing_response", message: "Отправьте комментарий повторно." };

  assert.equal(prepareFeedbackForRetry([target], target.id), true);
  assert.equal(target.status, "draft");
  assert.equal(target.sentAt, undefined);
  assert.equal(target.agentResponse, undefined);
  assert.equal(target.respondedAt, undefined);
  assert.equal(target.issue, undefined);
  assert.equal(isUnsentDraftComment(target), true);
});
