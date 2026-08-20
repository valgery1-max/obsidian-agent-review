import assert from "node:assert/strict";
import test from "node:test";
import { createAnchor } from "../src/anchors";
import { relocateTurnCommentAnchors, resolveTurnOutcome } from "../src/turn-outcome";
import type { CodexActivity, ReviewComment, ReviewInlineChange } from "../src/types";

const NOW = "2026-08-16T12:00:00.000Z";
const BASE = "Вступление.\n\nДля вывода используется cout.\n\nЗаключение.";

function comment(text: string, quote: string, id = "comment-1"): ReviewComment {
  const from = text.indexOf(quote);
  return {
    id,
    filePath: "note.md",
    kind: "selection",
    quote,
    anchor: createAnchor(text, from, from + quote.length),
    fromOffset: from,
    toOffset: from + quote.length,
    feedback: "Уточни оформление",
    createdAt: "2026-08-16T11:00:00.000Z",
    status: "sent",
    sentAt: "2026-08-16T11:00:00.000Z",
    followUps: []
  };
}

function activity(overrides: Partial<CodexActivity> = {}): CodexActivity {
  return {
    filePath: "note.md",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    taskLabel: "note",
    status: "running",
    source: "review",
    startedAt: "2026-08-16T11:00:00.000Z",
    entries: [],
    finalMessage: "",
    itemPhases: {},
    commentIds: ["comment-1"],
    beforeText: BASE,
    workingCopyPath: ".obsidian/plugins/codex-review/worktree/a1/note.md",
    ...overrides
  };
}

function resultsBlock(id: string, response: string, status: "addressed" | "needs_attention" = "addressed"): string {
  const payload = status === "addressed"
    ? { comments: [{ id, status, response }] }
    : { comments: [{ id, status, response, requiredAction: "Уточните формат" }] };
  return `Готово.\n\n<!-- codex-review-results\n${JSON.stringify(payload)}\n-->`;
}

function outcomeFor(options: {
  activity: CodexActivity;
  comments: ReviewComment[];
  inlineChanges?: ReviewInlineChange[];
  documentText: string | null;
  agentText: string | undefined;
  status?: string;
}) {
  let index = 0;
  return resolveTurnOutcome({
    activity: options.activity,
    status: options.status ?? "completed",
    comments: options.comments,
    inlineChanges: options.inlineChanges ?? [],
    documentText: options.documentText,
    agentText: options.agentText,
    makeId: () => `generated-${++index}`,
    now: NOW
  });
}

test("carries the agent edits into the document and answers the comment", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({ finalMessage: resultsBlock("comment-1", "Оформила как код.") });
  const agentText = BASE.replace("cout", "`cout`");

  const outcome = outcomeFor({ activity: item, comments, documentText: BASE, agentText });

  assert.equal(outcome.documentChanges.length, 1);
  assert.equal(outcome.documentText, agentText);
  assert.equal(outcome.inlineChanges.length, 1);
  assert.equal(outcome.inlineChanges[0].commentId, "comment-1");
  assert.equal(comments[0].status, "addressed");
  assert.equal(comments[0].agentResponse, "Оформила как код.");
  assert.deepEqual(outcome.versions.map((version) => version.source), ["before_codex", "codex"]);
  assert.equal(item.status, "completed");
  assert.equal(item.completedAt, NOW);
  assert.equal(outcome.notices.length, 0);
});

test("keeps the user version and flags the comment when the fragment changed meanwhile", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({ finalMessage: resultsBlock("comment-1", "Оформила как код.") });
  const agentText = BASE.replace("cout", "`cout`");
  const userText = BASE.replace("cout", "std::cout");

  const outcome = outcomeFor({ activity: item, comments, documentText: userText, agentText });

  assert.equal(outcome.documentChanges.length, 0);
  assert.equal(outcome.documentText, userText);
  assert.equal(comments[0].status, "needs_attention");
  assert.equal(comments[0].issue?.kind, "conflicting_changes");
  assert.equal(outcome.notices.length, 1);
  assert.equal(/не перенесены/u.test(outcome.notices[0]), true);
});

test("returns a comment to the queue when the turn ends without an answer for it", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({ finalMessage: "" });

  outcomeFor({ activity: item, comments, documentText: BASE, agentText: BASE });

  assert.equal(comments[0].status, "draft");
  assert.equal(comments[0].issue?.kind, "missing_response");
});

test("uses the visible answer when a single comment got no service block", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({ finalMessage: "Готово, оформила как код." });

  outcomeFor({ activity: item, comments, documentText: BASE, agentText: BASE });

  assert.equal(comments[0].status, "addressed");
  assert.equal(comments[0].agentResponse, "Готово, оформила как код.");
});

test("asks the user to check the partial changes of an interrupted turn", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({ finalMessage: "" });
  const agentText = BASE.replace("cout", "`cout`");

  outcomeFor({ activity: item, comments, documentText: BASE, agentText, status: "interrupted" });

  assert.equal(comments[0].status, "needs_attention");
  assert.equal(comments[0].issue?.kind, "partial_changes");
});

test("returns a comment to the queue when an interrupted turn changed nothing", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({ finalMessage: "" });

  outcomeFor({ activity: item, comments, documentText: BASE, agentText: BASE, status: "interrupted" });

  assert.equal(comments[0].status, "draft");
  assert.equal(comments[0].issue?.kind, "interrupted");
});

test("creates chat cards for a conversation turn and stamps them with the task", () => {
  const item = activity({
    source: "conversation",
    commentIds: [],
    requestText: "Оформи код",
    finalMessage: "Готово."
  });
  const agentText = BASE.replace("cout", "`cout`");

  const outcome = outcomeFor({ activity: item, comments: [], documentText: BASE, agentText });

  assert.equal(outcome.newComments.length, 1);
  assert.equal(outcome.newComments[0].threadId, "thread-1");
  assert.equal(outcome.newComments[0].turnId, "turn-1");
  assert.equal(outcome.newComments[0].provider, "codex");
  assert.equal(outcome.inlineChanges.length, 1);
  assert.equal(item.finalMessage, "Готово.");
});

test("keeps the old behaviour for an activity without a working copy", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity({
    workingCopyPath: undefined,
    finalMessage: resultsBlock("comment-1", "Оформила как код.")
  });
  const liveText = BASE.replace("cout", "`cout`");

  const outcome = outcomeFor({ activity: item, comments, documentText: liveText, agentText: liveText });

  assert.equal(outcome.merged, null);
  assert.equal(outcome.documentChanges.length, 0);
  assert.equal(outcome.inlineChanges.length, 1);
  assert.equal(comments[0].status, "addressed");
});

test("routes a result addressed to the parent comment onto the follow-up of the turn", () => {
  const target = comment(BASE, "cout");
  target.status = "addressed";
  target.agentResponse = "Первый ответ";
  target.followUps = [{
    id: "follow-1",
    feedback: "И ещё выдели команду",
    createdAt: "2026-08-16T11:30:00.000Z",
    status: "sent"
  }];
  const item = activity({
    commentIds: ["follow-1"],
    followUpId: "follow-1",
    finalMessage: resultsBlock("comment-1", "Выделила команду.")
  });

  outcomeFor({ activity: item, comments: [target], documentText: BASE, agentText: BASE });

  assert.equal(target.followUps[0].status, "addressed");
  assert.equal(target.followUps[0].agentResponse, "Выделила команду.");
});

test("moves the anchors of the turn onto the document after the transfer", () => {
  const comments = [comment(BASE, "cout")];
  const item = activity();
  const agentText = BASE.replace("cout", "`cout`");
  outcomeFor({ activity: item, comments, documentText: BASE, agentText });

  const relocated = relocateTurnCommentAnchors(item, comments, NOW);

  assert.equal(relocated, true);
  assert.equal(item.anchorsRelocatedAt, NOW);
  assert.equal(item.documentTextAfter!.slice(comments[0].fromOffset, comments[0].toOffset), comments[0].quote);
  assert.equal(relocateTurnCommentAnchors(item, comments, NOW), false);
});
