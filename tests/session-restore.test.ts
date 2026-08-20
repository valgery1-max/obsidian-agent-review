import assert from "node:assert/strict";
import test from "node:test";
import { createAnchor } from "../src/anchors";
import {
  backfillInlineChangesFromActivities,
  backfillReviewResponseRoutes,
  backfillVersionsFromActivities,
  finishInterruptedActivity,
  type ActivityMap
} from "../src/session-restore";
import type { CodexActivity, ReviewComment } from "../src/types";

const CLOSED = "Обработка остановлена из-за закрытия Obsidian.";
const RETURNED = "Obsidian закрылся во время обработки. Комментарий возвращён в очередь отправки.";
const BEFORE = "Начало. Старый фрагмент. Конец.";
const AFTER = "Начало. Новый фрагмент. Конец.";

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
    beforeText: BEFORE,
    ...overrides
  };
}

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  const from = BEFORE.indexOf("Старый фрагмент");
  return {
    id: "comment-1",
    filePath: "note.md",
    kind: "selection",
    quote: "Старый фрагмент",
    anchor: createAnchor(BEFORE, from, from + "Старый фрагмент".length),
    fromOffset: from,
    toOffset: from + "Старый фрагмент".length,
    feedback: "Перепиши",
    createdAt: "2026-08-16T11:00:00.000Z",
    status: "sent",
    followUps: [],
    ...overrides
  };
}

test("frees the comments of a turn that the shutdown cut off", () => {
  const running = activity();
  const comments = [comment()];

  const finished = finishInterruptedActivity(running, comments, "2026-08-16T12:00:00.000Z", CLOSED, RETURNED);

  assert.equal(finished, true);
  assert.equal(running.status, "interrupted");
  assert.equal(running.error, CLOSED);
  assert.equal(comments[0].status, "draft");
  assert.equal(comments[0].issue?.kind, "interrupted");
});

test("leaves a turn that had already finished alone", () => {
  const done = activity({ status: "completed" });
  const comments = [comment({ status: "addressed" })];

  assert.equal(finishInterruptedActivity(done, comments, "2026-08-16T12:00:00.000Z", CLOSED, RETURNED), false);
  assert.equal(comments[0].status, "addressed");
});

test("fills in which task answered a comment, and only what is missing", () => {
  const activities: ActivityMap = { "note.md": activity({ status: "completed" }) };
  const comments = [comment({ status: "addressed", threadId: "thread-old" })];

  const changed = backfillReviewResponseRoutes(activities, comments);

  assert.equal(changed, true);
  assert.equal(comments[0].threadId, "thread-old");
  assert.equal(comments[0].turnId, "turn-1");
  assert.equal(comments[0].provider, "codex");
  assert.equal(backfillReviewResponseRoutes(activities, comments), false);
});

test("restores the versions a finished turn should have left", () => {
  const activities: ActivityMap = {
    "note.md": activity({ status: "completed", afterText: AFTER, completedAt: "2026-08-16T11:30:00.000Z" })
  };

  const records = backfillVersionsFromActivities(activities);

  assert.deepEqual(records.map((record) => record.source), ["before_codex", "codex"]);
  assert.equal(records[0].text, BEFORE);
  assert.equal(records[1].text, AFTER);
  assert.equal(records[0].originId, "turn-1:before");
});

test("prefers the document texts over the working copy when restoring versions", () => {
  const activities: ActivityMap = {
    "note.md": activity({
      status: "completed",
      afterText: "рабочая копия агента",
      documentTextBefore: BEFORE,
      documentTextAfter: AFTER
    })
  };

  const records = backfillVersionsFromActivities(activities);

  assert.equal(records[1].text, AFTER);
});

test("rebuilds the inline changes of a turn from before they were stored", () => {
  const activities: ActivityMap = {
    "note.md": activity({ status: "completed", afterText: AFTER, completedAt: "2026-08-16T11:30:00.000Z" })
  };
  let index = 0;

  const restored = backfillInlineChangesFromActivities(
    activities,
    [comment({ status: "addressed" })],
    [],
    () => `change-${++index}`
  );

  assert.equal(restored.length > 0, true);
  assert.equal(restored.every((change) => change.commentId === "comment-1"), true);
});

test("never diffs a working copy against the document it was copied from", () => {
  const activities: ActivityMap = {
    "note.md": activity({
      status: "completed",
      afterText: AFTER,
      workingCopyPath: ".obsidian/plugins/codex-review/worktree/a1/note.md"
    })
  };

  const restored = backfillInlineChangesFromActivities(activities, [comment()], [], () => "change-1");

  assert.deepEqual(restored, []);
});

test("does not rebuild changes that are already there or were settled", () => {
  const settled: ActivityMap = {
    "note.md": activity({ status: "completed", afterText: AFTER, inlineChangesSettledAt: "2026-08-16T11:40:00.000Z" })
  };
  const activities: ActivityMap = { "note.md": activity({ status: "completed", afterText: AFTER }) };
  let index = 0;
  const existing = backfillInlineChangesFromActivities(activities, [comment()], [], () => `change-${++index}`);

  assert.deepEqual(backfillInlineChangesFromActivities(settled, [comment()], [], () => "change-x"), []);
  assert.deepEqual(
    backfillInlineChangesFromActivities(activities, [comment()], existing, () => "change-x"),
    []
  );
});
