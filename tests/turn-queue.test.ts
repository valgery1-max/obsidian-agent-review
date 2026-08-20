import assert from "node:assert/strict";
import test from "node:test";
import {
  isBusyActivity,
  queueAgentMessage,
  queuedReviewNotice,
  rememberSteeringMessage,
  resolveOutgoingMessage,
  returnQueuedMessage,
  takeQueuedMessage,
  type MessageQueues
} from "../src/turn-queue";
import type { AgentProvider, CodexActivity, CodexActivityStatus, QueuedAgentMessage } from "../src/types";

function activity(
  status: CodexActivityStatus,
  provider: AgentProvider = "codex",
  turnId = "turn-1"
): CodexActivity {
  return {
    filePath: "note.md",
    provider,
    threadId: "thread-1",
    turnId,
    taskLabel: "note",
    status,
    source: "conversation",
    startedAt: "2026-08-16T11:00:00.000Z",
    entries: [],
    finalMessage: "",
    itemPhases: {},
    commentIds: [],
    beforeText: ""
  };
}

function message(id: string): QueuedAgentMessage {
  return { id, text: `сообщение ${id}`, createdAt: "2026-08-16T12:00:00.000Z", attachments: [] };
}

test("sends the message straight away when no turn is running", () => {
  assert.equal(resolveOutgoingMessage(undefined).action, "send");
  assert.equal(resolveOutgoingMessage(activity("completed")).action, "send");
  assert.equal(resolveOutgoingMessage(activity("failed")).action, "send");
  assert.equal(isBusyActivity(activity("running")), true);
  assert.equal(isBusyActivity(activity("interrupted")), false);
});

test("asks the user to wait while the turn is still starting", () => {
  const decision = resolveOutgoingMessage(activity("starting", "codex", ""));

  assert.equal(decision.action, "wait");
  assert.equal(/повторите отправку/iu.test(decision.notice ?? ""), true);
});

test("adds the message to the running Codex turn", () => {
  assert.equal(resolveOutgoingMessage(activity("running", "codex")).action, "steer");
});

test("queues the message for Claude, which cannot take one mid-turn", () => {
  const decision = resolveOutgoingMessage(activity("running", "claude"));

  assert.equal(decision.action, "queue");
  assert.equal(decision.notice?.includes("Claude"), true);
});

test("names the agent that will pick up the queued comments", () => {
  assert.equal(queuedReviewNotice(activity("running", "claude")).includes("Claude"), true);
  assert.equal(queuedReviewNotice(activity("running", "codex")).includes("Codex"), true);
});

test("keeps the order of queued messages and empties the entry with the last one", () => {
  const queues: MessageQueues = {};
  queueAgentMessage(queues, "note.md", message("a"));
  queueAgentMessage(queues, "note.md", message("b"));

  assert.equal(takeQueuedMessage(queues, "note.md")?.id, "a");
  assert.equal(queues["note.md"].length, 1);
  assert.equal(takeQueuedMessage(queues, "note.md")?.id, "b");
  assert.equal(Object.prototype.hasOwnProperty.call(queues, "note.md"), false);
  assert.equal(takeQueuedMessage(queues, "note.md"), null);
});

test("puts a message that could not be sent back at the head of the queue", () => {
  const queues: MessageQueues = {};
  queueAgentMessage(queues, "note.md", message("b"));
  const first = message("a");

  returnQueuedMessage(queues, "note.md", first);

  assert.deepEqual(queues["note.md"].map((item) => item.id), ["a", "b"]);
});

test("keeps the extra message in the running turn for the chat to show", () => {
  const running = activity("running");

  rememberSteeringMessage(running, "И ещё выдели команды");
  rememberSteeringMessage(running, "И заголовки");

  assert.deepEqual(running.steeringMessages, ["И ещё выдели команды", "И заголовки"]);
});
