import assert from "node:assert/strict";
import test from "node:test";
import { formatCommentTimestamp } from "../src/comment-time";

test("formats a comment timestamp with date and time", () => {
  assert.equal(formatCommentTimestamp("2026-08-14T13:30:00"), "14.08, 13:30");
});

test("keeps missing and malformed comment timestamps empty", () => {
  assert.equal(formatCommentTimestamp(), "");
  assert.equal(formatCommentTimestamp("unknown"), "");
});
