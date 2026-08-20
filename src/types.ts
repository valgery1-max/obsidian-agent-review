export interface TextAnchor {
  prefix: string;
  quote: string;
  suffix: string;
}

export interface ReviewInlineChange {
  id: string;
  filePath: string;
  commentId: string;
  turnId: string;
  oldText: string;
  newText: string;
  anchor: TextAnchor;
  fromOffset: number;
  toOffset: number;
  createdAt: string;
}

export type ReviewVersionSource =
  | "before_codex"
  | "codex"
  | "accepted"
  | "before_cancel"
  | "cancelled"
  | "before_restore"
  | "restored";

export interface ReviewDocumentVersion {
  id: string;
  filePath: string;
  createdAt: string;
  text: string;
  source: ReviewVersionSource;
  originId?: string;
  restoredFromVersionId?: string;
}

export type ReviewCommentKind = "selection" | "document";
export type AgentProvider = "codex" | "claude";
export type ReviewCommentStatus =
  | "draft"
  | "sent"
  | "addressed"
  | "needs_attention"
  | "accepted"
  | "resolved";

export type ReviewCommentFollowUpStatus = "draft" | "sent" | "addressed" | "needs_attention";

export type ReviewCommentIssueKind =
  | "user_input_required"
  | "missing_response"
  | "processing_failed"
  | "interrupted"
  | "partial_changes"
  | "conflicting_changes";

export interface ReviewCommentIssue {
  kind: ReviewCommentIssueKind;
  message: string;
  seenAt?: string;
}

export interface ReviewCommentFollowUp {
  id: string;
  feedback: string;
  createdAt: string;
  status: ReviewCommentFollowUpStatus;
  sentAt?: string;
  threadId?: string;
  turnId?: string;
  provider?: AgentProvider;
  agentResponse?: string;
  respondedAt?: string;
  issue?: ReviewCommentIssue;
}

export interface ReviewComment {
  id: string;
  filePath: string;
  kind: ReviewCommentKind;
  quote: string;
  anchor: TextAnchor;
  fromOffset: number;
  toOffset: number;
  feedback: string;
  createdAt: string;
  status: ReviewCommentStatus;
  sentAt?: string;
  threadId?: string;
  turnId?: string;
  provider?: AgentProvider;
  agentResponse?: string;
  respondedAt?: string;
  issue?: ReviewCommentIssue;
  followUps: ReviewCommentFollowUp[];
}

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  createdAt?: number;
  updatedAt?: number;
  status?: { type?: string; [key: string]: unknown };
}

export interface CodexFileThread {
  threadId: string;
  threadLabel: string;
  createNew?: boolean;
  provider?: AgentProvider;
  cwd?: string;
}

export type AgentScopedValue<T> = Partial<Record<AgentProvider, T>>;

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface CodexSkillOption {
  name: string;
  path: string;
  description?: string;
  scope?: "user" | "repo" | "system" | "admin";
}

export interface CodexLocalAttachment {
  name: string;
  path: string;
  temporary?: boolean;
}

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
}

export type CodexInstructionScope = "file" | "folder" | "vault";

export interface CodexInstructionEntry {
  text: string;
  sourcePaths: string[];
  updatedAt: string;
}

export interface CodexInstructionSettings {
  vault?: CodexInstructionEntry;
  folders: Record<string, CodexInstructionEntry>;
  files: Record<string, CodexInstructionEntry>;
}

export interface CodexReviewSettings {
  codexCommand: string;
  claudeCommand: string;
  threadId: string;
  threadLabel: string;
  fileThreads: Record<string, AgentScopedValue<CodexFileThread>>;
  fileProviders: Record<string, AgentProvider>;
  fileModels: Record<string, AgentScopedValue<string>>;
  fileContexts: Record<string, string[]>;
  fileGoals: Record<string, AgentScopedValue<string>>;
  instructions: CodexInstructionSettings;
}

export type CodexActivityStatus = "starting" | "running" | "completed" | "interrupted" | "failed";

export interface CodexActivityEntry {
  id: string;
  kind: "reasoning" | "commentary";
  text: string;
}

export interface CodexActivity {
  filePath: string;
  provider: AgentProvider;
  threadId: string;
  turnId: string;
  taskLabel: string;
  status: CodexActivityStatus;
  source: "review" | "conversation";
  startedAt: string;
  completedAt?: string;
  entries: CodexActivityEntry[];
  finalMessage: string;
  error?: string;
  itemPhases: Record<string, "commentary" | "final_answer" | "unknown">;
  commentIds: string[];
  /** Snapshot handed to the agent as its working copy when the turn started. */
  beforeText: string;
  /** Working copy as the agent left it. */
  afterText?: string;
  workingCopyPath?: string;
  /** Live document right before the agent edits were transferred into it. */
  documentTextBefore?: string;
  /** Live document right after the transfer. */
  documentTextAfter?: string;
  skippedEditCount?: number;
  anchorsRelocatedAt?: string;
  requestText?: string;
  steeringMessages?: string[];
  model?: string;
  followUpId?: string;
  inlineChangesSettledAt?: string;
}

export interface CodexChatMessage {
  id: string;
  turnId: string;
  kind: "user" | "assistant" | "reasoning" | "commentary";
  text: string;
}

export interface CodexThreadHistory {
  status: "idle" | "loading" | "ready" | "error";
  messages: CodexChatMessage[];
  error?: string;
}

export interface CodexReviewData {
  schemaVersion: number;
  settings: CodexReviewSettings;
  comments: ReviewComment[];
  activities: Record<string, CodexActivity>;
  inlineChanges: ReviewInlineChange[];
  /** Agent edits the user already accepted, kept so that reopening a comment can undo them. */
  appliedChanges: ReviewInlineChange[];
  versions: ReviewDocumentVersion[];
  queuedMessages: Record<string, QueuedAgentMessage[]>;
}

export interface QueuedAgentMessage {
  id: string;
  text: string;
  createdAt: string;
  attachments: CodexLocalAttachment[];
}

export interface FeedbackConversationEntry {
  role: "user" | "codex";
  text: string;
  provider?: AgentProvider;
}

export type FeedbackComment =
  | {
      id: string;
      kind: "selection";
      quote: string;
      anchor: TextAnchor;
      feedback: string;
      parentCommentId?: string;
      conversation?: FeedbackConversationEntry[];
    }
  | {
      id: string;
      kind: "document";
      feedback: string;
      parentCommentId?: string;
      conversation?: FeedbackConversationEntry[];
    };

export interface FeedbackPage {
  file: string;
  comments: FeedbackComment[];
  edits: never[];
}

export interface FeedbackBatch {
  status: "feedback";
  source: "obsidian-codex-review";
  pages: FeedbackPage[];
  contextFiles: string[];
}

export type CodexReviewCommentResult =
  | {
      id: string;
      status: "addressed";
      response: string;
      requiredAction?: never;
    }
  | {
      id: string;
      status: "needs_attention";
      response: string;
      requiredAction: string;
    };
