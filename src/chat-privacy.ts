import {
  formatFeedbackMessage,
  REVIEW_CONFIDENTIAL_INSTRUCTION_FRAGMENTS
} from "./anchors";
import { parseReviewResults } from "./review-results";
import type { CodexChatMessage, FeedbackBatch } from "./types";

const LEGACY_REVIEW_MESSAGE_PREFIXES = [
  "Feedback from Obsidian Agent Review",
  "Feedback from Obsidian Codex Review",
  "Отзыв из Obsidian Codex Review",
  "Continuation of a comment thread from Obsidian Agent Review"
];

const CLAUDE_ATTACHMENT_MARKER = "Files attached by the user. Read them as context before responding:";
const CLAUDE_SKILL_MARKER = "Skills explicitly mentioned by the user. Read each SKILL.md and follow it for this request:";
export const REVIEW_CHAT_COMPLETION_MESSAGE = "Готово. Все комментарии обработаны, ответы добавлены.";
export const REVIEW_CHAT_ATTENTION_MESSAGE = "Обработка завершена. Ответы добавлены; некоторые комментарии требуют вашего внимания.";

export function reviewChatCompletionMessage(rawText: string, fallbackNeedsAttention = false): string {
  const results = parseReviewResults(rawText).comments;
  const needsAttention = results.length > 0
    ? results.some((comment) => comment.status === "needs_attention")
    : fallbackNeedsAttention;
  return needsAttention
    ? REVIEW_CHAT_ATTENTION_MESSAGE
    : REVIEW_CHAT_COMPLETION_MESSAGE;
}

function isFeedbackBatch(value: unknown): value is FeedbackBatch {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FeedbackBatch>;
  return candidate.status === "feedback"
    && candidate.source === "obsidian-codex-review"
    && Array.isArray(candidate.pages)
    && candidate.pages.every((page) =>
      Boolean(page)
      && typeof page === "object"
      && Array.isArray((page as any).comments)
    );
}

function feedbackBatchFromLegacyMessage(text: string): FeedbackBatch | null {
  for (const match of text.matchAll(/```json\s*([\s\S]*?)```/giu)) {
    try {
      const value = JSON.parse(match[1]);
      if (isFeedbackBatch(value)) return value;
    } catch {
      // Continue looking for another valid review payload.
    }
  }
  return null;
}

function displayName(path: string): string {
  return path.trim().split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}

function claudeResourceSummary(text: string): string {
  const attachmentIndex = text.indexOf(CLAUDE_ATTACHMENT_MARKER);
  const skillIndex = text.indexOf(CLAUDE_SKILL_MARKER);
  const indexes = [attachmentIndex, skillIndex].filter((index) => index >= 0);
  if (indexes.length === 0) return text.trim();

  const resourceStart = Math.min(...indexes);
  const userText = text.slice(0, resourceStart).trim();
  const attachments: string[] = [];
  const skills: string[] = [];

  if (attachmentIndex >= 0) {
    const end = skillIndex > attachmentIndex ? skillIndex : text.length;
    for (const line of text.slice(attachmentIndex + CLAUDE_ATTACHMENT_MARKER.length, end).split("\n")) {
      const path = line.match(/^\s*-\s+(.+)$/u)?.[1];
      const name = path ? displayName(path) : "";
      if (name) attachments.push(name);
    }
  }
  if (skillIndex >= 0) {
    for (const line of text.slice(skillIndex + CLAUDE_SKILL_MARKER.length).split("\n")) {
      const name = line.match(/^\s*-\s+(\$[^:\s]+):/u)?.[1];
      if (name) skills.push(name);
    }
  }

  return [
    userText,
    attachments.length > 0 ? `Вложения: ${attachments.join(", ")}` : "",
    skills.length > 0 ? `Навыки: ${skills.join(", ")}` : ""
  ].filter(Boolean).join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactConfidentialInstructions(text: string): string {
  let visible = parseReviewResults(text).visibleText;
  visible = visible.replace(/<!--\s*codex-review-results[\s\S]*$/giu, "");
  for (const fragment of REVIEW_CONFIDENTIAL_INSTRUCTION_FRAGMENTS) {
    visible = visible.replace(new RegExp(escapeRegExp(fragment), "gu"), "");
  }
  visible = visible
    .replace(/(?:Files attached by the user\. Read them as context before responding:|Skills explicitly mentioned by the user\. Read each SKILL\.md and follow it for this request:)\s*(?:\n\s*-\s+[^\n]*)*/giu, "")
    .replace(/```json\s*[\s\S]*?"source"\s*:\s*"obsidian-codex-review"[\s\S]*?```/giu, "")
    .replace(/^.*(?:obsidian-codex-review|codex-review-results|hidden Agent Review turn context).*$/gimu, "")
    .replace(/^.*(?:Agent Review (?:feedback|instructions|comment batches|turn context)|pages\[\]\.comments|developer instructions|system prompt|neighboring paragraphs|outside the requested scope|per-comment results).*$/gimu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return visible;
}

export function visibleChatMessageText(
  kind: CodexChatMessage["kind"],
  rawText: string
): string {
  if (kind === "user") {
    const isLegacyReviewMessage = LEGACY_REVIEW_MESSAGE_PREFIXES.some((prefix) =>
      rawText.trimStart().startsWith(prefix)
    );
    if (isLegacyReviewMessage) {
      const batch = feedbackBatchFromLegacyMessage(rawText);
      return batch ? formatFeedbackMessage(batch) : "Комментарии отправлены в агент";
    }
    return claudeResourceSummary(rawText);
  }
  if (kind === "assistant" && /<!--\s*codex-review-results\b/iu.test(rawText)) {
    if (parseReviewResults(rawText).comments.length > 0) return reviewChatCompletionMessage(rawText);
  }
  return redactConfidentialInstructions(rawText);
}
