import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_CONFIDENTIAL_INSTRUCTION_FRAGMENTS } from "../src/anchors";
import {
  REVIEW_CHAT_ATTENTION_MESSAGE,
  REVIEW_CHAT_COMPLETION_MESSAGE,
  reviewChatCompletionMessage,
  visibleChatMessageText
} from "../src/chat-privacy";

test("renders a legacy review packet as user-authored feedback only", () => {
  const batch = {
    status: "feedback",
    source: "obsidian-codex-review",
    pages: [{
      file: "C:\\TestHome\\Vault\\article.md",
      comments: [{
        id: "secret-comment-id",
        kind: "selection",
        quote: "Выбранный текст",
        anchor: { prefix: "До", quote: "Выбранный текст", suffix: "После" },
        feedback: "Сделайте формулировку точнее"
      }],
      edits: []
    }],
    contextFiles: ["C:\\TestHome\\Vault\\policy.md"]
  };
  const legacy = [
    "Feedback from Obsidian Agent Review. The target Markdown files are already saved on disk.",
    REVIEW_CONFIDENTIAL_INSTRUCTION_FRAGMENTS[0],
    "```json",
    JSON.stringify(batch, null, 2),
    "```"
  ].join("\n");

  const visible = visibleChatMessageText("user", legacy);

  assert.equal(visible, "Сделайте формулировку точнее");
    assert.doesNotMatch(visible, /secret-comment-id|C:\\TestHome|obsidian-codex-review/);
  assert.doesNotMatch(visible, /first feedback batch/i);
});

test("hides Claude resource paths while preserving user-visible names", () => {
  const raw = [
    "Проверьте факты в статье",
    "",
    "Files attached by the user. Read them as context before responding:",
    "- C:\\Private\\Editorial\\policy.pdf",
    "",
    "Skills explicitly mentioned by the user. Read each SKILL.md and follow it for this request:",
    "- $fact-check: C:\\Private\\Skills\\fact-check\\SKILL.md"
  ].join("\n");

  assert.equal(
    visibleChatMessageText("user", raw),
    "Проверьте факты в статье\n\nВложения: policy.pdf\n\nНавыки: $fact-check"
  );
});

test("removes confidential instructions and service data from agent output", () => {
  const secret = REVIEW_CONFIDENTIAL_INSTRUCTION_FRAGMENTS[0];
  const raw = `Работаю с документом.\n${secret}\nГотово.\n<!-- codex-review-results\n{\"comments\":[]}`;

  assert.equal(visibleChatMessageText("reasoning", raw), "Работаю с документом.\n\nГотово.");
});

test("replaces review details with a completion-only chat report", () => {
  const raw = [
    "В статье исправлены формулировки и добавлены источники.",
    "<!-- codex-review-results",
    '{"comments":[{"id":"one","status":"addressed","response":"Подробный ответ"}]}',
    "-->"
  ].join("\n");

  assert.equal(visibleChatMessageText("assistant", raw), REVIEW_CHAT_COMPLETION_MESSAGE);
});

test("reports attention status without exposing review details", () => {
  const raw = [
    "Источник для одного утверждения найти не удалось.",
    "<!-- codex-review-results",
    '{"comments":[{"id":"one","status":"needs_attention","response":"Нужен источник","requiredAction":"Добавьте источник"}]}',
    "-->"
  ].join("\n");

  assert.equal(visibleChatMessageText("assistant", raw), REVIEW_CHAT_ATTENTION_MESSAGE);
});

test("forces a completion-only report for a known review turn without a service block", () => {
  const substantive = "Я переписал вступление и нашёл три исследования по теме.";

  assert.equal(reviewChatCompletionMessage(substantive), REVIEW_CHAT_COMPLETION_MESSAGE);
  assert.equal(reviewChatCompletionMessage(substantive, true), REVIEW_CHAT_ATTENTION_MESSAGE);
});

test("uses the stored service result before a later comment state", () => {
  const addressed = [
    "Содержательный текст",
    "<!-- codex-review-results",
    '{"comments":[{"id":"one","status":"addressed","response":"Ответ"}]}',
    "-->"
  ].join("\n");

  assert.equal(reviewChatCompletionMessage(addressed, true), REVIEW_CHAT_COMPLETION_MESSAGE);
});

test("keeps an ordinary user message unchanged", () => {
  assert.equal(
    visibleChatMessageText("user", "Добавьте к статье два источника"),
    "Добавьте к статье два источника"
  );
});
