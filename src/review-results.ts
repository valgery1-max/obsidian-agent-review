import type { CodexReviewCommentResult } from "./types";

const RESULTS_BLOCK = /<!--\s*codex-review-results\s*([\s\S]*?)-->/i;

export interface ParsedReviewResults {
  visibleText: string;
  comments: CodexReviewCommentResult[];
}

export function parseReviewResults(text: string): ParsedReviewResults {
  const match = text.match(RESULTS_BLOCK);
  const visibleText = text.replace(RESULTS_BLOCK, "").trim();
  if (!match) return { visibleText, comments: [] };

  try {
    const value = JSON.parse(match[1].trim()) as { comments?: unknown };
    if (!Array.isArray(value.comments)) return { visibleText, comments: [] };
    const comments = value.comments.flatMap((item): CodexReviewCommentResult[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.id !== "string" || typeof candidate.response !== "string") return [];
      if (candidate.status !== "addressed" && candidate.status !== "needs_attention") return [];
      const response = candidate.response.trim();
      if (!response) return [];
      if (candidate.status === "needs_attention") {
        const requiredAction = typeof candidate.requiredAction === "string"
          ? candidate.requiredAction.trim()
          : "";
        return [{
          id: candidate.id,
          status: "needs_attention",
          response,
          requiredAction: requiredAction || response
        }];
      }
      return [{ id: candidate.id, status: "addressed", response }];
    });
    return { visibleText, comments };
  } catch {
    return { visibleText, comments: [] };
  }
}
