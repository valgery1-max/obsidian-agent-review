import assert from "node:assert/strict";
import test from "node:test";
import { applyCodexNotification, createCodexActivity, interruptCodexActivity } from "../src/activity";

test("streams readable reasoning summaries for the active turn", () => {
  const activity = createCodexActivity("note.md", "thread-1", "note");

  applyCodexNotification(activity, {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } }
  });
  applyCodexNotification(activity, {
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", summaryIndex: 0, delta: "Читаю " }
  });
  applyCodexNotification(activity, {
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", summaryIndex: 0, delta: "файл" }
  });

  assert.equal(activity.status, "running");
  assert.equal(activity.turnId, "turn-1");
  assert.deepEqual(activity.entries.map((entry) => entry.text), ["Читаю файл"]);
});

test("keeps commentary and final answer in separate sections", () => {
  const activity = createCodexActivity("note.md", "thread-1", "note");

  applyCodexNotification(activity, {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary" }
    }
  });
  applyCodexNotification(activity, {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "commentary-1", delta: "Проверяю правки" }
  });
  applyCodexNotification(activity, {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "final-1", text: "Файл обновлён.", phase: "final_answer" }
    }
  });
  applyCodexNotification(activity, {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });

  assert.equal(activity.entries[0].kind, "commentary");
  assert.equal(activity.entries[0].text, "Проверяю правки");
  assert.equal(activity.finalMessage, "Файл обновлён.");
  assert.equal(activity.status, "completed");
});

test("ignores another task and raw reasoning text", () => {
  const activity = createCodexActivity("note.md", "thread-1", "note");

  const anotherThread = applyCodexNotification(activity, {
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-2", turnId: "turn-2", itemId: "reason-2", summaryIndex: 0, delta: "Чужой текст" }
  });
  const rawReasoning = applyCodexNotification(activity, {
    method: "item/reasoning/textDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", contentIndex: 0, delta: "Скрытый текст" }
  });

  assert.equal(anotherThread, false);
  assert.equal(rawReasoning, false);
  assert.deepEqual(activity.entries, []);
});

test("marks an interrupted turn as stopped", () => {
  const activity = createCodexActivity("note.md", "thread-1", "note");
  applyCodexNotification(activity, {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } }
  });

  assert.equal(activity.status, "interrupted");
});

test("marks an activity left by a closed Obsidian session as interrupted", () => {
  const activity = createCodexActivity("note.md", "thread-1", "note");
  const changed = interruptCodexActivity(
    activity,
    "Обработка остановлена из-за закрытия Obsidian.",
    "2026-08-10T20:00:00.000Z"
  );

  assert.equal(changed, true);
  assert.equal(activity.status, "interrupted");
  assert.equal(activity.completedAt, "2026-08-10T20:00:00.000Z");
  assert.equal(activity.error, "Обработка остановлена из-за закрытия Obsidian.");
  assert.equal(interruptCodexActivity(activity, "Повтор"), false);
});
