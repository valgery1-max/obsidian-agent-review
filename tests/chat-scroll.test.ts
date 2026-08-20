import assert from "node:assert/strict";
import test from "node:test";
import { agentChatContentRevision, chatJumpControlState } from "../src/chat-scroll";

test("hides the chat jump control at the bottom", () => {
  assert.deepEqual(chatJumpControlState(true, false), {
    hidden: true,
    unread: false,
    label: "",
    title: "Прокрутить чат вниз"
  });
});

test("shows only an arrow while the user reads older messages", () => {
  assert.deepEqual(chatJumpControlState(false, false), {
    hidden: false,
    unread: false,
    label: "",
    title: "Прокрутить чат вниз"
  });
});

test("labels the control when an unseen agent message exists", () => {
  assert.deepEqual(chatJumpControlState(false, true), {
    hidden: false,
    unread: true,
    label: "Новые сообщения",
    title: "Перейти к новым сообщениям"
  });
});

test("changes the unread revision only for visible agent messages", () => {
  const initial = agentChatContentRevision([
    { id: "u1", author: "user", text: "Первый вопрос" },
    { id: "a1", author: "agent", text: "Первый ответ" }
  ]);
  const afterUserMessage = agentChatContentRevision([
    { id: "u1", author: "user", text: "Первый вопрос" },
    { id: "a1", author: "agent", text: "Первый ответ" },
    { id: "u2", author: "user", text: "Дополнение" }
  ]);
  const afterAgentMessage = agentChatContentRevision([
    { id: "u1", author: "user", text: "Первый вопрос" },
    { id: "a1", author: "agent", text: "Первый ответ" },
    { id: "u2", author: "user", text: "Дополнение" },
    { id: "a2", author: "agent", text: "Новый ответ" }
  ]);

  assert.equal(afterUserMessage, initial);
  assert.notEqual(afterAgentMessage, initial);
});
