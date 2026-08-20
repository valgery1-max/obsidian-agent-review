import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewResults } from "../src/review-results";

test("extracts per-comment answers and hides the service block", () => {
  const parsed = parseReviewResults([
    "Файл обновлён.",
    "",
    "<!-- codex-review-results",
    JSON.stringify({
      comments: [
        { id: "one", status: "addressed", response: "Абзац переписан" },
        {
          id: "two",
          status: "needs_attention",
          response: "Подтверждение не найдено",
          requiredAction: "Укажите источник утверждения"
        }
      ]
    }),
    "-->"
  ].join("\n"));

  assert.equal(parsed.visibleText, "Файл обновлён.");
  assert.deepEqual(parsed.comments, [
    { id: "one", status: "addressed", response: "Абзац переписан" },
    {
      id: "two",
      status: "needs_attention",
      response: "Подтверждение не найдено",
      requiredAction: "Укажите источник утверждения"
    }
  ]);
});

test("uses a legacy attention response as the required action", () => {
  const parsed = parseReviewResults([
    "Итог",
    "<!-- codex-review-results",
    JSON.stringify({
      comments: [{ id: "one", status: "needs_attention", response: "Укажите источник" }]
    }),
    "-->"
  ].join("\n"));

  assert.deepEqual(parsed.comments, [{
    id: "one",
    status: "needs_attention",
    response: "Укажите источник",
    requiredAction: "Укажите источник"
  }]);
});

test("keeps the final answer when the service block is malformed", () => {
  const parsed = parseReviewResults("Итог\n<!-- codex-review-results\n{bad json}\n-->");
  assert.equal(parsed.visibleText, "Итог");
  assert.deepEqual(parsed.comments, []);
});
