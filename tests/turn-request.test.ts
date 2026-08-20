import assert from "node:assert/strict";
import test from "node:test";
import { createAnchor } from "../src/anchors";
import {
  buildChatTurnInstructions,
  buildReviewTurnRequest,
  markFeedbackSent
} from "../src/turn-request";
import type { ReviewComment } from "../src/types";

const DOCUMENT = "Вступление.\n\n## Раздел\n\nДля вывода используется cout.";
const WORKING_COPY = "C:\\Vault\\.obsidian\\plugins\\codex-review\\worktree\\a1\\note.md";

function draft(feedback: string, quote: string, id: string): ReviewComment {
  const from = DOCUMENT.indexOf(quote);
  return {
    id,
    filePath: "note.md",
    kind: "selection",
    quote,
    anchor: createAnchor(DOCUMENT, from, from + quote.length),
    fromOffset: from,
    toOffset: from + quote.length,
    feedback,
    createdAt: "2026-08-16T11:00:00.000Z",
    status: "draft",
    followUps: []
  };
}

function reviewRequest(comments: ReviewComment[], overrides: Record<string, unknown> = {}) {
  return buildReviewTurnRequest({
    comments,
    document: { filePath: "note.md", text: DOCUMENT, workingCopyAbsolutePath: WORKING_COPY },
    absolutePath: (path) => `C:\\Vault\\${path}`,
    contextFiles: [],
    documentInstructions: "",
    hasDocumentContext: false,
    firstTurn: true,
    ...overrides
  });
}

function hiddenReviewContext(request: ReturnType<typeof reviewRequest>) {
  const jsonBlock = request.instructions.match(/```json\r?\n([\s\S]*?)\r?\n```/u);
  assert.ok(jsonBlock);
  return JSON.parse(jsonBlock[1]) as {
    pages: Array<{ comments: Array<{ kind: string; quote?: string }> }>;
  };
}

test("sends the working copy as the target and the feedback as the message", () => {
  const request = reviewRequest([draft("Оформи как код", "cout", "comment-1")]);

  assert.deepEqual(request.commentIds, ["comment-1"]);
  assert.equal(request.message, "Оформи как код");
  assert.equal(request.batch.pages[0].file, WORKING_COPY);
  assert.equal(request.instructions.startsWith(`TARGET DOCUMENT: ${WORKING_COPY}`), true);
});

test("keeps a selected comment scoped to its quote when the visible message has no quote", () => {
  const request = reviewRequest([draft("Сократи", "cout", "comment-1")]);
  const context = hiddenReviewContext(request);

  assert.equal(request.message, "Сократи");
  assert.doesNotMatch(request.message, /cout/);
  assert.equal(context.pages[0].comments[0].kind, "selection");
  assert.equal(context.pages[0].comments[0].quote, "cout");
  assert.doesNotMatch(request.instructions, /quotes no fragment applies to the target document as a whole/iu);
  assert.match(request.instructions, /edit only that fragment unless the feedback explicitly asks for a wider area/iu);
  assert.match(request.instructions, /reading this context does not expand the edit scope/iu);
});

test("gives a stylistic comment the local scope and a content comment the wider one", () => {
  const local = reviewRequest([draft("Сократи", "cout", "comment-1")]);
  const content = reviewRequest([draft("Добавь пример, но не повторяй сказанное выше", "cout", "comment-1")]);

  assert.equal(/do not read the rest of the document/iu.test(local.instructions), true);
  assert.equal(/read the whole section that holds it/iu.test(content.instructions), true);
});

test("treats a document-wide comment as a task about the whole document", () => {
  const documentComment: ReviewComment = {
    ...draft("Проверь оформление", "cout", "comment-1"),
    kind: "document",
    quote: "",
    anchor: { prefix: "", quote: "", suffix: "" },
    fromOffset: 0,
    toOffset: 0
  };

  const request = reviewRequest([documentComment]);

  assert.equal(/the request is about the whole document/iu.test(request.instructions), true);
});

test("keeps a document comment wide even when a selection mode is supplied", () => {
  const documentComment: ReviewComment = {
    ...draft("Проверь оформление", "cout", "comment-1"),
    kind: "document",
    quote: "",
    anchor: { prefix: "", quote: "", suffix: "" },
    fromOffset: 0,
    toOffset: 0
  };

  const request = reviewRequest([documentComment], { mode: "selection" });

  assert.match(request.instructions, /the request is about the whole document/iu);
  assert.doesNotMatch(request.instructions, /Read the quoted fragment with the paragraphs around it/iu);
});

test("carries a heading selection and an explicit whole-section request through the turn", () => {
  const request = reviewRequest([draft("Измени весь раздел целиком", "## Раздел", "section-comment")]);
  const context = hiddenReviewContext(request);

  assert.equal(request.message, "Измени весь раздел целиком");
  assert.equal(context.pages[0].comments[0].quote, "## Раздел");
  assert.match(request.instructions, /read the whole section that holds it/iu);
  assert.match(request.instructions, /edit only that fragment unless the feedback explicitly asks for a wider area/iu);
  assert.doesNotMatch(request.instructions, /the request is about the whole document/iu);
});

test("carries an explicit all-occurrences request while preserving its selection anchor", () => {
  const request = reviewRequest([draft("Исправь все повторяющиеся вхождения этого термина", "cout", "repeat-comment")]);
  const context = hiddenReviewContext(request);

  assert.equal(request.message, "Исправь все повторяющиеся вхождения этого термина");
  assert.equal(context.pages[0].comments[0].quote, "cout");
  assert.match(request.instructions, /read the whole section that holds it/iu);
  assert.doesNotMatch(request.instructions, /the request is about the whole document/iu);
});

test("carries a document comment as a document-scoped entry", () => {
  const comment: ReviewComment = {
    ...draft("Проверь оформление всего документа", "cout", "document-comment"),
    kind: "document",
    quote: "",
    anchor: { prefix: "", quote: "", suffix: "" },
    fromOffset: 0,
    toOffset: 0
  };
  const request = reviewRequest([comment]);
  const context = hiddenReviewContext(request);
  const hiddenComment = context.pages[0].comments[0];

  assert.equal(request.message, "Проверь оформление всего документа");
  assert.equal(hiddenComment.kind, "document");
  assert.equal(hiddenComment.quote, undefined);
  assert.match(request.instructions, /the request is about the whole document/iu);
});

test("carries the structure of the document and its own instructions into the turn", () => {
  const request = reviewRequest([draft("Сократи", "cout", "comment-1")], {
    documentInstructions: "Пиши в авторском стиле."
  });

  assert.equal(request.instructions.includes("## Раздел"), true);
  assert.equal(request.instructions.includes("Пиши в авторском стиле."), true);
});

test("continues a task instead of setting it up again", () => {
  const request = reviewRequest([draft("Сократи", "cout", "comment-1")], { firstTurn: false });

  assert.equal(/CONTINUATION: same task/u.test(request.instructions), true);
});

test("keeps a chat message about the whole document and never about a fragment", () => {
  const instructions = buildChatTurnInstructions({
    document: { filePath: "note.md", text: DOCUMENT, workingCopyAbsolutePath: WORKING_COPY },
    documentInstructions: "",
    firstTurn: true
  });

  assert.equal(instructions.startsWith(`TARGET DOCUMENT: ${WORKING_COPY}`), true);
  assert.equal(/read the target file in full/iu.test(instructions), true);
  // Nothing narrows the turn to a quoted fragment: there is no selection behind a chat message.
  assert.equal(/paragraphs on each side/iu.test(instructions), false);
  assert.equal(/section that holds the quoted fragment/iu.test(instructions), false);
  assert.equal(instructions.includes("codex-review-results"), false);
});

test("forces chat to document scope when the caller supplies selection mode", () => {
  const instructions = buildChatTurnInstructions({
    document: { filePath: "note.md", text: DOCUMENT, workingCopyAbsolutePath: WORKING_COPY },
    documentInstructions: "",
    firstTurn: true,
    mode: "selection"
  });

  assert.match(instructions, /the request is about the whole document/iu);
  assert.doesNotMatch(instructions, /Edit only the quoted fragment/iu);
  assert.doesNotMatch(instructions, /any neighboring paragraphs, its section, or the whole document when needed for context/iu);
});

test("moves what went into the turn from draft to sent", () => {
  const comment = draft("Сократи", "cout", "comment-1");
  comment.issue = { kind: "interrupted", message: "Обработка была остановлена." };
  const untouched = draft("Другое", "Вступление", "comment-2");

  markFeedbackSent([comment, untouched], ["comment-1"], {
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "claude",
    now: "2026-08-16T12:00:00.000Z"
  });

  assert.equal(comment.status, "sent");
  assert.equal(comment.sentAt, "2026-08-16T12:00:00.000Z");
  assert.equal(comment.threadId, "thread-1");
  assert.equal(comment.turnId, "turn-1");
  assert.equal(comment.provider, "claude");
  assert.equal(comment.issue, undefined);
  assert.equal(untouched.status, "draft");
});

test("marks a follow-up and its parent comment as sent", () => {
  const comment = draft("Сократи", "cout", "comment-1");
  comment.status = "addressed";
  comment.followUps = [{
    id: "follow-1",
    feedback: "И ещё короче",
    createdAt: "2026-08-16T11:30:00.000Z",
    status: "draft"
  }];

  markFeedbackSent([comment], ["follow-1"], {
    threadId: "thread-1",
    turnId: "turn-2",
    provider: "codex",
    now: "2026-08-16T12:00:00.000Z"
  });

  assert.equal(comment.followUps[0].status, "sent");
  assert.equal(comment.followUps[0].turnId, "turn-2");
  assert.equal(comment.status, "sent");
});
