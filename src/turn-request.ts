import { buildFeedbackBatchForFile, formatFeedbackMessage, formatFeedbackTurnInstructions } from "./anchors";
import { clearFeedbackIssue } from "./comments";
import { commentTaskKind, documentContextInstructions, type ContextMode } from "./document-context";
import { agentTurnInstructions } from "./working-copy";
import type { AgentProvider, FeedbackBatch, ReviewComment } from "./types";

/**
 * What a turn is made of, before anything is sent anywhere.
 *
 * A turn carries two separate things: the message the user sees in the chat, and the hidden
 * context that tells the agent which document it works on, how far to read and how to report
 * back. Both are decided here from the state alone — the host only supplies the texts and the
 * paths it alone can know.
 */

export interface TurnDocument {
  filePath: string;
  /** Live text of the document at the moment the turn starts. */
  text: string;
  /** Where the agent finds the working copy of that text. */
  workingCopyAbsolutePath: string;
  /** Precomputed token estimate, when the host keeps one. */
  tokens?: number;
}

export interface TurnRequestOptions {
  document: TurnDocument;
  documentInstructions?: string;
  /** False once the task already holds messages: the turn continues instead of setting up. */
  firstTurn: boolean;
  mode?: ContextMode;
}

export interface ReviewTurnRequestOptions extends TurnRequestOptions {
  comments: ReviewComment[];
  absolutePath: (path: string) => string;
  contextFiles?: string[];
  /** True when the task already worked on this document and keeps its context. */
  hasDocumentContext: boolean;
}

export interface ReviewTurnRequest {
  batch: FeedbackBatch;
  /** Visible message: the feedback of the user, and nothing else. */
  message: string;
  /** Hidden context of the turn. */
  instructions: string;
  commentIds: string[];
}

export function buildReviewTurnRequest(options: ReviewTurnRequestOptions): ReviewTurnRequest {
  const { document, comments } = options;
  const batch = buildFeedbackBatchForFile(
    comments,
    document.filePath,
    (path) => path === document.filePath ? document.workingCopyAbsolutePath : options.absolutePath(path),
    options.contextFiles ?? []
  );
  const entries = batch.pages.flatMap((page) => page.comments);
  const documentWide = entries.some((comment) => comment.kind === "document");

  return {
    batch,
    message: formatFeedbackMessage(batch),
    instructions: agentTurnInstructions(
      document.filePath,
      document.workingCopyAbsolutePath,
      documentContextInstructions({
        text: document.text,
        tokens: document.tokens,
        kind: documentWide ? "chat_document" : commentTaskKind(entries.map((comment) => comment.feedback)),
        mode: documentWide ? "document" : options.mode,
        firstTurn: options.firstTurn
      }),
      formatFeedbackTurnInstructions(batch, { hasDocumentContext: options.hasDocumentContext }),
      options.documentInstructions
    ),
    commentIds: entries.map((comment) => comment.id)
  };
}

/** A chat message is about the open document as a whole; a selection never scopes it. */
export function buildChatTurnInstructions(options: TurnRequestOptions): string {
  const { document } = options;
  return agentTurnInstructions(
    document.filePath,
    document.workingCopyAbsolutePath,
    documentContextInstructions({
      text: document.text,
      tokens: document.tokens,
      kind: "chat_document",
      mode: "document",
      firstTurn: options.firstTurn
    }),
    options.documentInstructions
  );
}

export interface SentTurn {
  threadId: string;
  turnId: string;
  provider: AgentProvider;
  now: string;
}

/** Moves everything that went into the turn from draft to sent, and clears its earlier issue. */
export function markFeedbackSent(
  comments: ReviewComment[],
  commentIds: readonly string[],
  sent: SentTurn
): void {
  const sentIds = new Set(commentIds);
  for (const comment of comments) {
    const sentMainComment = sentIds.has(comment.id);
    const sentFollowUps = comment.followUps.filter((followUp) => sentIds.has(followUp.id));
    if (!sentMainComment && sentFollowUps.length === 0) continue;
    if (sentMainComment) {
      comment.status = "sent";
      comment.sentAt = sent.now;
      comment.threadId = sent.threadId;
      comment.turnId = sent.turnId;
      comment.provider = sent.provider;
      clearFeedbackIssue(comments, comment.id);
    }
    for (const followUp of sentFollowUps) {
      followUp.status = "sent";
      followUp.sentAt = sent.now;
      followUp.threadId = sent.threadId;
      followUp.turnId = sent.turnId;
      followUp.provider = sent.provider;
      clearFeedbackIssue(comments, followUp.id);
    }
    if (sentFollowUps.length > 0) comment.status = "sent";
  }
}
