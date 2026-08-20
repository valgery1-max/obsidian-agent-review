import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadHistory } from "../src/history";

test("reads user messages, visible reasoning, commentary, and final answers", () => {
  const messages = parseThreadHistory({
    turns: [{
      id: "turn-1",
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Исправь текст" }] },
        { id: "reason-1", type: "reasoning", summary: ["Читаю заметку"] },
        { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "Правлю абзац" },
        { id: "final-1", type: "agentMessage", phase: "final_answer", text: "Готово" }
      ]
    }]
  });

  assert.deepEqual(messages.map((message) => [message.kind, message.text]), [
    ["user", "Исправь текст"],
    ["reasoning", "Читаю заметку"],
    ["commentary", "Правлю абзац"],
    ["assistant", "Готово"]
  ]);
});
