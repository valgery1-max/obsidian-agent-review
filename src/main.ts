import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  App,
  Editor,
  FileSystemAdapter,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  addIcon,
  setIcon
} from "obsidian";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import {
  applyCodexNotification,
  bindCodexActivityTurn,
  createCodexActivity,
  failCodexActivity,
  interruptCodexActivity
} from "./activity";
import { agentName, normalizeAgentProvider, type AgentClient } from "./agent-client";
import {
  ClaudeAgentClient,
  ClaudeNotInstalledError,
  ClaudeNotLoggedInError,
  isClaudeLoggedIn,
  resolveClaudeCommand
} from "./claude-client";
import {
  ClipboardAttachmentStore,
  clipboardFiles,
  localPathForFile
} from "./clipboard-attachments";
import {
  buildFeedbackBatchForFile,
  createAnchor,
  locateComment,
  relocateComment
} from "./anchors";
import { reviewChatCompletionMessage, visibleChatMessageText } from "./chat-privacy";
import { agentChatContentRevision, chatJumpControlState, type ChatRevisionEntry } from "./chat-scroll";
import {
  CodexAppServerClient,
  isActiveWriterConflict,
  resolveCodexCommand,
  toUserFacingCodexError
} from "./codex-client";
import { formatCommentTimestamp } from "./comment-time";
import {
  canAddCommentFollowUp,
  clearCommentAttention,
  commentActionAvailability,
  commentHasUnreadAttention,
  commentStatusCountsForFile,
  commentsForFile,
  draftFeedbackCountForFile,
  findFeedbackTarget,
  hasCompletedReviewContext,
  isDraftFollowUp,
  isUnsentDraftComment,
  markCommentAttentionSeen,
  nextCommentInStatus,
  prepareCommentForFollowUp,
  prepareFeedbackForRetry,
  removeDraftFollowUp,
  removeUnsentDraftComment,
  responseAgentProvider,
  reviewTurnIdsForFile,
  reviewTurnNeedsAttention,
  returnFeedbackToDraft,
  updateDraftFollowUp,
  workingAgentProvider
} from "./comments";
import { parseThreadHistory } from "./history";
import {
  activityChangeTurnId,
  relocateTurnCommentAnchors,
  resolveTurnOutcome,
  type TurnOutcome
} from "./turn-outcome";
import { vaultFilePath, workingCopyLocation } from "./working-copy";
import {
  buildChatTurnInstructions,
  buildReviewTurnRequest,
  markFeedbackSent,
  type TurnDocument
} from "./turn-request";
import { estimateTokens } from "./document-context";
import {
  backfillInlineChangesFromActivities,
  backfillReviewResponseRoutes,
  backfillVersionsFromActivities,
  finishInterruptedActivity
} from "./session-restore";
import {
  isBusyActivity,
  queueAgentMessage,
  queuedReviewNotice,
  rememberSteeringMessage,
  resolveOutgoingMessage,
  returnQueuedMessage,
  takeQueuedMessage
} from "./turn-queue";
import {
  createInlineChanges,
  firstOldParagraphForComment,
  groupInlineChangesByParagraph,
  locateInlineChange,
  normalizeInlineChange,
  refreshInlineChangeLocations,
  revertInlineChanges,
  type InlineChangeParagraph
} from "./inline-changes";
import {
  applicableInstructionEntries,
  EMPTY_INSTRUCTION_SETTINGS,
  folderPathForFile,
  formatDocumentInstructions,
  instructionEntryForScope,
  normalizeInstructionSettings,
  reusableFileInstructionPaths,
  saveInstructionEntry
} from "./instructions";
import { createReviewDecorationField, syncReviewDecorations } from "./review-decoration-state";
import { createPendingHighlightField, setPendingHighlight } from "./pending-highlight";
import { reviewScrollbarMetrics } from "./review-scrollbar";
import {
  isReviewMarginCardVisible,
  placeReviewMarginCards,
  reviewMarginCardSize
} from "./review-margin-layout";
import { russianCountForm } from "./plural";
import {
  COMMENT_STATUS_LABELS,
  commentIssueLabel,
  commentStatusLabel,
  isRetryableCommentIssue,
  showsCommentStatus
} from "./comment-labels";
import {
  allFileTaskSelections,
  createNewTaskSelection,
  fileAgentString,
  fileTaskSelection,
  forgetFileAgentString,
  hasExplicitTaskSelection,
  normalizeFileAgentStrings,
  normalizeFileTaskSelections,
  rememberFileAgentString,
  rememberFileTaskSelection,
  sameTaskDirectory,
  taskWorkingDirectory
} from "./task-selection";
import {
  appendDocumentVersion,
  contextualVersionParts,
  createDocumentVersion,
  normalizeDocumentVersion,
  originalVersionId,
  versionsForFile
} from "./versions";
import type {
  AgentProvider,
  CodexActivity,
  CodexFileThread,
  CodexInstructionEntry,
  CodexInstructionScope,
  CodexLocalAttachment,
  CodexModelOption,
  CodexReviewData,
  CodexReviewSettings,
  CodexSkillOption,
  CodexThreadHistory,
  CodexThreadSummary,
  ReviewComment,
  ReviewCommentIssue,
  ReviewDocumentVersion,
  ReviewInlineChange,
  ReviewCommentStatus,
  ReviewVersionSource
} from "./types";

const REVIEW_VIEW_TYPE = "codex-review-sidebar";
const OBSIDIAN_CLOSED_ACTIVITY_MESSAGE = "Обработка остановлена из-за закрытия Obsidian.";
const TEXT_INSTRUCTION_EXTENSIONS = new Set([
  ".csv", ".json", ".md", ".markdown", ".txt", ".xml", ".yaml", ".yml"
]);
const MAX_INLINE_INSTRUCTION_BYTES = 1_000_000;

type BusyThreadChoice = "fork" | "new";
type ThreadDestination = "existing" | "initial" | "fork" | "new";
type InstructionCloudProvider = "google-drive" | "notion";

interface ThreadDispatchResult {
  activity: CodexActivity;
  threadId: string;
  turnId: string;
  destination: ThreadDestination;
}

interface ThreadDispatchOptions {
  attachments?: CodexLocalAttachment[];
  skills?: CodexSkillOption[];
  goal?: string;
  developerInstructions?: string;
  applicationContext?: string;
}

interface EditorSelectionSnapshot {
  filePath: string;
  quote: string;
  from: number;
  to: number;
  text: string;
  editorView: EditorView;
  localTo: number;
}

interface InstructionDraft {
  scope: CodexInstructionScope;
  text: string;
  sourcePaths: string[];
}

interface DocumentInstructionPayload {
  developerInstructions: string;
  attachments: CodexLocalAttachment[];
}

interface CloudInstructionSource {
  provider: InstructionCloudProvider;
  url: string;
}

const DEFAULT_SETTINGS: CodexReviewSettings = {
  codexCommand: "codex",
  claudeCommand: "claude",
  threadId: "",
  threadLabel: "",
  fileThreads: {},
  fileProviders: {},
  fileModels: {},
  fileContexts: {},
  fileGoals: {},
  instructions: structuredClone(EMPTY_INSTRUCTION_SETTINGS)
};

const DEFAULT_DATA: CodexReviewData = {
  schemaVersion: 3,
  settings: DEFAULT_SETTINGS,
  comments: [],
  activities: {},
  inlineChanges: [],
  appliedChanges: [],
  versions: [],
  queuedMessages: {}
};

const MAX_REMEMBERED_APPLIED_CHANGES = 500;

const VERSION_SOURCE_LABELS: Record<ReviewVersionSource, string> = {
  before_codex: "До правок агента",
  codex: "Правки агента",
  accepted: "Принятая редакция",
  before_cancel: "Перед отменой правок",
  cancelled: "Правки отменены",
  before_restore: "Перед восстановлением",
  restored: "Восстановленная версия"
};

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function shortText(value: string, limit = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function toUserFacingAgentError(error: unknown, provider: AgentProvider): Error {
  if (provider === "codex") return toUserFacingCodexError(error);
  return error instanceof Error ? error : new Error(String(error));
}

function renderCommentStatus(parent: HTMLElement, comment: ReviewComment): void {
  if (!showsCommentStatus(comment)) return;
  parent.createDiv({ cls: `codex-review-status is-${comment.status}`, text: commentStatusLabel(comment) });
}

class CommentPointWidget extends WidgetType {
  constructor(
    private readonly comment: ReviewComment,
    private readonly from: number
  ) {
    super();
  }

  eq(other: CommentPointWidget): boolean {
    return this.comment.id === other.comment.id &&
      this.comment.status === other.comment.status &&
      commentHasUnreadAttention(this.comment) === commentHasUnreadAttention(other.comment) &&
      this.comment.feedback === other.comment.feedback &&
      this.from === other.from;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = this.comment.status === "addressed"
      || (this.comment.status === "needs_attention" && !commentHasUnreadAttention(this.comment))
      ? "codex-review-point-anchor"
      : `codex-review-point-anchor is-${this.comment.status}`;
    marker.dataset.codexReviewId = this.comment.id;
    marker.dataset.codexReviewFrom = String(this.from);
    return marker;
  }
}

class InlineChangeWidget extends WidgetType {
  constructor(private readonly change: InlineChangeParagraph) {
    super();
  }

  eq(other: InlineChangeWidget): boolean {
    return this.change.id === other.change.id
      && this.change.oldText === other.change.oldText;
  }

  toDOM(): HTMLElement {
    const comparison = document.createElement("span");
    comparison.className = "codex-review-inline-comparison";
    comparison.dataset.codexReviewChangeId = this.change.changeIds.join(" ");
    comparison.dataset.codexReviewCommentId = this.change.commentIds.join(" ");
    comparison.dataset.codexReviewFrom = String(this.change.from);
    comparison.contentEditable = "false";

    const oldRow = document.createElement("span");
    oldRow.className = "codex-review-inline-row is-old";
    const oldText = document.createElement("span");
    oldText.className = "codex-review-inline-value";
    oldText.textContent = this.change.oldText;
    const preserveTextSelection = (event: Event) => {
      event.stopPropagation();
    };
    oldText.addEventListener("pointerdown", preserveTextSelection);
    oldText.addEventListener("mousedown", preserveTextSelection);
    oldRow.append(oldText);
    const lineBreak = document.createElement("br");
    lineBreak.className = "codex-review-inline-break";
    comparison.append(oldRow, lineBreak);
    return comparison;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function threadLabel(thread: CodexThreadSummary): string {
  return shortText(thread.name || thread.preview || thread.id, 80);
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp * 1000));
}

function formatVersionDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function isTerminalActivity(activity: CodexActivity): boolean {
  return activity.status === "completed" || activity.status === "interrupted" || activity.status === "failed";
}


function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "codex-review-icon-button", attr: { "aria-label": label } });
  button.title = label;
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}

function migrateLegacySkillMention(feedback: string, value: any): string {
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (!name || feedback.includes(`$${name}`)) return feedback;
  return `${feedback}\n\nИспользуй навык $${name} для этой задачи.`;
}

function skillScopeLabel(scope: NonNullable<CodexSkillOption["scope"]>): string {
  if (scope === "user") return "Личный";
  if (scope === "repo") return "Проект";
  if (scope === "admin") return "Администратор";
  return "Системный";
}

function skillDisplayName(name: string): string {
  const separator = name.lastIndexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function normalizeFileProviders(value: unknown): Record<string, AgentProvider> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([filePath, provider]) => [filePath, normalizeAgentProvider(provider)])
  );
}

function cloudInstructionSource(provider: InstructionCloudProvider, url: string): string {
  return `${provider}:${url}`;
}

function parseCloudInstructionSource(value: string): CloudInstructionSource | null {
  for (const provider of ["google-drive", "notion"] as const) {
    const prefix = `${provider}:`;
    if (value.startsWith(prefix)) return { provider, url: value.slice(prefix.length) };
  }
  return null;
}

function normalizeInstructionUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function resolveCssValue(style: CSSStyleDeclaration, value: string, depth = 0): string {
  if (depth >= 8 || !value.includes("var(")) return value.trim();
  const resolved = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/gu,
    (_match, name: string, fallback: string | undefined) => {
      const replacement = style.getPropertyValue(name).trim() || fallback?.trim() || "";
      return replacement ? resolveCssValue(style, replacement, depth + 1) : "";
    }
  );
  return resolved === value ? resolved.trim() : resolveCssValue(style, resolved, depth + 1);
}

function markdownThemeSource(app: App): HTMLElement | null {
  const activePath = app.workspace.getActiveFile()?.path;
  const markdownViews = app.workspace.getLeavesOfType("markdown")
    .map((leaf) => leaf.view)
    .filter((view): view is MarkdownView => view instanceof MarkdownView);
  return markdownViews.find((view) => view.file?.path === activePath)?.containerEl
    ?? markdownViews[0]?.containerEl
    ?? document.querySelector<HTMLElement>('.workspace-leaf-content[data-type="markdown"]');
}

function applyReviewThemeAccent(app: App, target: HTMLElement): void {
  const source = markdownThemeSource(app) ?? document.body;
  const view = source.ownerDocument.defaultView ?? window;
  const style = view.getComputedStyle(source);
  const accent = resolveCssValue(
    style,
    style.getPropertyValue("--interactive-accent").trim()
      || style.getPropertyValue("--color-accent").trim()
  );
  if (!accent) return;
  const textOnAccent = resolveCssValue(style, style.getPropertyValue("--text-on-accent").trim());
  const textNormal = resolveCssValue(style, style.getPropertyValue("--text-normal").trim()) || "#000";
  const hover = `color-mix(in srgb, ${accent} 82%, ${textNormal})`;
  target.style.setProperty("--interactive-accent", accent);
  target.style.setProperty("--interactive-accent-hover", hover);
  target.style.setProperty("--codex-review-accent", accent);
  target.style.setProperty("--codex-review-accent-hover", hover);
  if (textOnAccent) target.style.setProperty("--text-on-accent", textOnAccent);
}

function normalizeFileContexts(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([filePath, paths]) => {
      if (!Array.isArray(paths)) return [];
      const normalized = [...new Set(paths.filter((path): path is string => typeof path === "string" && path.trim() !== ""))];
      return normalized.length > 0 ? [[filePath, normalized]] : [];
    })
  );
}

function normalizeCommentIssue(
  value: unknown,
  status: ReviewCommentStatus | ReviewComment["followUps"][number]["status"],
  agentResponse?: string
): ReviewCommentIssue | undefined {
  const kinds = new Set<ReviewCommentIssue["kind"]>([
    "user_input_required",
    "missing_response",
    "processing_failed",
    "interrupted",
    "partial_changes",
    "conflicting_changes"
  ]);
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (kinds.has(candidate.kind as ReviewCommentIssue["kind"]) && typeof candidate.message === "string") {
      const message = candidate.message.trim();
      if (message) {
        const seenAt = typeof candidate.seenAt === "string" && candidate.seenAt.trim()
          ? candidate.seenAt
          : undefined;
        return seenAt
          ? { kind: candidate.kind as ReviewCommentIssue["kind"], message, seenAt }
          : { kind: candidate.kind as ReviewCommentIssue["kind"], message };
      }
    }
  }
  if (status !== "needs_attention") return undefined;
  if (agentResponse?.trim()) {
    return { kind: "user_input_required", message: agentResponse.trim() };
  }
  return {
    kind: "missing_response",
    message: "Агент не оставил отдельного ответа. Отправьте комментарий повторно или завершите его."
  };
}

function normalizeComment(value: any): ReviewComment {
  const quote = typeof value?.quote === "string" ? value.quote : "";
  const status = Object.prototype.hasOwnProperty.call(COMMENT_STATUS_LABELS, value?.status)
    ? value.status as ReviewCommentStatus
    : "draft";
  const followUps = Array.isArray(value?.followUps)
      ? value.followUps.flatMap((item: any) => {
        if (typeof item?.id !== "string" || typeof item?.feedback !== "string") return [];
        const followUpStatus = ["draft", "sent", "addressed", "needs_attention"].includes(item.status)
          ? item.status as ReviewComment["followUps"][number]["status"]
          : "sent";
        const createdAt = typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString();
        const sentAt = typeof item.sentAt === "string" ? item.sentAt : followUpStatus === "draft" ? undefined : createdAt;
        const agentResponse = typeof item.agentResponse === "string" ? item.agentResponse : undefined;
        return [{
          id: item.id,
          feedback: migrateLegacySkillMention(item.feedback, item.skill),
          createdAt,
          status: followUpStatus,
          sentAt,
          threadId: typeof item.threadId === "string" ? item.threadId : undefined,
          turnId: typeof item.turnId === "string" ? item.turnId : undefined,
          provider: item.provider === "codex" || item.provider === "claude" ? item.provider : undefined,
          agentResponse,
          respondedAt: typeof item.respondedAt === "string"
            ? item.respondedAt
            : agentResponse ? sentAt ?? createdAt : undefined,
          issue: normalizeCommentIssue(item.issue, followUpStatus, agentResponse)
        }];
      })
    : [];
  const createdAt = typeof value?.createdAt === "string" ? value.createdAt : new Date().toISOString();
  const sentAt = typeof value?.sentAt === "string" ? value.sentAt : undefined;
  const agentResponse = typeof value?.agentResponse === "string" ? value.agentResponse : undefined;
  return {
    id: typeof value?.id === "string" ? value.id : makeId(),
    filePath: typeof value?.filePath === "string" ? value.filePath : "",
    kind: value?.kind === "document" ? "document" : "selection",
    quote,
    anchor: value?.anchor && typeof value.anchor === "object"
      ? {
          prefix: typeof value.anchor.prefix === "string" ? value.anchor.prefix : "",
          quote: typeof value.anchor.quote === "string" ? value.anchor.quote : quote,
          suffix: typeof value.anchor.suffix === "string" ? value.anchor.suffix : ""
        }
      : { prefix: "", quote, suffix: "" },
    fromOffset: typeof value?.fromOffset === "number" ? value.fromOffset : 0,
    toOffset: typeof value?.toOffset === "number" ? value.toOffset : quote.length,
    feedback: migrateLegacySkillMention(typeof value?.feedback === "string" ? value.feedback : "", value?.skill),
    createdAt,
    status,
    sentAt,
    threadId: typeof value?.threadId === "string" ? value.threadId : undefined,
    turnId: typeof value?.turnId === "string" ? value.turnId : undefined,
    provider: normalizeAgentProvider(value?.provider),
    agentResponse,
    respondedAt: typeof value?.respondedAt === "string"
      ? value.respondedAt
      : agentResponse ? sentAt ?? createdAt : undefined,
    issue: normalizeCommentIssue(value?.issue, status, agentResponse),
    followUps
  };
}

function normalizeActivity(value: any, filePath: string): CodexActivity {
  return {
    filePath,
    provider: normalizeAgentProvider(value?.provider),
    threadId: typeof value?.threadId === "string" ? value.threadId : "",
    turnId: typeof value?.turnId === "string" ? value.turnId : "",
    taskLabel: typeof value?.taskLabel === "string" ? value.taskLabel : filePath,
    status: ["starting", "running", "completed", "interrupted", "failed"].includes(value?.status)
      ? value.status
      : "failed",
    source: value?.source === "conversation" ? "conversation" : "review",
    startedAt: typeof value?.startedAt === "string" ? value.startedAt : new Date().toISOString(),
    completedAt: typeof value?.completedAt === "string" ? value.completedAt : undefined,
    entries: Array.isArray(value?.entries) ? value.entries : [],
    finalMessage: typeof value?.finalMessage === "string" ? value.finalMessage : "",
    error: typeof value?.error === "string" ? value.error : undefined,
    itemPhases: value?.itemPhases && typeof value.itemPhases === "object" ? value.itemPhases : {},
    commentIds: Array.isArray(value?.commentIds)
      ? value.commentIds.filter((id: unknown): id is string => typeof id === "string")
      : [],
    beforeText: typeof value?.beforeText === "string" ? value.beforeText : "",
    afterText: typeof value?.afterText === "string" ? value.afterText : undefined,
    workingCopyPath: typeof value?.workingCopyPath === "string" ? value.workingCopyPath : undefined,
    documentTextBefore: typeof value?.documentTextBefore === "string" ? value.documentTextBefore : undefined,
    documentTextAfter: typeof value?.documentTextAfter === "string" ? value.documentTextAfter : undefined,
    skippedEditCount: typeof value?.skippedEditCount === "number" ? value.skippedEditCount : undefined,
    anchorsRelocatedAt: typeof value?.anchorsRelocatedAt === "string" ? value.anchorsRelocatedAt : undefined,
    requestText: typeof value?.requestText === "string" ? value.requestText : undefined,
    steeringMessages: Array.isArray(value?.steeringMessages)
      ? value.steeringMessages.filter((message: unknown): message is string => typeof message === "string")
      : [],
    model: typeof value?.model === "string" ? value.model : undefined,
    followUpId: typeof value?.followUpId === "string" ? value.followUpId : undefined,
    inlineChangesSettledAt: typeof value?.inlineChangesSettledAt === "string"
      ? value.inlineChangesSettledAt
      : undefined
  };
}

class CommentModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: CodexReviewPlugin,
    private readonly filePath: string,
    private readonly kind: "selection" | "document",
    private readonly quote: string,
    private readonly initialFeedback: string,
    private readonly onSubmit: (feedback: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-comment-modal");
    const title = this.initialFeedback
      ? "Изменить комментарий"
      : this.kind === "document" ? "Комментарий ко всему документу" : "Комментарий для агента";
    contentEl.createEl("h2", { text: title });
    if (this.kind === "selection") {
      contentEl.createEl("blockquote", { text: shortText(this.quote, 300), cls: "codex-review-modal-quote" });
    }
    const inputWrap = contentEl.createDiv({ cls: "codex-review-skill-mention-host" });
    const input = inputWrap.createEl("textarea", {
      cls: "codex-review-comment-input",
      attr: {
        rows: "6",
        placeholder: "Что нужно изменить?"
      }
    });
    input.value = this.initialFeedback;
    const skillMentions = new SkillMentionAutocomplete(
      input,
      this.plugin,
      () => this.plugin.getFileProvider(this.filePath)
    );
    const insertSkill = iconButton(
      inputWrap,
      "sparkles",
      "Выбрать навык агента",
      () => void skillMentions.startMention()
    );
    insertSkill.addClass("codex-review-skill-trigger");

    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    const cancel = actions.createEl("button", { text: "Отмена" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "Сохранить", cls: "mod-cta" });
    submit.addEventListener("click", () => {
      const feedback = input.value.trim();
      if (!feedback) {
        new Notice("Введите комментарий");
        input.focus();
        return;
      }
      this.onSubmit(feedback);
      this.close();
    });
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit.click();
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class SkillMentionAutocomplete {
  private menu: HTMLElement | null = null;
  private activeIndex = 0;
  private matches: CodexSkillOption[] = [];
  private suppressNextInputUpdate = false;
  private blurTimer: number | null = null;

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly plugin: CodexReviewPlugin,
    private readonly provider: () => AgentProvider = () => plugin.getActiveAgentProvider()
  ) {
    input.addEventListener("input", () => {
      if (this.suppressNextInputUpdate) {
        this.suppressNextInputUpdate = false;
        return;
      }
      void this.update();
    });
    input.addEventListener("keydown", (event) => this.onKeydown(event));
    input.addEventListener("focus", () => {
      if (this.blurTimer !== null) window.clearTimeout(this.blurTimer);
      this.blurTimer = null;
    });
    input.addEventListener("blur", () => {
      this.blurTimer = window.setTimeout(() => {
        this.blurTimer = null;
        this.hide();
      }, 150);
    });
  }

  async startMention(): Promise<void> {
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    this.input.value = `${this.input.value.slice(0, start)}$${this.input.value.slice(end)}`;
    const cursor = start + 1;
    this.input.setSelectionRange(cursor, cursor);
    this.notifyInputChanged();
    this.input.focus();
    await this.update();
  }

  private async update(): Promise<void> {
    const query = this.mentionQuery();
    if (query === null) {
      this.hide();
      return;
    }
    try {
      const skills = await this.plugin.listSkills(false, this.provider());
      if (!this.input.isConnected) return;
      this.matches = skills
        .filter((skill) => `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase("ru").includes(query));
    } catch {
      this.hide();
      return;
    }
    if (this.matches.length === 0) {
      this.hide();
      return;
    }
    this.activeIndex = 0;
    this.render();
  }

  private mentionQuery(): string | null {
    const beforeCursor = this.input.value.slice(0, this.input.selectionStart ?? this.input.value.length);
    const match = beforeCursor.match(/\$([\p{L}\p{N}_:-]*)$/u);
    return match ? match[1].toLocaleLowerCase("ru") : null;
  }

  private render(): void {
    const menu = this.ensureMenu();
    menu.setAttribute("aria-label", `Навыки ${agentName(this.provider())}`);
    menu.empty();
    this.matches.forEach((skill, index) => {
      const row = menu.createEl("button", { cls: "codex-review-skill-mention" });
      if (index === this.activeIndex) row.addClass("is-active");
      setIcon(row.createSpan(), "sparkles");
      const text = row.createSpan({ cls: "codex-review-skill-mention-text" });
      const name = text.createSpan({ cls: "codex-review-skill-mention-name", text: skillDisplayName(skill.name) });
      name.title = skill.name;
      if (skill.description) {
        text.createSpan({ cls: "codex-review-skill-mention-description", text: skill.description });
      }
      if (skill.scope) {
        text.createSpan({ cls: "codex-review-skill-mention-scope", text: skillScopeLabel(skill.scope) });
      }
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insert(skill);
      });
    });
    this.positionMenu(menu);
    const active = menu.querySelector<HTMLElement>(".codex-review-skill-mention.is-active");
    active?.scrollIntoView({ block: "nearest" });
  }

  private onKeydown(event: KeyboardEvent): void {
    if (!this.menu?.isConnected || this.matches.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.activeIndex = (this.activeIndex + delta + this.matches.length) % this.matches.length;
      this.render();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      this.insert(this.matches[this.activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
    }
  }

  private insert(skill: CodexSkillOption): void {
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, cursor);
    const match = before.match(/\$[\p{L}\p{N}_:-]*$/u);
    if (!match) return;
    const from = cursor - match[0].length;
    const mention = `$${skill.name}`;
    this.input.value = `${this.input.value.slice(0, from)}${mention}${this.input.value.slice(cursor)}`;
    const nextCursor = from + mention.length;
    this.input.setSelectionRange(nextCursor, nextCursor);
    this.notifyInputChanged();
    this.hide();
    this.input.focus();
  }

  private ensureMenu(): HTMLElement {
    if (this.menu?.isConnected) return this.menu;
    this.menu = this.input.ownerDocument.body.createDiv({ cls: "codex-review-skill-mentions" });
    applyReviewThemeAccent(this.plugin.app, this.menu);
    this.menu.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    return this.menu;
  }

  private positionMenu(menu: HTMLElement): void {
    const rect = this.input.getBoundingClientRect();
    const viewportWidth = this.input.ownerDocument.defaultView?.innerWidth ?? window.innerWidth;
    const viewportHeight = this.input.ownerDocument.defaultView?.innerHeight ?? window.innerHeight;
    const width = Math.min(560, viewportWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, viewportWidth - width - 12));
    const availableAbove = Math.max(0, rect.top - 12);
    const availableBelow = Math.max(0, viewportHeight - rect.bottom - 12);
    const placeAbove = availableAbove >= 220 || availableAbove >= availableBelow;
    const availableHeight = placeAbove ? availableAbove : availableBelow;

    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${Math.min(360, Math.max(96, availableHeight - 8))}px`;
    if (placeAbove) {
      menu.style.top = "auto";
      menu.style.bottom = `${viewportHeight - rect.top + 8}px`;
    } else {
      menu.style.top = `${rect.bottom + 8}px`;
      menu.style.bottom = "auto";
    }
  }

  private notifyInputChanged(): void {
    this.suppressNextInputUpdate = true;
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private hide(): void {
    this.matches = [];
    this.menu?.remove();
    this.menu = null;
  }
}

class RestoreVersionModal extends Modal {
  constructor(
    app: App,
    private readonly version: ReviewDocumentVersion,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-restore-modal");
    contentEl.createEl("h2", { text: "Восстановить версию" });
    contentEl.createEl("p", {
      text: `Версия от ${formatVersionDate(this.version.createdAt)} будет записана в файл. Текущая редакция сохранится в истории версий.`
    });
    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    const cancel = actions.createEl("button", { text: "Отмена" });
    cancel.addEventListener("click", () => this.close());
    const restore = actions.createEl("button", { cls: "mod-cta codex-review-labeled-button" });
    setIcon(restore.createSpan(), "history");
    restore.createSpan({ text: "Восстановить" });
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } finally {
        restore.disabled = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ClearFileDataModal extends Modal {
  constructor(
    app: App,
    private readonly filePath: string,
    private readonly taskLabel: string | undefined,
    private readonly commentCount: number,
    private readonly versionCount: number,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-clear-modal");
    contentEl.createEl("h2", { text: "Очистить данные файла?" });
    contentEl.createEl("p", {
      text: `Для файла «${this.filePath}» будут удалены комментарии (${this.commentCount}), версии (${this.versionCount}), непринятые правки и история обработки.`
    });
    contentEl.createEl("p", {
      text: this.taskLabel
        ? `Связь с задачей Codex «${this.taskLabel}» будет удалена. Сама задача и её переписка останутся в Codex.`
        : "Markdown-файл и его содержимое останутся без изменений."
    });

    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    actions.createEl("button", { text: "Отмена" }).addEventListener("click", () => this.close());
    const clear = actions.createEl("button", {
      cls: "codex-review-labeled-button codex-review-clear-confirm"
    });
    setIcon(clear.createSpan(), "trash-2");
    clear.createSpan({ text: "Очистить" });
    clear.addEventListener("click", async () => {
      clear.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } finally {
        clear.disabled = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class GoalModal extends Modal {
  constructor(
    app: App,
    private readonly initialGoal: string,
    private readonly onSave: (goal: string) => Promise<boolean>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-goal-modal");
    contentEl.createEl("h2", { text: "Цель задачи" });
    const input = contentEl.createEl("textarea", {
      attr: {
        rows: "5",
        placeholder: "Какого результата должен добиться агент?"
      }
    });
    input.value = this.initialGoal;
    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    const cancel = actions.createEl("button", { text: "Отмена" });
    cancel.addEventListener("click", () => this.close());
    const clear = actions.createEl("button", { text: "Очистить" });
    clear.disabled = !this.initialGoal;
    clear.addEventListener("click", async () => {
      clear.disabled = true;
      if (await this.onSave("")) this.close();
      else clear.disabled = false;
    });
    const save = actions.createEl("button", { text: "Сохранить", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      const goal = input.value.trim();
      if (!goal) {
        input.focus();
        return;
      }
      save.disabled = true;
      if (await this.onSave(goal)) this.close();
      else save.disabled = false;
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class BusyThreadModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly resolve: (choice: BusyThreadChoice | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-busy-modal");
    contentEl.createEl("h2", { text: "Задача занята" });
    contentEl.createEl("p", {
      text: "Задача сейчас занята другим интерфейсом Codex. Чтобы освободить ее, полностью закройте другой интерфейс и убедитесь, что иконка в трее тоже закрыта. Или продолжите в копии задачи."
    });

    const actions = contentEl.createDiv({ cls: "codex-review-busy-actions" });
    const fork = actions.createEl("button", { cls: "mod-cta codex-review-labeled-button" });
    setIcon(fork.createSpan(), "copy");
    fork.createSpan({ text: "Продолжить в копии" });
    fork.addEventListener("click", () => this.choose("fork"));

    const fresh = actions.createEl("button", { cls: "codex-review-labeled-button" });
    setIcon(fresh.createSpan(), "message-square-plus");
    fresh.createSpan({ text: "Создать новую задачу" });
    fresh.addEventListener("click", () => this.choose("new"));
  }

  private choose(choice: BusyThreadChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(choice);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

class LoginModal extends Modal {
  constructor(
    app: App,
    private readonly client: CodexAppServerClient,
    private readonly onComplete: () => void
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-login-modal");
    contentEl.createEl("h2", { text: "Вход в Codex" });
    const status = contentEl.createDiv({ cls: "codex-review-login-status", text: "Получаю код…" });
    try {
      const login = await this.client.startChatGptLogin();
      status.empty();
      status.createEl("div", { text: login.userCode, cls: "codex-review-device-code" });
      const open = status.createEl("button", { text: "Открыть страницу входа", cls: "mod-cta" });
      open.addEventListener("click", () => window.open(login.verificationUrl, "_blank"));
      await navigator.clipboard.writeText(login.userCode);
      window.open(login.verificationUrl, "_blank");

      const stop = this.client.onNotification((message) => {
        if (message.method !== "account/login/completed" || message.params?.loginId !== login.loginId) return;
        stop();
        if (message.params?.success) {
          new Notice("Вход в Codex выполнен");
          this.onComplete();
          this.close();
        } else {
          status.createEl("div", { text: message.params?.error ?? "Вход завершился с ошибкой" });
        }
      });
    } catch (error) {
      status.setText(error instanceof Error ? error.message : String(error));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ClaudeSetupModal extends Modal {
  constructor(
    app: App,
    private readonly error: ClaudeNotInstalledError | ClaudeNotLoggedInError,
    private readonly command: string,
    private readonly onRetry: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Подключение Claude" });
    contentEl.createEl("p", { text: this.error.message });
    const path = contentEl.createDiv({ cls: "codex-review-claude-path" });
    path.createSpan({ text: "Claude Code: " });
    path.createEl("code", { text: resolveClaudeCommand(this.command) });
    contentEl.createEl("p", {
      text: this.error instanceof ClaudeNotInstalledError
        ? "После установки укажите полный путь к исполняемому файлу в настройках Agent Review."
        : "После входа вернитесь в Obsidian и нажмите «Проверить снова»."
    });
    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    const cancel = actions.createEl("button", { text: "Закрыть" });
    cancel.addEventListener("click", () => this.close());
    const retry = actions.createEl("button", { text: "Проверить снова", cls: "mod-cta" });
    retry.addEventListener("click", () => {
      this.close();
      this.onRetry();
    });
  }
}

class ThreadPickerModal extends Modal {
  private threads: CodexThreadSummary[] = [];
  private query = "";
  private listEl: HTMLElement | null = null;
  private selectedThreadId: string | null = null;
  private chooseButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly plugin: CodexReviewPlugin,
    private readonly title: string,
    private readonly onPick: (thread: CodexThreadSummary) => void,
    private readonly onCreateNew: () => void
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-thread-modal");
    const heading = contentEl.createDiv({ cls: "codex-review-thread-heading" });
    heading.createEl("h2", { text: this.title });
    const search = contentEl.createEl("input", {
      cls: "codex-review-thread-search",
      attr: { type: "search", placeholder: "Поиск" }
    });
    search.addEventListener("input", () => {
      this.query = search.value.toLocaleLowerCase("ru");
      this.renderList();
    });
    this.listEl = contentEl.createDiv({ cls: "codex-review-thread-list" });
    this.listEl.setText("Загрузка…");
    const actions = contentEl.createDiv({ cls: "codex-review-thread-actions codex-review-modal-actions" });
    this.chooseButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Выбрать задачу",
      attr: { type: "button" }
    });
    this.chooseButton.disabled = true;
    this.chooseButton.addEventListener("click", () => this.chooseSelectedThread());
    const create = actions.createEl("button", { text: "Новая задача", attr: { type: "button" } });
    create.addEventListener("click", () => this.createThread());
    try {
      const file = this.plugin.getActiveMarkdownFile();
      const provider = file ? this.plugin.getFileProvider(file.path) : "codex";
      this.threads = await this.plugin.getAgentClient(provider).listThreads(this.plugin.getVaultPath());
      const current = file ? this.plugin.getFileThread(file.path, provider) : undefined;
      if (current?.threadId && this.threads.some((thread) => thread.id === current.threadId)) {
        this.selectedThreadId = current.threadId;
      }
      this.renderList();
    } catch (error) {
      this.listEl.setText(error instanceof Error ? error.message : String(error));
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const filtered = this.threads.filter((thread) => {
      const haystack = `${thread.name ?? ""} ${thread.preview ?? ""} ${thread.cwd ?? ""}`.toLocaleLowerCase("ru");
      return haystack.includes(this.query);
    });
    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "codex-review-empty", text: "Задач пока нет" });
      return;
    }
    const file = this.plugin.getActiveMarkdownFile();
    const provider = file ? this.plugin.getFileProvider(file.path) : "codex";
    const vaultPath = this.plugin.getVaultPath();
    const groups: Array<{ label?: string; threads: CodexThreadSummary[] }> = provider === "claude"
      ? [
          {
            label: "Текущая библиотека",
            threads: filtered.filter((thread) => sameTaskDirectory(thread.cwd, vaultPath))
          },
          {
            label: "Другие папки",
            threads: filtered.filter((thread) => !sameTaskDirectory(thread.cwd, vaultPath))
          }
        ]
      : [{ threads: filtered }];
    for (const group of groups) {
      if (group.threads.length === 0) continue;
      if (group.label) this.listEl.createDiv({ cls: "codex-review-thread-section-title", text: group.label });
      for (const thread of group.threads) {
        const selected = thread.id === this.selectedThreadId;
        const row = this.listEl.createEl("button", {
          cls: `codex-review-thread-row${selected ? " is-selected" : ""}`,
          attr: { type: "button", "aria-pressed": String(selected) }
        });
        row.dataset.codexReviewThreadId = thread.id;
        const main = row.createDiv({ cls: "codex-review-thread-main" });
        const title = main.createDiv({ cls: "codex-review-thread-title" });
        title.createSpan({ cls: "codex-review-thread-provider", text: agentName(provider) });
        title.createSpan({ text: threadLabel(thread) });
        if (thread.cwd) main.createDiv({ cls: "codex-review-thread-cwd", text: thread.cwd });
        const stamp = formatDate(thread.updatedAt ?? thread.createdAt);
        if (stamp) row.createDiv({ cls: "codex-review-thread-date", text: stamp });
        row.addEventListener("click", () => {
          this.selectedThreadId = thread.id;
          for (const candidate of this.listEl?.querySelectorAll<HTMLElement>(".codex-review-thread-row") ?? []) {
            const isSelected = candidate.dataset.codexReviewThreadId === thread.id;
            candidate.toggleClass("is-selected", isSelected);
            candidate.setAttribute("aria-pressed", String(isSelected));
          }
          this.syncChooseButton();
        });
      }
    }
    this.syncChooseButton();
  }

  private syncChooseButton(): void {
    if (!this.chooseButton) return;
    this.chooseButton.disabled = !this.selectedThreadId
      || !this.threads.some((thread) => thread.id === this.selectedThreadId);
  }

  private chooseSelectedThread(): void {
    const thread = this.threads.find((candidate) => candidate.id === this.selectedThreadId);
    if (!thread) return;
    this.onPick(thread);
    this.close();
  }

  private createThread(): void {
    this.onCreateNew();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ContextPickerModal extends Modal {
  private query = "";
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly onPick: (file: TFile) => void,
    private readonly title = "Добавить контекст",
    private readonly placeholder = "Найти файл или заметку"
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    contentEl.addClass("codex-review-picker-modal");
    contentEl.createEl("h2", { text: this.title });
    const search = contentEl.createEl("input", {
      cls: "codex-review-picker-search",
      attr: { type: "search", placeholder: this.placeholder }
    });
    search.addEventListener("input", () => {
      this.query = search.value.toLocaleLowerCase("ru");
      this.renderList();
    });
    this.listEl = contentEl.createDiv({ cls: "codex-review-picker-list" });
    this.renderList();
    window.setTimeout(() => search.focus(), 0);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const files = this.files.filter((file) => file.path.toLocaleLowerCase("ru").includes(this.query));
    if (files.length === 0) {
      this.listEl.createDiv({ cls: "codex-review-empty", text: "Подходящих файлов нет" });
      return;
    }
    for (const file of files) {
      const row = this.listEl.createEl("button", { cls: "codex-review-picker-row" });
      const icon = row.createSpan({ cls: "codex-review-picker-icon" });
      setIcon(icon, file.extension.toLocaleLowerCase() === "md" ? "file-text" : "file");
      const text = row.createSpan({ cls: "codex-review-picker-main" });
      text.createSpan({ cls: "codex-review-picker-title", text: file.basename });
      text.createSpan({ cls: "codex-review-picker-path", text: file.path });
      row.addEventListener("click", () => {
        this.onPick(file);
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class InstructionLinkModal extends Modal {
  constructor(
    app: App,
    private readonly provider: InstructionCloudProvider,
    private readonly onAdd: (url: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const label = this.provider === "google-drive" ? "Google Drive" : "Notion";
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    this.modalEl.addClass("codex-review-instruction-link-dialog");
    contentEl.createEl("h2", { text: `Добавить из ${label}` });
    const input = contentEl.createEl("input", {
      cls: "codex-review-instruction-link-input",
      attr: {
        type: "url",
        placeholder: `Вставьте ссылку на документ ${label}`
      }
    });
    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    actions.createEl("button", { text: "Отмена" }).addEventListener("click", () => this.close());
    const add = actions.createEl("button", { cls: "mod-cta", text: "Добавить" });
    const submit = () => {
      const url = normalizeInstructionUrl(input.value);
      if (!url) {
        new Notice("Вставьте корректную ссылку");
        input.focus();
        return;
      }
      this.onAdd(url);
      this.close();
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class InstructionsModal extends Modal {
  private selectedScope: CodexInstructionScope = "file";
  private readonly drafts = new Map<CodexInstructionScope, InstructionDraft>();
  private formEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: CodexReviewPlugin,
    private readonly file: TFile
  ) {
    super(app);
    for (const scope of this.availableScopes()) {
      const entry = plugin.getInstructionEntry(scope, file.path);
      this.drafts.set(scope, {
        scope,
        text: entry?.text ?? "",
        sourcePaths: [...(entry?.sourcePaths ?? [])]
      });
    }
  }

  private availableScopes(): CodexInstructionScope[] {
    return folderPathForFile(this.file.path) ? ["file", "folder", "vault"] : ["file", "vault"];
  }

  onOpen(): void {
    const { contentEl } = this;
    applyReviewThemeAccent(this.app, this.modalEl);
    this.modalEl.addClass("codex-review-instructions-dialog");
    contentEl.addClass("codex-review-instructions-modal");
    contentEl.createEl("h2", { text: "Инструкции для агента" });

    this.formEl = contentEl.createDiv({ cls: "codex-review-instruction-form" });
    this.renderForm();

    const actions = contentEl.createDiv({ cls: "codex-review-modal-actions" });
    actions.createEl("button", { text: "Отмена" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "Сохранить" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await this.plugin.saveInstructionDrafts(this.file.path, [...this.drafts.values()]);
        this.close();
      } finally {
        save.disabled = false;
      }
    });
  }

  private renderForm(): void {
    if (!this.formEl) return;
    this.formEl.empty();
    const draft = this.drafts.get(this.selectedScope);
    if (!draft) return;

    const scopeOptions = this.formEl.createDiv({ cls: "codex-review-instruction-scope-options" });
    const addScopeOption = (scope: "folder" | "vault", label: string): void => {
      const option = scopeOptions.createEl("label", { cls: "codex-review-instruction-scope-option" });
      const checkbox = option.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selectedScope === scope;
      option.createSpan({ text: label });
      checkbox.addEventListener("change", () => {
        this.selectedScope = checkbox.checked ? scope : "file";
        this.renderForm();
      });
    };
    if (folderPathForFile(this.file.path)) {
      addScopeOption("folder", "Применить ко всей папке");
    }
    addScopeOption("vault", "Применить ко всей библиотеке");

    const target = this.selectedScope === "file"
      ? this.file.path
      : this.selectedScope === "folder" ? folderPathForFile(this.file.path) : this.app.vault.getName();
    this.formEl.createDiv({ cls: "codex-review-instruction-target", text: target });
    const reuseActions = this.formEl.createDiv({ cls: "codex-review-instruction-reuse-actions" });
    const reuseSaved = reuseActions.createEl("button", { cls: "codex-review-instruction-add" });
    setIcon(reuseSaved.createSpan(), "copy");
    reuseSaved.createSpan({ text: "Скопировать из другого документа" });
    reuseSaved.addEventListener("click", () => this.openSavedInstructionPicker(draft));

    const inputWrap = this.formEl.createDiv({ cls: "codex-review-instruction-input-wrap" });
    const input = inputWrap.createEl("textarea", {
      cls: "codex-review-instruction-text",
      attr: {
        rows: "10",
        placeholder: "Добавьте правила работы с документами, редакционную политику, референсы и прочее."
      }
    });
    input.value = draft.text;
    input.addEventListener("input", () => {
      draft.text = input.value;
    });

    const sources = this.formEl.createDiv({ cls: "codex-review-instruction-sources" });
    for (const path of draft.sourcePaths) {
      const item = sources.createDiv({ cls: "codex-review-instruction-source" });
      const cloud = parseCloudInstructionSource(path);
      setIcon(item.createSpan(), cloud?.provider === "google-drive"
        ? "hard-drive"
        : cloud?.provider === "notion" ? "notebook-tabs" : "file-text");
      const label = cloud
        ? `${cloud.provider === "google-drive" ? "Google Drive" : "Notion"}: ${cloud.url}`
        : path;
      const name = item.createSpan({ cls: "codex-review-instruction-source-name", text: label });
      name.title = label;
      iconButton(item, "x", `Убрать источник ${label}`, () => {
        draft.sourcePaths = draft.sourcePaths.filter((candidate) => candidate !== path);
        this.renderForm();
      });
    }

    const addActions = this.formEl.createDiv({ cls: "codex-review-instruction-add-actions" });
    const addFromVault = addActions.createEl("button", { cls: "codex-review-instruction-add" });
    setIcon(addFromVault.createSpan(), "library");
    addFromVault.createSpan({ text: "Из библиотеки" });
    addFromVault.addEventListener("click", () => this.openVaultFilePicker(draft));

    const localPicker = addActions.createEl("input", {
      cls: "codex-review-local-file-picker",
      attr: { type: "file", multiple: "" }
    });
    localPicker.addEventListener("change", () => {
      const selected = [...(localPicker.files ?? [])];
      const resolved = selected.flatMap((file) => {
        const path = localPathForFile(file);
        return path ? [path] : [];
      });
      if (resolved.length !== selected.length) {
        new Notice("Не удалось получить локальный путь одного из файлов");
      }
      draft.sourcePaths = [...new Set([...draft.sourcePaths, ...resolved])];
      this.renderForm();
    });
    const addFromComputer = addActions.createEl("button", { cls: "codex-review-instruction-add" });
    setIcon(addFromComputer.createSpan(), "monitor-up");
    addFromComputer.createSpan({ text: "С компьютера" });
    addFromComputer.addEventListener("click", () => localPicker.click());

    const addFromGoogleDrive = addActions.createEl("button", { cls: "codex-review-instruction-add" });
    setIcon(addFromGoogleDrive.createSpan(), "hard-drive");
    addFromGoogleDrive.createSpan({ text: "Из Google Drive" });
    addFromGoogleDrive.addEventListener("click", () => this.openCloudLink(draft, "google-drive"));

    const addFromNotion = addActions.createEl("button", { cls: "codex-review-instruction-add" });
    setIcon(addFromNotion.createSpan(), "notebook-tabs");
    addFromNotion.createSpan({ text: "Из Notion" });
    addFromNotion.addEventListener("click", () => this.openCloudLink(draft, "notion"));
  }

  private openSavedInstructionPicker(draft: InstructionDraft): void {
    const reusablePaths = new Set(reusableFileInstructionPaths(
      this.plugin.data.settings.instructions,
      this.file.path
    ));
    const files = this.app.vault.getMarkdownFiles()
      .filter((candidate) => reusablePaths.has(candidate.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (files.length === 0) {
      new Notice("В других документах пока нет сохранённых инструкций");
      return;
    }
    new ContextPickerModal(
      this.app,
      files,
      (sourceFile) => {
        const source = this.plugin.getInstructionEntry("file", sourceFile.path);
        if (!source) return;
        draft.text = source.text;
        draft.sourcePaths = [...source.sourcePaths];
        this.renderForm();
        new Notice(`Инструкция из «${sourceFile.basename}» добавлена`);
      },
      "Взять инструкцию из другого документа",
      "Найти документ с инструкцией"
    ).open();
  }

  private openCloudLink(draft: InstructionDraft, provider: InstructionCloudProvider): void {
    new InstructionLinkModal(this.app, provider, (url) => {
      draft.sourcePaths = [...new Set([...draft.sourcePaths, cloudInstructionSource(provider, url)])];
      this.renderForm();
    }).open();
  }

  private openVaultFilePicker(draft: InstructionDraft): void {
    const selected = new Set(draft.sourcePaths);
    const files = this.app.vault.getFiles()
      .filter((candidate) => candidate.path !== this.file.path && !selected.has(candidate.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    new ContextPickerModal(
      this.app,
      files,
      (source) => {
        draft.sourcePaths.push(source.path);
        this.renderForm();
      },
      "Добавить файл из библиотеки",
      "Найти файл в библиотеке"
    ).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class EditorReviewSurface {
  private readonly host: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly selectionAction: HTMLButtonElement;
  private readonly editorScrollbar: HTMLElement;
  private readonly editorScrollbarThumb: HTMLElement;
  private scrollbarDrag: { pointerId: number; startY: number; startScrollTop: number } | null = null;
  private footer: HTMLElement | null = null;
  private railCards: HTMLElement | null = null;
  private readonly openFollowUpCommentIds = new Set<string>();
  private readonly followUpDrafts = new Map<string, string>();
  private comments: ReviewComment[] = [];
  private cards = new Map<string, HTMLElement>();
  private filePath: string | null = null;
  private activeCommentId: string | null = null;
  private activeCommentVisibilityRequested = false;
  private activeCommentVisibilityTimer: number | null = null;
  private pendingComment: ReviewComment | null = null;
  private editingCommentId: string | null = null;
  private commentEditorFocusId: string | null = null;
  private commentEditorFocusTimers: number[] = [];
  /** Что уже подсвечено в редакторе, чтобы не слать эффект на каждый перерисов. */
  private highlightedRange: string | null = null;
  /** Ключ запроса на измерение: не даёт накапливать одинаковые запросы за кадр. */
  private readonly activeHighlightMeasureKey = {};
  private isEditingMode: boolean | null = null;
  private isPointerSelecting = false;
  private selectionActionReady = false;
  private renderFrame: number | null = null;
  private layoutFrame: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly onScroll = () => {
    this.syncScrollOffset();
    this.syncEditorScrollbar();
    this.scheduleLayout();
  };
  private readonly onEditorMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    this.isPointerSelecting = true;
    this.selectionActionReady = false;
    this.selectionAction.addClass("is-hidden");
  };
  private readonly onEditorMouseUp = (event: MouseEvent) => {
    if (!this.isPointerSelecting || event.button !== 0) return;
    this.isPointerSelecting = false;
    this.selectionActionReady = true;
    this.scheduleLayout();
    this.plugin.refreshEditorSelectionActions();
  };
  private readonly onWindowBlur = () => {
    if (!this.isPointerSelecting) return;
    this.isPointerSelecting = false;
    this.selectionActionReady = false;
    this.selectionAction.addClass("is-hidden");
  };
  private readonly onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || (!event.deltaX && !event.deltaY)) return;
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.view.scrollDOM.clientHeight : 1;
    const horizontalDelta = event.shiftKey
      ? event.deltaY * scale
      : event.deltaX * scale;
    if (horizontalDelta) {
      this.host.scrollBy({ left: horizontalDelta, behavior: "auto" });
    }
    this.view.scrollDOM.scrollBy({
      left: 0,
      top: event.shiftKey ? 0 : event.deltaY * scale,
      behavior: "auto"
    });
    event.preventDefault();
    event.stopPropagation();
  };

  constructor(
    private readonly view: EditorView,
    private readonly plugin: CodexReviewPlugin
  ) {
    this.host = view.dom.parentElement ?? view.dom;
    this.host.addClass("codex-review-editor-surface");
    this.toolbar = document.createElement("div");
    this.toolbar.className = "codex-review-editor-toolbar";
    this.rail = document.createElement("aside");
    this.rail.className = "codex-review-margin-rail";
    this.selectionAction = document.createElement("button");
    this.selectionAction.className = "codex-review-selection-action";
    this.selectionAction.type = "button";
    this.selectionAction.title = "Добавить комментарий для агента";
    this.selectionAction.setAttribute("aria-label", "Добавить комментарий для агента");
    setIcon(this.selectionAction, "message-square-plus");
    this.selectionAction.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.startSelectionComment();
    });
    this.editorScrollbar = document.createElement("div");
    this.editorScrollbar.className = "codex-review-editor-scrollbar is-hidden";
    this.editorScrollbar.setAttribute("role", "scrollbar");
    this.editorScrollbar.setAttribute("aria-label", "Прокрутка документа");
    this.editorScrollbar.setAttribute("aria-orientation", "vertical");
    this.editorScrollbar.tabIndex = 0;
    this.editorScrollbarThumb = this.editorScrollbar.createDiv({
      cls: "codex-review-editor-scrollbar-thumb"
    });
    this.editorScrollbar.addEventListener("pointerdown", (event) => this.startScrollbarDrag(event));
    this.editorScrollbar.addEventListener("pointermove", (event) => this.moveScrollbarDrag(event));
    this.editorScrollbar.addEventListener("pointerup", (event) => this.endScrollbarDrag(event));
    this.editorScrollbar.addEventListener("pointercancel", (event) => this.endScrollbarDrag(event));
    this.editorScrollbar.addEventListener("keydown", (event) => this.handleScrollbarKeydown(event));
    this.host.insertBefore(this.toolbar, view.dom);
    this.host.append(this.rail);
    this.host.append(this.selectionAction);
    this.host.ownerDocument.body.append(this.editorScrollbar);
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.view.dom.addEventListener("mousedown", this.onEditorMouseDown, { capture: true });
    this.host.ownerDocument.addEventListener("mouseup", this.onEditorMouseUp, { capture: true });
    this.host.ownerDocument.defaultView?.addEventListener("blur", this.onWindowBlur);
    this.rail.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
    this.resizeObserver.observe(this.host);
    this.resizeObserver.observe(this.rail);
    this.resizeObserver.observe(this.view.scrollDOM);
    this.plugin.registerEditorSurface(this);
    this.render();
    this.scheduleRender();
  }

  update(update: ViewUpdate): void {
    const reviewSynced = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(syncReviewDecorations))
    );
    if (update.docChanged) {
      const beforeText = update.startState.doc.toString();
      const afterText = update.state.doc.toString();
      if (this.filePath) this.plugin.trackManualDocumentChange(this.filePath, beforeText, afterText);
      if (this.pendingComment) this.relocatePendingComment(beforeText, afterText);
      this.scheduleLayout();
    }
    // Декорации перестроились — вернуть подсветке активность в этом же кадре.
    if (update.docChanged || reviewSynced) this.scheduleActiveHighlight();
    if (reviewSynced) this.scheduleRender();
    else if (update.viewportChanged || update.geometryChanged) this.scheduleLayout();
    if (update.selectionSet) {
      if (update.state.selection.main.empty) this.selectionActionReady = false;
      else if (!this.isPointerSelecting) this.selectionActionReady = true;
      if (this.isPointerSelecting) this.selectionAction.addClass("is-hidden");
      this.scheduleLayout();
      if (!this.isPointerSelecting) this.plugin.refreshEditorSelectionActions();
    } else if (update.focusChanged) this.scheduleLayout();
  }

  destroy(): void {
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    if (this.layoutFrame !== null) window.cancelAnimationFrame(this.layoutFrame);
    if (this.activeCommentVisibilityTimer !== null) window.clearTimeout(this.activeCommentVisibilityTimer);
    this.clearCommentEditorFocusTimers();
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.dom.removeEventListener("mousedown", this.onEditorMouseDown, { capture: true });
    this.host.ownerDocument.removeEventListener("mouseup", this.onEditorMouseUp, { capture: true });
    this.host.ownerDocument.defaultView?.removeEventListener("blur", this.onWindowBlur);
    this.rail.removeEventListener("wheel", this.onWheel);
    this.resizeObserver.disconnect();
    this.toolbar.remove();
    this.rail.remove();
    this.selectionAction.remove();
    this.editorScrollbar.remove();
    this.footer?.remove();
    this.host.removeClass(
      "codex-review-editor-surface",
      "has-codex-review-file",
      "has-codex-review-sidebar",
      "is-codex-review-preview"
    );
    this.plugin.unregisterEditorSurface(this);
  }

  refresh(): void {
    this.scheduleRender();
  }

  refreshSelectionAction(): void {
    this.scheduleLayout();
  }

  owns(view: EditorView): boolean {
    return this.view === view;
  }

  showsFile(filePath: string): boolean {
    return this.filePath === filePath;
  }

  focusComment(commentId: string, acknowledgeAttention = true): void {
    if (!this.cards.has(commentId)) return;
    this.activateComment(commentId);
    if (acknowledgeAttention) void this.plugin.acknowledgeCommentAttention(commentId);
    this.activeCommentVisibilityRequested = true;
    if (this.activeCommentVisibilityTimer !== null) window.clearTimeout(this.activeCommentVisibilityTimer);
    this.activeCommentVisibilityTimer = window.setTimeout(() => {
      this.activeCommentVisibilityTimer = null;
      if (this.activeCommentId !== commentId) return;
      this.activeCommentVisibilityRequested = true;
      this.scheduleLayout();
    }, 220);
    this.syncActiveComment();
    this.scheduleLayout();
  }

  private activateComment(commentId: string | null): void {
    this.activeCommentId = commentId;
  }

  private activateCommentFromControl(commentId: string): void {
    this.focusComment(commentId);
    const comment = this.comments.find((candidate) => candidate.id === commentId);
    if (comment) void this.plugin.revealComment(comment, false);
  }

  private scheduleRender(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  private scheduleLayout(): void {
    if (this.layoutFrame !== null) return;
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = null;
      this.syncScrollOffset();
      this.syncActiveComment();
      this.syncCompactMessageControls();
      this.layoutCards();
      this.keepActiveCommentVisible();
      this.focusCommentEditorNow();
      this.updateSelectionAction();
      this.syncEditorScrollbar();
    });
  }

  private reviewElementsForComment(commentId: string): HTMLElement[] {
    return [...this.view.dom.querySelectorAll<HTMLElement>(
      "[data-codex-review-id], [data-codex-review-comment-id]"
    )].filter((element) =>
      element.dataset.codexReviewId === commentId
      || element.dataset.codexReviewCommentId?.split(" ").includes(commentId)
    );
  }

  /**
   * Возвращает класс is-active подсветкам в тексте.
   *
   * CodeMirror пересоздаёт элементы подсветки каждый раз, когда перестраивает
   * декорации, — то есть на каждое нажатие клавиши. Класс при этом слетает,
   * поэтому его нужно ставить заново сразу после перестройки, а не кадром позже:
   * иначе оттенок скачет между обычным и активным, и это видно как мигание.
   */
  private applyActiveHighlight(activeId: string | null): void {
    for (const element of this.view.dom.querySelectorAll<HTMLElement>(
      "[data-codex-review-id], [data-codex-review-comment-id]"
    )) {
      const matches = Boolean(activeId && (
        element.dataset.codexReviewId === activeId
        || element.dataset.codexReviewCommentId?.split(" ").includes(activeId)
      ));
      element.toggleClass("is-active", matches);
    }
  }

  /** Ставит класс в фазе измерения CodeMirror — до отрисовки, без мигания. */
  private scheduleActiveHighlight(): void {
    this.view.requestMeasure({
      key: this.activeHighlightMeasureKey,
      read: () => this.activeCommentId,
      write: (activeId) => this.applyActiveHighlight(activeId)
    });
  }

  private syncActiveComment(): void {
    const activeId = this.activeCommentId;
    const activeExists = Boolean(activeId && this.comments.some((comment) => comment.id === activeId));
    if (activeId && !activeExists) this.activateComment(null);
    const currentId = activeExists ? activeId : null;
    for (const [id, card] of this.cards) {
      const active = id === currentId;
      card.toggleClass("is-editor-target", active);
      card.toggleClass("is-collapsed", !active && !card.hasClass("is-composer"));
      card.setAttribute("aria-expanded", String(active || card.hasClass("is-composer")));
    }
    this.applyActiveHighlight(currentId);
  }

  private syncCompactMessageControls(): void {
    for (const card of this.cards.values()) {
      const collapsed = card.hasClass("is-collapsed");
      for (const message of card.querySelectorAll<HTMLElement>(".codex-review-thread-message")) {
        const toggle = message.querySelector<HTMLElement>(".codex-review-comment-message-expand");
        if (!toggle) continue;
        const visible = collapsed && message.hasClass("is-compact-visible");
        if (!visible) {
          toggle.addClass("is-hidden");
          continue;
        }
        const content = message.querySelector<HTMLElement>(".codex-review-comment-message-text");
        const overflows = Boolean(content && content.scrollHeight > content.clientHeight + 1);
        toggle.toggleClass("is-hidden", !overflows);
      }
    }
  }

  private keepActiveCommentVisible(): void {
    if (!this.activeCommentVisibilityRequested) return;
    this.activeCommentVisibilityRequested = false;
    const card = this.activeCommentId ? this.cards.get(this.activeCommentId) : null;
    if (!card) return;

    const viewport = this.rail.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const padding = 8;
    const safeTop = viewport.top + padding;
    const safeBottom = viewport.bottom - padding;
    let scrollDelta = 0;
    if (cardRect.height >= safeBottom - safeTop) {
      scrollDelta = cardRect.top - safeTop;
    } else if (cardRect.top < safeTop) {
      scrollDelta = cardRect.top - safeTop;
    } else if (cardRect.bottom > safeBottom) {
      scrollDelta = cardRect.bottom - safeBottom;
    }
    if (Math.abs(scrollDelta) < 1) return;
    this.view.scrollDOM.scrollBy({ top: scrollDelta, behavior: "smooth" });
  }

  /** Держит жёлтую подсветку в редакторе в согласии с тем, к чему пишется комментарий. */
  private syncPendingHighlight(): void {
    const pending = this.pendingComment;
    const key = pending ? `${pending.fromOffset}:${pending.toOffset}` : null;
    if (key === this.highlightedRange) return;
    this.highlightedRange = key;
    this.view.dispatch({
      effects: setPendingHighlight.of(
        pending ? {
          from: pending.fromOffset,
          to: pending.toOffset,
          commentId: pending.id
        } : null
      )
    });
  }

  private relocatePendingComment(beforeText: string, afterText: string): void {
    const pending = this.pendingComment;
    if (!pending || pending.kind !== "selection") return;
    const location = relocateComment(beforeText, afterText, pending);
    if (!location) return;
    pending.fromOffset = location.from;
    pending.toOffset = location.to;
    pending.quote = afterText.slice(location.from, location.to);
    pending.anchor = createAnchor(afterText, location.from, location.to);
    this.highlightedRange = `${location.from}:${location.to}`;
  }

  private render(): void {
    const isEditing = this.plugin.isPrimaryMarkdownEditor(this.view) && this.plugin.isEditorMode(this.view);
    const modeChanged = this.isEditingMode !== null && this.isEditingMode !== isEditing;
    this.isEditingMode = isEditing;
    this.host.toggleClass("is-codex-review-preview", !isEditing);
    const nextFilePath = isEditing ? this.plugin.getEditorFilePath(this.view) : null;
    if (this.filePath !== nextFilePath) {
      this.pendingComment = null;
      this.editingCommentId = null;
      this.commentEditorFocusId = null;
      this.activateComment(null);
      this.clearCommentEditorFocusTimers();
    }
    this.filePath = nextFilePath;
    this.host.toggleClass("has-codex-review-file", Boolean(this.filePath));
    this.host.toggleClass("has-codex-review-sidebar", this.plugin.isReviewSidebarVisible());
    applyReviewThemeAccent(this.plugin.app, this.host);
    this.toolbar.empty();
    for (const card of this.cards.values()) this.resizeObserver.unobserve(card);
    this.rail.empty();
    this.footer?.remove();
    this.footer = null;
    this.railCards = null;
    this.cards.clear();
    if (modeChanged) this.plugin.refreshSidebar();
    if (!this.filePath) {
      this.comments = [];
      this.activateComment(null);
      this.syncPendingHighlight();
      this.syncEditorScrollbar();
      return;
    }

    const text = this.view.state.doc.toString();
    const savedComments = commentsForFile(this.plugin.data.comments, this.filePath, "active", text);
    this.comments = [...savedComments];
    if (this.pendingComment?.filePath === this.filePath) {
      this.comments.push(this.pendingComment);
      this.comments.sort((left, right) =>
        this.anchorPosition(left, text) - this.anchorPosition(right, text)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      );
    }
    if (this.activeCommentId && !this.comments.some((comment) => comment.id === this.activeCommentId)) {
      this.activateComment(null);
    }
    this.syncPendingHighlight();
    this.renderToolbar(this.filePath);
    this.renderCommentRail(this.filePath);
    for (const comment of this.comments) {
      try {
        this.renderComment(comment);
      } catch (error) {
        console.error("Codex Review could not render a margin comment", error);
        const failed = (this.railCards ?? this.rail).createDiv({ cls: "codex-review-margin-render-error" });
        failed.createDiv({ text: "Не удалось показать комментарий" });
        failed.title = error instanceof Error ? error.message : String(error);
      }
    }
    this.scheduleLayout();
    this.scheduleCommentEditorFocus();
  }

  private clearCommentEditorFocusTimers(): void {
    for (const timer of this.commentEditorFocusTimers) window.clearTimeout(timer);
    this.commentEditorFocusTimers = [];
  }

  /** Фокусирует окончательный textarea после синхронной и отложенной перерисовки CodeMirror. */
  private scheduleCommentEditorFocus(): void {
    this.clearCommentEditorFocusTimers();
    const commentId = this.commentEditorFocusId;
    if (!commentId || !this.railCards) return;

    const focusLatestEditor = (finalAttempt: boolean): void => {
      if (this.commentEditorFocusId !== commentId) return;
      const focused = this.focusCommentEditorNow();
      if (finalAttempt && !focused && this.commentEditorFocusId === commentId) {
        this.commentEditorFocusId = null;
      }
    };

    for (const delay of [0, 80, 250, 500]) {
      const timer = window.setTimeout(() => focusLatestEditor(delay === 500), delay);
      this.commentEditorFocusTimers.push(timer);
    }
  }

  private focusCommentEditorNow(): boolean {
    const commentId = this.commentEditorFocusId;
    if (!commentId || !this.railCards) return false;
    const card = this.cards.get(commentId);
    if (!card || card.hasClass("is-outside-viewport")) return false;
    const input = [...card.querySelectorAll<HTMLTextAreaElement>("textarea[data-comment-editor-id]")]
      .find((candidate) => candidate.dataset.commentEditorId === commentId);
    if (!input) return false;

    input.focus();
    if (input.ownerDocument.activeElement !== input) return false;
    input.setSelectionRange(input.value.length, input.value.length);
    this.commentEditorFocusId = null;
    this.clearCommentEditorFocusTimers();
    return true;
  }

  private renderToolbar(filePath: string): void {
    const main = this.toolbar.createDiv({ cls: "codex-review-editor-toolbar-main" });
    const identity = main.createDiv({ cls: "codex-review-editor-identity" });
    setIcon(identity.createSpan(), "file-diff");
    identity.createSpan({ text: "Agent Review" });

    const quickActions = main.createDiv({ cls: "codex-review-editor-quick-actions" });
    let selectionCommentPointerAt = 0;
    const selectionComment = iconButton(quickActions, "message-square-plus", "Комментарий к выделению", () => {
      if (Date.now() - selectionCommentPointerAt < 500) return;
      this.startSelectionComment();
    });
    selectionComment.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      selectionCommentPointerAt = Date.now();
      this.startSelectionComment();
    });
    iconButton(quickActions, "file-pen-line", "Комментарий ко всему документу", () => this.plugin.addDocumentComment());
    const instructions = iconButton(quickActions, "book-open-check", "Инструкции для агента", () => this.plugin.openInstructions());
    if (this.plugin.hasDocumentInstructions(filePath)) instructions.addClass("is-configured");
    const provider = main.createEl("select", {
      cls: "codex-review-editor-provider",
      attr: { "aria-label": "Агент", title: "Агент для текущего файла" }
    });
    provider.createEl("option", { value: "codex", text: "Codex" });
    provider.createEl("option", { value: "claude", text: "Claude" });
    provider.value = this.plugin.getFileProvider(filePath);
    provider.addEventListener("change", () => void this.plugin.setFileProvider(filePath, normalizeAgentProvider(provider.value)));
    const target = main.createEl("button", { cls: "codex-review-editor-target" });
    setIcon(target.createSpan(), "messages-square");
    const selected = this.plugin.getFileThread(filePath);
    const taskPrompt = "Выберите или создайте задачу для файла";
    target.createSpan({ text: selected?.threadLabel ?? taskPrompt });
    target.title = selected ? `Выбор задачи: ${selected.threadLabel}` : taskPrompt;
    if (!hasExplicitTaskSelection(selected)) target.addClass("is-unselected");
    target.addEventListener("click", () => this.plugin.chooseThread());

    const model = main.createEl("select", {
      cls: "codex-review-editor-model",
      attr: { "aria-label": "Модель агента", title: "Модель агента" }
    });
    const selectedModel = this.plugin.getFileModel(filePath);
    const models = this.plugin.getModels();
    const defaultModel = models.find((option) => option.isDefault);
    model.createEl("option", {
      value: "",
      text: defaultModel?.displayName ?? "Определяю модель…"
    });
    if (selectedModel && !models.some((option) => option.model === selectedModel)) {
      model.createEl("option", { value: selectedModel, text: selectedModel });
    }
    for (const option of models) {
      const element = model.createEl("option", { value: option.model, text: option.displayName });
      element.title = option.description ?? option.displayName;
    }
    model.value = selectedModel;
    model.addEventListener("change", () => void this.plugin.setFileModel(filePath, model.value));

    const destinations = main.createDiv({ cls: "codex-review-editor-destinations" });
    iconButton(destinations, "message-square-text", "Чат", () => void this.plugin.activateSidebar("history"));
    iconButton(destinations, "history", "Версии", () => void this.plugin.activateSidebar("versions"));
    iconButton(destinations, "messages-square", "Все комментарии", () => void this.plugin.activateSidebar("comments"));

    this.renderToolbarStatus(filePath);
  }

  private renderToolbarStatus(filePath: string): void {
    const counts = commentStatusCountsForFile(this.plugin.data.comments, filePath);
    const status = this.toolbar.createDiv({
      cls: "codex-review-editor-status",
      attr: { "aria-live": "polite" }
    });
    const addStatus = (
      icon: string,
      title: string,
      className: string,
      count?: number,
      action?: () => void
    ): HTMLElement => {
      const item = action
        ? status.createEl("button", { cls: `codex-review-editor-status-item ${className}` })
        : status.createSpan({ cls: `codex-review-editor-status-item ${className}` });
      if (item instanceof HTMLButtonElement) item.type = "button";
      item.title = title;
      item.setAttribute("aria-label", title);
      setIcon(item.createSpan({ cls: "codex-review-editor-status-icon" }), icon);
      if (count !== undefined) item.createSpan({ cls: "codex-review-editor-status-count", text: String(count) });
      if (action) item.addEventListener("click", action);
      return item;
    };
    const busy = isBusyActivity(this.plugin.data.activities[filePath]);
    if (busy) {
      const provider = this.plugin.data.activities[filePath]?.provider ?? this.plugin.getFileProvider(filePath);
      addStatus("clock-3", `${agentName(provider)} обрабатывает пакет комментариев`, "is-processing");
    }
    if (counts.ready > 0) {
      const form = this.russianCountForm(counts.ready, "комментарий готов", "комментария готовы", "комментариев готовы");
      addStatus(
        "hourglass",
        `${counts.ready} ${form} к отправке`,
        "is-ready",
        counts.ready,
        () => this.navigateToNextStatusComment("ready")
      );
    }
    if (counts.attention > 0) {
      const form = this.russianCountForm(
        counts.attention,
        "комментарий требует",
        "комментария требуют",
        "комментариев требуют"
      );
      addStatus(
        "triangle-alert",
        `${counts.attention} ${form} вашего внимания`,
        "is-attention",
        counts.attention,
        () => this.navigateToNextStatusComment("attention")
      );
    }
    if (!busy && counts.ready === 0 && counts.attention === 0) {
      const hasComments = counts.total > 0;
      addStatus(
        hasComments ? "circle-check" : "message-square",
        hasComments ? "Все комментарии обработаны" : "Комментариев пока нет",
        "is-complete"
      );
    }
    if (this.plugin.hasInlineChangesForFile(filePath)) {
      const acceptAll = iconButton(status, "check-check", "Принять все правки", () => void this.plugin.acceptAllChanges(filePath));
      acceptAll.addClass("codex-review-accept-all");
    }
  }

  private navigateToNextStatusComment(status: "ready" | "attention"): void {
    const next = nextCommentInStatus(this.comments, status, this.activeCommentId);
    if (next) this.activateCommentFromControl(next.id);
  }

  private renderCommentRail(filePath: string): void {
    this.railCards = this.rail.createDiv({ cls: "codex-review-margin-canvas" });
    const draftCount = draftFeedbackCountForFile(this.plugin.data.comments, filePath);
    if (draftCount === 0) return;
    const footer = this.host.createDiv({ cls: "codex-review-margin-footer" });
    this.footer = footer;
    const activity = this.plugin.data.activities[filePath];
    const send = footer.createEl("button", { cls: "codex-review-margin-send mod-cta" });
    setIcon(send.createSpan({ cls: "codex-review-margin-send-icon" }), "send");
    const agent = agentName(this.plugin.getFileProvider(filePath));
    send.createSpan({
      cls: "codex-review-margin-send-count",
      text: String(draftCount),
      attr: { "aria-hidden": "true" }
    });
    const countForm = this.russianCountForm(draftCount, "комментарий", "комментария", "комментариев");
    send.setAttribute("aria-label", `Отправить ${draftCount} ${countForm} в ${agent}`);
    send.title = `Отправить ${draftCount} ${countForm} в ${agent}`;
    send.disabled = draftCount === 0;
    if (isBusyActivity(activity)) {
      send.title = `Поставить ${draftCount} ${countForm} в очередь. Остановить обработку можно во вкладке «Чат»`;
    }
    send.addEventListener("click", () => void this.plugin.sendFeedback());
  }

  private syncEditorScrollbar(): void {
    const scrollDOM = this.view.scrollDOM;
    const hostRect = this.host.getBoundingClientRect();
    const scrollRect = scrollDOM.getBoundingClientRect();
    const top = Math.max(hostRect.top, scrollRect.top);
    const bottom = Math.min(hostRect.bottom, scrollRect.bottom);
    const trackHeight = Math.max(0, bottom - top);
    const isVisible = Boolean(this.filePath)
      && this.isEditingMode === true
      && scrollDOM.scrollHeight > scrollDOM.clientHeight + 1
      && hostRect.width > 0
      && trackHeight >= 40
      && hostRect.right > 0
      && hostRect.left < window.innerWidth;

    this.editorScrollbar.toggleClass("is-hidden", !isVisible);
    if (!isVisible) return;

    const right = Math.min(window.innerWidth, hostRect.right);
    this.editorScrollbar.style.left = `${Math.round(right - 8)}px`;
    this.editorScrollbar.style.top = `${Math.round(top)}px`;
    this.editorScrollbar.style.height = `${Math.round(trackHeight)}px`;

    const metrics = reviewScrollbarMetrics(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      trackHeight
    );
    this.editorScrollbarThumb.style.height = `${metrics.thumbHeight}px`;
    this.editorScrollbarThumb.style.transform = `translateY(${metrics.thumbOffset}px)`;
    this.editorScrollbar.setAttribute("aria-valuemin", "0");
    this.editorScrollbar.setAttribute("aria-valuemax", String(Math.round(metrics.scrollRange)));
    this.editorScrollbar.setAttribute("aria-valuenow", String(Math.round(scrollDOM.scrollTop)));
  }

  private startScrollbarDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const scrollDOM = this.view.scrollDOM;
    if (event.target !== this.editorScrollbarThumb) {
      const rect = this.editorScrollbar.getBoundingClientRect();
      const metrics = reviewScrollbarMetrics(
        scrollDOM.scrollTop,
        scrollDOM.scrollHeight,
        scrollDOM.clientHeight,
        rect.height
      );
      const requestedOffset = event.clientY - rect.top - metrics.thumbHeight / 2;
      const progress = metrics.thumbTravel > 0
        ? Math.min(1, Math.max(0, requestedOffset / metrics.thumbTravel))
        : 0;
      scrollDOM.scrollTop = progress * metrics.scrollRange;
      this.syncEditorScrollbar();
    }
    this.scrollbarDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollDOM.scrollTop
    };
    this.editorScrollbar.setPointerCapture(event.pointerId);
    this.editorScrollbar.addClass("is-dragging");
  }

  private moveScrollbarDrag(event: PointerEvent): void {
    if (!this.scrollbarDrag || this.scrollbarDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scrollDOM = this.view.scrollDOM;
    const metrics = reviewScrollbarMetrics(
      this.scrollbarDrag.startScrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      this.editorScrollbar.getBoundingClientRect().height
    );
    if (metrics.thumbTravel <= 0) return;
    const scrollDelta = (event.clientY - this.scrollbarDrag.startY)
      * (metrics.scrollRange / metrics.thumbTravel);
    scrollDOM.scrollTop = this.scrollbarDrag.startScrollTop + scrollDelta;
  }

  private endScrollbarDrag(event: PointerEvent): void {
    if (!this.scrollbarDrag || this.scrollbarDrag.pointerId !== event.pointerId) return;
    this.scrollbarDrag = null;
    this.editorScrollbar.removeClass("is-dragging");
    if (this.editorScrollbar.hasPointerCapture(event.pointerId)) {
      this.editorScrollbar.releasePointerCapture(event.pointerId);
    }
  }

  private handleScrollbarKeydown(event: KeyboardEvent): void {
    const scrollDOM = this.view.scrollDOM;
    let nextScrollTop: number | null = null;
    if (event.key === "ArrowUp") nextScrollTop = scrollDOM.scrollTop - 40;
    else if (event.key === "ArrowDown") nextScrollTop = scrollDOM.scrollTop + 40;
    else if (event.key === "PageUp") nextScrollTop = scrollDOM.scrollTop - scrollDOM.clientHeight;
    else if (event.key === "PageDown") nextScrollTop = scrollDOM.scrollTop + scrollDOM.clientHeight;
    else if (event.key === "Home") nextScrollTop = 0;
    else if (event.key === "End") nextScrollTop = scrollDOM.scrollHeight;
    if (nextScrollTop === null) return;
    event.preventDefault();
    scrollDOM.scrollTop = nextScrollTop;
  }

  private russianCountForm(count: number, one: string, few: string, many: string): string {
    return russianCountForm(count, one, few, many);
  }

  private renderComment(comment: ReviewComment): void {
    if (!this.railCards) return;
    const attentionSeenClass = comment.status === "needs_attention" && !commentHasUnreadAttention(comment)
      ? " is-attention-seen"
      : "";
    const card = this.railCards.createDiv({
      cls: `codex-review-margin-card codex-review-card is-${comment.status} is-outside-viewport${
        this.activeCommentId === comment.id ? " is-editor-target" : ""
      }${this.activeCommentId !== comment.id ? " is-collapsed" : ""}${attentionSeenClass}`,
      attr: {
        role: "article",
        tabindex: "0",
        "aria-expanded": String(this.activeCommentId === comment.id)
      }
    });
    card.dataset.codexReviewCommentId = comment.id;
    this.cards.set(comment.id, card);
    this.resizeObserver.observe(card);
    this.bindCardNavigation(card, comment);

    if (this.pendingComment?.id === comment.id) {
      this.renderPendingComment(card, comment);
      return;
    }
    if (this.editingCommentId === comment.id) {
      this.renderDraftCommentEditor(card, comment);
      return;
    }

    const top = card.createDiv({ cls: "codex-review-margin-card-top" });
    const meta = top.createDiv({ cls: "codex-review-margin-card-meta" });
    const created = meta.createEl("time", { text: formatCommentTimestamp(comment.createdAt) });
    created.dateTime = comment.createdAt;
    const actions = top.createDiv({ cls: "codex-review-card-actions" });
    this.renderCommentActions(actions, comment);

    const threadMessages: HTMLElement[] = [];
    threadMessages.push(this.renderThreadMessage(
      card,
      "user",
      comment.feedback,
      comment.filePath,
      comment.provider,
      `${comment.id}:comment`
    ));
    if (comment.agentResponse) {
      threadMessages.push(this.renderThreadMessage(
        card,
        "codex",
        comment.agentResponse,
        comment.filePath,
        responseAgentProvider(comment),
        `${comment.id}:response`,
        false,
        undefined,
        comment.respondedAt
      ));
    }
    if (comment.issue) this.renderCommentIssue(card, comment.issue);
    for (const followUp of comment.followUps) {
      threadMessages.push(this.renderThreadMessage(
        card,
        "user",
        followUp.feedback,
        comment.filePath,
        comment.provider,
        `${comment.id}:${followUp.id}:comment`,
        isDraftFollowUp(followUp),
        isDraftFollowUp(followUp) ? (messageActions) => {
          iconButton(
            messageActions,
            "pencil",
            "Изменить дополнительный комментарий",
            () => this.plugin.editCommentFollowUp(comment.id, followUp.id)
          );
          const remove = iconButton(
            messageActions,
            "trash-2",
            "Удалить дополнительный комментарий",
            () => void this.plugin.deleteCommentFollowUp(comment.id, followUp.id)
          );
          remove.addClass("is-delete");
        } : undefined,
        followUp.createdAt
      ));
      if (followUp.agentResponse) {
        threadMessages.push(this.renderThreadMessage(
          card,
          "codex",
          followUp.agentResponse,
          comment.filePath,
          responseAgentProvider(comment, followUp),
          `${comment.id}:${followUp.id}:response`,
          false,
          undefined,
          followUp.respondedAt
        ));
      }
      if (followUp.issue) this.renderCommentIssue(card, followUp.issue);
    }

    threadMessages.forEach((message, index) => message.toggleClass("is-compact-visible", index < 2));
    const hiddenReplyCount = Math.max(0, threadMessages.length - 2);
    if (hiddenReplyCount > 0) {
      const row = card.createDiv({ cls: "codex-review-comment-thread-toggle-row" });
      const replyForm = this.russianCountForm(hiddenReplyCount, "ответ", "ответа", "ответов");
      const toggle = row.createEl("button", {
        cls: "codex-review-comment-thread-toggle",
        text: `Ещё ${hiddenReplyCount} ${replyForm}`,
        attr: { type: "button", "aria-expanded": "false" }
      });
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.activateCommentFromControl(comment.id);
      });
    }

    if (canAddCommentFollowUp(comment)) {
      if (this.openFollowUpCommentIds.has(comment.id)) this.renderFollowUpComposer(card, comment);
      else {
        const replyRow = card.createDiv({ cls: "codex-review-comment-reply-row" });
        const reply = replyRow.createEl("button", { cls: "codex-review-comment-reply", text: "Добавить" });
        reply.addEventListener("click", () => {
          this.activateComment(comment.id);
          void this.plugin.acknowledgeCommentAttention(comment.id);
          this.openFollowUpCommentIds.clear();
          this.openFollowUpCommentIds.add(comment.id);
          this.render();
          window.requestAnimationFrame(() => {
            this.railCards?.querySelector<HTMLTextAreaElement>(`textarea[data-comment-id="${comment.id}"]`)?.focus();
          });
        });
      }
    }
    renderCommentStatus(card, comment);
  }

  private renderPendingComment(card: HTMLElement, comment: ReviewComment): void {
    this.renderCommentEditor(card, comment, false);
  }

  private renderDraftCommentEditor(card: HTMLElement, comment: ReviewComment): void {
    this.renderCommentEditor(card, comment, true);
  }

  private renderCommentEditor(card: HTMLElement, comment: ReviewComment, editing: boolean): void {
    card.addClass("is-composer");
    card.removeClass("is-collapsed");
    card.setAttribute("aria-expanded", "true");
    const top = card.createDiv({ cls: "codex-review-margin-card-top" });
    const meta = top.createDiv({ cls: "codex-review-margin-card-meta" });
    meta.createSpan({ cls: "codex-review-new-comment-label", text: editing ? "Изменить комментарий" : "Новый комментарий" });
    const cancelTop = iconButton(top, "x", "Отменить комментарий", () => {
      if (this.commentEditorFocusId === comment.id) this.commentEditorFocusId = null;
      if (editing) this.editingCommentId = null;
      else this.pendingComment = null;
      this.render();
      this.view.focus();
    });
    cancelTop.addClass("is-cancel-draft");

    const inputWrap = card.createDiv({ cls: "codex-review-skill-mention-host codex-review-inline-comment-input" });
    const input = inputWrap.createEl("textarea", {
      attr: {
        rows: "4",
        placeholder: "Что нужно изменить?",
        "aria-label": "Комментарий для агента",
        "data-comment-editor-id": comment.id
      }
    });
    if (editing) input.value = comment.feedback;
    else input.value = comment.feedback;
    input.addEventListener("input", () => {
      if (!editing) comment.feedback = input.value;
    });
    const skillMentions = new SkillMentionAutocomplete(
      input,
      this.plugin,
      () => this.filePath ? this.plugin.getFileProvider(this.filePath) : this.plugin.getActiveAgentProvider()
    );
    const insertSkill = iconButton(inputWrap, "sparkles", "Выбрать навык агента", () => void skillMentions.startMention());
    insertSkill.addClass("codex-review-skill-trigger");
    const actions = card.createDiv({ cls: "codex-review-inline-comment-actions" });
    const add = actions.createEl("button", { text: editing ? "Сохранить" : "Добавить", cls: "mod-cta" });
    add.addEventListener("click", () => {
      const feedback = input.value.trim();
      if (!feedback) {
        input.focus();
        return;
      }
      add.disabled = true;
      const save = editing
        ? this.plugin.updateDraftComment(comment.id, feedback)
        : this.plugin.saveSelectionComment(comment, feedback);
      void save.then((saved) => {
        if (!saved) {
          add.disabled = false;
          return;
        }
        if (editing) this.editingCommentId = null;
        else {
          this.activateComment(typeof saved === "string" ? saved : null);
          this.pendingComment = null;
        }
        if (this.commentEditorFocusId === comment.id) this.commentEditorFocusId = null;
        this.render();
      });
    });
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        add.click();
      }
    });
  }

  startSelectionComment(range?: { from: number; to: number }): void {
    if (!this.filePath) return;
    const ownSelection = this.view.state.selection.main;
    const externalSelection = this.plugin.getExternalEditorSelection(this.filePath, this.view);
    const selection = range ?? externalSelection ?? ownSelection;
    const from = Math.max(0, Math.min(selection.from, this.view.state.doc.length));
    const to = Math.max(from, Math.min(selection.to, this.view.state.doc.length));
    if (from === to) {
      new Notice("Выделите текст");
      return;
    }
    const text = this.view.state.doc.toString();
    this.pendingComment = {
      id: `pending-${makeId()}`,
      filePath: this.filePath,
      kind: "selection",
      quote: text.slice(from, to),
      anchor: createAnchor(text, from, to),
      fromOffset: from,
      toOffset: to,
      feedback: "",
      createdAt: new Date().toISOString(),
      status: "draft",
      followUps: []
    };
    this.activateComment(this.pendingComment.id);
    this.commentEditorFocusId = this.pendingComment.id;
    this.selectionActionReady = false;
    this.selectionAction.addClass("is-hidden");
    this.render();
  }

  private updateSelectionAction(): void {
    const ownSelection = this.view.state.selection.main;
    const externalSelection = this.filePath ? this.plugin.getExternalEditorSelection(this.filePath, this.view) : null;
    const selection = externalSelection ?? ownSelection;
    const selectionIsEmpty = "empty" in selection ? selection.empty : selection.from === selection.to;
    const selectionHasFocus = externalSelection ? externalSelection.editorView.hasFocus : this.view.hasFocus;
    const hidden = !this.filePath
      || !this.isEditingMode
      || !selectionHasFocus
      || this.isPointerSelecting
      || (!externalSelection && !this.selectionActionReady)
      || selectionIsEmpty
      || Boolean(this.pendingComment);
    this.selectionAction.toggleClass("is-hidden", hidden);
    if (hidden) return;
    const coordinates = externalSelection
      ? externalSelection.editorView.coordsAtPos(externalSelection.localTo, -1)
      : this.view.coordsAtPos(selection.to, -1);
    if (!coordinates) {
      this.selectionAction.addClass("is-hidden");
      return;
    }
    const scrollRect = this.view.scrollDOM.getBoundingClientRect();
    if (coordinates.bottom < scrollRect.top || coordinates.top > scrollRect.bottom) {
      this.selectionAction.addClass("is-hidden");
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const editorRect = this.view.dom.getBoundingClientRect();
    const visibleEditorRight = Math.min(editorRect.right, hostRect.right);
    const left = Math.min(
      coordinates.right - hostRect.left + this.host.scrollLeft + 6,
      visibleEditorRight - hostRect.left + this.host.scrollLeft - 28
    );
    const top = Math.min(coordinates.bottom - hostRect.top + 3, hostRect.height - 30);
    this.selectionAction.style.left = `${Math.max(4, Math.round(left))}px`;
    this.selectionAction.style.top = `${Math.max(44, Math.round(top))}px`;
  }

  private renderCommentActions(actions: HTMLElement, comment: ReviewComment): void {
    if (isUnsentDraftComment(comment)) {
      iconButton(actions, "pencil", "Изменить комментарий", () => {
        this.activateComment(comment.id);
        this.editingCommentId = comment.id;
        this.commentEditorFocusId = comment.id;
        this.render();
      });
      const remove = iconButton(actions, "trash-2", "Удалить комментарий", () => void this.plugin.deleteUnsentComment(comment.id));
      remove.addClass("is-delete");
    }
    const issueTarget = comment.issue
      ? { id: comment.id, issue: comment.issue }
      : [...comment.followUps].reverse().flatMap((followUp) => followUp.issue ? [{ id: followUp.id, issue: followUp.issue }] : [])[0];
    const hasChanges = this.plugin.hasInlineChanges(comment.id);
    const available = commentActionAvailability(comment, hasChanges);
    if (available.canReopen) {
      iconButton(actions, "rotate-ccw", "Вернуть в работу", () => void this.plugin.reopenComment(comment.id));
    } else if (available.canAcceptChanges) {
      const accept = iconButton(actions, "check", "Принять изменения", () => void this.plugin.acceptComment(comment.id));
      accept.addClass("is-accept");
      const cancel = iconButton(actions, "undo-2", "Отменить изменения", () => void this.plugin.cancelCommentChanges(comment.id));
      cancel.addClass("is-cancel");
    } else if (available.canResolve) {
      const resolve = iconButton(actions, "check", "Завершить комментарий", () => void this.plugin.resolveComment(comment.id));
      resolve.addClass("is-resolve");
    }
    if (comment.status === "needs_attention") {
      if (issueTarget?.issue.kind === "missing_response") {
        iconButton(actions, "refresh-cw", "Подготовить к повторной отправке", () => void this.plugin.retryFeedback(issueTarget.id));
      }
    }
  }

  private renderThreadMessage(
    parent: HTMLElement,
    role: "user" | "codex",
    text: string,
    sourcePath: string,
    provider: AgentProvider | undefined,
    messageKey: string,
    draft = false,
    renderActions?: (actions: HTMLElement) => void,
    timestamp?: string
  ): HTMLElement {
    const message = this.renderCommentMessage(parent, role, text, sourcePath, provider, draft, renderActions, timestamp);
    message.addClass("codex-review-thread-message");
    message.dataset.codexReviewMessageKey = messageKey;
    const toggle = message.createEl("button", {
      cls: "codex-review-comment-message-expand is-hidden",
      text: "Показать все",
      attr: { type: "button", "aria-expanded": "false" }
    });
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const commentId = parent.dataset.codexReviewCommentId;
      if (commentId) this.activateCommentFromControl(commentId);
    });
    return message;
  }

  private renderCommentMessage(
    parent: HTMLElement,
    role: "user" | "codex",
    text: string,
    sourcePath: string,
    provider: AgentProvider | undefined,
    draft = false,
    renderActions?: (actions: HTMLElement) => void,
    timestamp?: string
  ): HTMLElement {
    const message = parent.createDiv({ cls: `codex-review-comment-message is-${role}` });
    const label = message.createDiv({ cls: "codex-review-comment-message-label" });
    setIcon(label.createSpan(), role === "user" ? "user-round" : "bot");
    label.createSpan({
      text: role === "user" ? "Вы" : agentName(normalizeAgentProvider(provider ?? this.plugin.getFileProvider(sourcePath)))
    });
    const formattedTimestamp = formatCommentTimestamp(timestamp);
    if (formattedTimestamp) {
      const time = label.createEl("time", { cls: "codex-review-comment-message-time", text: formattedTimestamp });
      time.dateTime = timestamp ?? "";
    }
    if (draft) label.createSpan({ cls: "codex-review-comment-draft-label", text: "Ожидает отправки" });
    if (renderActions) {
      const actions = label.createDiv({ cls: "codex-review-comment-message-actions" });
      renderActions(actions);
    }
    const content = message.createDiv({
      cls: `codex-review-comment-message-text is-${role}${role === "codex" ? " markdown-rendered" : ""}`
    });
    if (role === "codex") {
      void MarkdownRenderer.render(this.plugin.app, text, content, sourcePath, this.plugin)
        .then(() => this.scheduleLayout());
    } else content.setText(text);
    return message;
  }

  private renderCommentIssue(parent: HTMLElement, issue: ReviewCommentIssue): void {
    const notice = parent.createDiv({ cls: `codex-review-comment-issue is-${issue.kind}` });
    setIcon(notice.createSpan(), isRetryableCommentIssue(issue) ? "refresh-cw" : "circle-alert");
    const text = notice.createDiv({ cls: "codex-review-comment-issue-text" });
    text.createDiv({
      cls: "codex-review-comment-issue-label",
      text: commentIssueLabel(issue)
    });
    text.createDiv({ text: issue.message });
  }

  private renderFollowUpComposer(parent: HTMLElement, comment: ReviewComment): void {
    const composer = parent.createDiv({ cls: "codex-review-comment-follow-up" });
    const inputWrap = composer.createDiv({ cls: "codex-review-skill-mention-host codex-review-comment-follow-up-input" });
    const input = inputWrap.createEl("textarea", {
      attr: { rows: "3", placeholder: "Добавить комментарий", "aria-label": "Добавить комментарий", "data-comment-id": comment.id }
    });
    input.value = this.followUpDrafts.get(comment.id) ?? "";
    input.addEventListener("input", () => this.followUpDrafts.set(comment.id, input.value));
    const skillMentions = new SkillMentionAutocomplete(
      input,
      this.plugin,
      () => this.plugin.getFileProvider(comment.filePath)
    );
    const insertSkill = iconButton(inputWrap, "sparkles", "Выбрать навык агента", () => void skillMentions.startMention());
    insertSkill.addClass("codex-review-skill-trigger");
    const actions = composer.createDiv({ cls: "codex-review-comment-follow-up-actions" });
    const cancel = actions.createEl("button", { text: "Отмена", cls: "codex-review-cancel-follow-up" });
    cancel.addEventListener("click", () => {
      this.openFollowUpCommentIds.delete(comment.id);
      this.render();
    });
    const save = actions.createEl("button", { text: "Добавить", cls: "codex-review-save-follow-up" });
    save.addEventListener("click", () => void this.saveFollowUp(comment, input, save));
  }

  private async saveFollowUp(comment: ReviewComment, input: HTMLTextAreaElement, save: HTMLButtonElement): Promise<void> {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    save.disabled = true;
    if (await this.plugin.saveCommentFollowUp(comment.id, text)) {
      this.followUpDrafts.delete(comment.id);
      this.openFollowUpCommentIds.delete(comment.id);
      this.render();
    } else save.disabled = false;
  }

  private bindCardNavigation(card: HTMLElement, comment: ReviewComment): void {
    let selectionDrag = false;
    let pointerStart: { x: number; y: number } | null = null;
    card.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerStart = { x: event.clientX, y: event.clientY };
      selectionDrag = false;
    });
    card.addEventListener("pointermove", (event) => {
      if (!pointerStart) return;
      if (Math.abs(event.clientX - pointerStart.x) >= 4 || Math.abs(event.clientY - pointerStart.y) >= 4) selectionDrag = true;
    });
    card.addEventListener("pointerup", () => {
      pointerStart = null;
      window.setTimeout(() => { selectionDrag = false; }, 0);
    });
    card.addEventListener("pointercancel", () => {
      pointerStart = null;
      selectionDrag = false;
    });
    card.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element) || selectionDrag) return;
      if (target.closest("button, input, textarea, select, a, [contenteditable='true'], .codex-review-comment-follow-up")) return;
      const selection = card.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && selection.toString()) return;
      this.focusComment(comment.id);
      void this.plugin.revealComment(comment, false);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target !== card) return;
      event.preventDefault();
      this.focusComment(comment.id);
      void this.plugin.revealComment(comment, false);
    });
  }

  private layoutCards(): void {
    if (!this.filePath || !this.railCards || this.cards.size === 0) return;
    const text = this.view.state.doc.toString();
    const railHeight = this.railCards.clientHeight;
    if (railHeight <= 0) return;
    const scrollTop = this.view.scrollDOM.scrollTop;
    const items = this.comments.flatMap((comment) => {
      const card = this.cards.get(comment.id);
      if (!card) return [];
      const position = this.anchorPosition(comment, text);
      const anchor = Math.max(0, Math.min(position, this.view.state.doc.length));
      const anchorTop = this.commentVisualAnchor(comment, text)?.documentTop
        ?? this.view.lineBlockAt(anchor).top;
      const expanded = comment.id === this.activeCommentId || card.hasClass("is-composer");
      const size = reviewMarginCardSize(card.scrollHeight, railHeight, expanded);
      card.style.maxHeight = size.maxHeight === null ? "none" : `${size.maxHeight}px`;
      const height = size.height;
      return [{ id: comment.id, comment, card, anchorTop, height }];
    }).sort((left, right) => left.anchorTop - right.anchorTop);

    const placed = placeReviewMarginCards(items, 12, this.activeCommentId);
    for (const item of placed) {
      item.card.style.top = `${Math.round(item.documentTop)}px`;
      const visible = isReviewMarginCardVisible(
        item.documentTop,
        item.height,
        scrollTop,
        railHeight
      );
      item.card.toggleClass("is-outside-viewport", !visible);
    }
  }

  private commentVisualAnchor(
    comment: ReviewComment,
    text: string
  ): { rect: DOMRect; documentTop: number; visible: boolean } | null {
    const anchorPosition = this.anchorPosition(comment, text);
    const scrollRect = this.view.scrollDOM.getBoundingClientRect();
    const candidates = this.reviewElementsForComment(comment.id).flatMap((element) => {
      const elementPosition = Number(element.dataset.codexReviewFrom);
      const position = Number.isFinite(elementPosition) ? elementPosition : anchorPosition;
      const priority = element.hasClass("codex-review-highlight")
        || element.hasClass("codex-review-pending-highlight") ? 0
        : element.hasClass("codex-review-inline-new") ? 1
          : element.hasClass("codex-review-inline-comparison") ? 2 : 3;
      return [...element.getClientRects()].map((rect) => ({ rect, position, priority }));
    }).filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((left, right) =>
        left.priority - right.priority
        || Math.abs(left.position - anchorPosition) - Math.abs(right.position - anchorPosition)
        || left.rect.top - right.rect.top
        || left.rect.left - right.rect.left
      );
    const first = candidates[0];
    if (!first) return null;
    return {
      rect: first.rect,
      documentTop: first.rect.top - scrollRect.top + this.view.scrollDOM.scrollTop,
      visible: first.rect.bottom >= scrollRect.top && first.rect.top <= scrollRect.bottom
    };
  }

  /** Двигает весь слой комментариев тем же смещением, что и документ, до следующей отрисовки. */
  private syncScrollOffset(): void {
    const transform = `translate3d(0, ${-this.view.scrollDOM.scrollTop}px, 0)`;
    if (this.railCards) this.railCards.style.transform = transform;
  }

  private anchorPosition(comment: ReviewComment, text: string): number {
    const oldParagraph = firstOldParagraphForComment(text, this.plugin.data.inlineChanges, comment.id);
    if (oldParagraph) return oldParagraph.from;
    if (comment.kind === "document") return 0;
    return locateComment(text, comment)?.from ?? comment.fromOffset;
  }

}

class ReviewSidebarView extends ItemView {
  private commentScope: "all" | "resolved" = "all";
  private panel: "comments" | "history" | "versions" = "history";
  private chatScrollRequested = false;
  private chatDrafts = new Map<string, string>();
  private chatAttachments = new Map<string, CodexLocalAttachment[]>();
  private chatScrollPositions = new Map<string, { scrollTop: number; atBottom: boolean }>();
  private renderedChatBody: {
    element: HTMLElement;
    key: string;
    newMessagesButton: HTMLButtonElement;
  } | null = null;
  private renderedChatActivity: { element: HTMLElement; key: string } | null = null;
  private chatUnreadPaths = new Set<string>();
  private chatContentRevisions = new Map<string, string>();
  private chatAgentContentRevisions = new Map<string, string>();
  private chatRestoreFrame: number | null = null;
  private chatRenderRevision = 0;
  private chatFocus: { key: string; start: number; end: number } | null = null;
  private commentFollowUpDrafts = new Map<string, string>();
  private openFollowUpCommentIds = new Set<string>();
  private commentScrollPositions = new Map<string, number>();
  private renderedCommentBody: { element: HTMLElement; key: string } | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexReviewPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Agent Review";
  }

  getIcon(): string {
    return "file-diff";
  }

  async onOpen(): Promise<void> {
    this.render();
    void this.plugin.loadModels();
  }

  showPanel(panel: "comments" | "history" | "versions"): void {
    this.panel = panel;
    if (panel === "history") this.chatScrollRequested = true;
    this.render();
    const activePath = this.plugin.getActiveMarkdownFile()?.path;
    if (panel === "history" && activePath) {
      const target = this.plugin.getFileThread(activePath);
      if (target?.threadId) void this.plugin.loadThreadHistory(target.threadId);
    }
  }

  focusComment(commentId: string): void {
    const comment = this.plugin.data.comments.find((item) => item.id === commentId);
    if (!comment) return;
    this.panel = "comments";
    if (comment.status === "accepted" || comment.status === "resolved") this.commentScope = "resolved";
    this.render();
    window.requestAnimationFrame(() => {
      const body = this.containerEl.querySelector<HTMLElement>(".codex-review-comment-scroll")
        ?? this.containerEl.querySelector<HTMLElement>(".codex-review-sidebar-body");
      const card = [...this.containerEl.querySelectorAll<HTMLElement>(".codex-review-card")]
        .find((item) => item.dataset.codexReviewCommentId === commentId);
      if (!body || !card) return;
      const bodyRect = body.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const inset = 8;
      if (cardRect.height >= bodyRect.height - inset * 2 || cardRect.top < bodyRect.top + inset) {
        body.scrollTop += cardRect.top - bodyRect.top - inset;
      } else if (cardRect.bottom > bodyRect.bottom - inset) {
        body.scrollTop += cardRect.bottom - bodyRect.bottom + inset;
      }
      const activePath = this.plugin.getActiveMarkdownFile()?.path ?? "";
      this.commentScrollPositions.set(`${activePath}:${this.commentScope}`, body.scrollTop);
      card.addClass("is-editor-target");
      window.setTimeout(() => card.removeClass("is-editor-target"), 900);
    });
  }

  clearFileState(filePath: string, commentIds: ReadonlySet<string>): void {
    this.chatDrafts.delete(filePath);
    for (const attachment of this.chatAttachments.get(filePath) ?? []) {
      void this.plugin.removeClipboardAttachment(attachment);
    }
    this.chatAttachments.delete(filePath);
    this.chatScrollPositions.delete(filePath);
    this.chatUnreadPaths.delete(filePath);
    this.chatContentRevisions.delete(filePath);
    this.chatAgentContentRevisions.delete(filePath);
    for (const commentId of commentIds) this.commentFollowUpDrafts.delete(commentId);
    for (const commentId of commentIds) this.openFollowUpCommentIds.delete(commentId);
    for (const key of [...this.commentScrollPositions.keys()]) {
      if (key.startsWith(`${filePath}:`)) this.commentScrollPositions.delete(key);
    }
  }

  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    if (this.renderedChatBody) {
      const { element, key } = this.renderedChatBody;
      this.captureChatPosition(element, key);
      const activeElement = element.ownerDocument.activeElement;
      if (activeElement instanceof HTMLTextAreaElement && activeElement.matches(".codex-review-composer textarea")) {
        this.chatFocus = {
          key,
          start: activeElement.selectionStart ?? activeElement.value.length,
          end: activeElement.selectionEnd ?? activeElement.value.length
        };
      }
      this.renderedChatBody = null;
    }
    this.renderedChatActivity = null;
    this.chatRenderRevision += 1;
    if (this.chatRestoreFrame !== null) {
      window.cancelAnimationFrame(this.chatRestoreFrame);
      this.chatRestoreFrame = null;
    }
    if (this.renderedCommentBody) {
      this.commentScrollPositions.set(
        this.renderedCommentBody.key,
        this.renderedCommentBody.element.scrollTop
      );
      this.renderedCommentBody = null;
    }
    root.empty();
    applyReviewThemeAccent(this.app, root);
    root.addClass("codex-review-sidebar");
    const activeFile = this.plugin.getActiveMarkdownFile();
    const activePath = activeFile?.path;

    const chrome = root.createDiv({ cls: "codex-review-sidebar-chrome" });
    const header = chrome.createDiv({ cls: "codex-review-sidebar-header" });
    const title = header.createDiv({ cls: "codex-review-title-wrap" });
    title.createEl("h3", { text: "Agent Review" });
    const headerActions = header.createDiv({ cls: "codex-review-sidebar-header-actions" });
    const clear = iconButton(headerActions, "trash-2", "Очистить данные текущего файла", () => {
      if (activePath) this.plugin.confirmClearFileData(activePath);
    });
    clear.disabled = !activePath || isBusyActivity(activePath ? this.plugin.data.activities[activePath] : undefined);
    iconButton(headerActions, "x", "Свернуть панель Agent Review", () => {
      this.app.workspace.rightSplit.collapse();
      this.plugin.refreshSidebarLayout();
    });

    const tabs = chrome.createDiv({ cls: "codex-review-tabs" });
    for (const [value, label] of [
      ["history", "Чат"],
      ["versions", "Версии"],
      ["comments", "Комментарии"]
    ] as const) {
      const button = tabs.createEl("button", { text: label, cls: this.panel === value ? "is-active" : "" });
      if (value === "history" && activePath && isBusyActivity(this.plugin.data.activities[activePath])) {
        button.addClass("has-running-task");
      }
      button.addEventListener("click", () => {
        this.panel = value;
        if (value === "history") this.chatScrollRequested = true;
        this.render();
        if (value === "history" && activePath) {
          const target = this.plugin.getFileThread(activePath);
          if (target?.threadId) void this.plugin.loadThreadHistory(target.threadId);
        }
      });
    }

    const body = root.createDiv({ cls: "codex-review-sidebar-body" });
    if (!activePath && this.panel !== "comments") {
      body.createDiv({ cls: "codex-review-empty", text: "Откройте Markdown-файл" });
      return;
    }
    if (this.panel === "history" && activePath) this.renderHistory(body, activePath);
    else if (this.panel === "versions" && activePath) this.renderVersions(body, activePath);
    else this.renderComments(body, activePath);
  }

  private renderTarget(root: HTMLElement, activePath?: string): void {
    const row = root.createDiv({ cls: "codex-review-target-row" });
    if (activePath) {
      const provider = row.createEl("select", {
        cls: "codex-review-provider-select",
        attr: { "aria-label": "Агент", title: "Агент для текущего файла" }
      });
      provider.createEl("option", { value: "codex", text: "Codex" });
      provider.createEl("option", { value: "claude", text: "Claude" });
      provider.value = this.plugin.getFileProvider(activePath);
      provider.addEventListener("change", () => void this.plugin.setFileProvider(activePath, normalizeAgentProvider(provider.value)));
    }
    const target = row.createEl("button", { cls: "codex-review-target" });
    setIcon(target.createSpan(), "messages-square");
    const selected = activePath ? this.plugin.getFileThread(activePath) : undefined;
    const taskPrompt = "Выберите или создайте задачу для файла";
    target.createSpan({ text: selected?.threadLabel ?? (activePath ? taskPrompt : "") });
    if (activePath && !hasExplicitTaskSelection(selected)) target.addClass("is-unselected");
    target.title = selected ? `Выбор задачи: ${selected.threadLabel}` : taskPrompt;
    target.setAttribute("aria-label", "Выбор задачи");
    target.disabled = !activePath;
    target.addEventListener("click", () => this.plugin.chooseThread());
  }

  private renderInstructionsButton(root: HTMLElement, activePath?: string): void {
    const button = root.createEl("button", { cls: "codex-review-instructions-button" });
    setIcon(button.createSpan(), "book-open-check");
    button.createSpan({ text: "Инструкции для агента" });
    button.disabled = !activePath;
    if (activePath && this.plugin.hasDocumentInstructions(activePath)) {
      button.addClass("is-configured");
      button.title = "Инструкции для агента настроены";
    } else {
      button.title = "Инструкции для агента";
    }
    button.addEventListener("click", () => this.plugin.openInstructions());
  }

  private renderModelPicker(root: HTMLElement, activePath?: string): void {
    const modelWrap = root.createDiv({ cls: "codex-review-model-wrap" });
    const select = modelWrap.createEl("select", { attr: { "aria-label": "Модель агента" } });
    select.title = "Модель агента";
    const selectedModel = activePath ? this.plugin.getFileModel(activePath) : "";
    const models = this.plugin.getModels();
    const defaultModel = models.find((model) => model.isDefault);
    select.createEl("option", {
      value: "",
      text: defaultModel?.displayName ?? "Определяю текущую модель…"
    });
    if (selectedModel && !models.some((model) => model.model === selectedModel)) {
      select.createEl("option", { value: selectedModel, text: selectedModel });
    }
    for (const model of models) {
      const option = select.createEl("option", {
        value: model.model,
        text: model.displayName
      });
      option.title = model.description ?? model.displayName;
    }
    select.value = selectedModel;
    select.disabled = !activePath;
    select.addEventListener("change", () => {
      if (activePath) void this.plugin.setFileModel(activePath, select.value);
    });
  }

  private renderComments(root: HTMLElement, activePath?: string): void {
    root.addClass("is-comments");
    if (this.plugin.isActiveMarkdownPreview()) {
      root.createDiv({ cls: "codex-review-empty", text: "Комментарии скрыты в режиме просмотра" });
      return;
    }
    const scopes = root.createDiv({ cls: "codex-review-scope" });
    for (const [value, label] of [["all", "Все комментарии"], ["resolved", "Решенные"]] as const) {
      const button = scopes.createEl("button", { text: label, cls: this.commentScope === value ? "is-active" : "" });
      button.addEventListener("click", () => {
        this.commentScope = value;
        this.render();
      });
    }

    const allComments = commentsForFile(
      this.plugin.data.comments,
      activePath,
      "all",
      activePath ? this.plugin.getOpenMarkdownText(activePath) : undefined
    );
    const comments = this.commentScope === "resolved"
      ? allComments.filter((comment) => comment.status === "accepted" || comment.status === "resolved")
      : allComments;
    const scroll = root.createDiv({ cls: "codex-review-comment-scroll" });
    const list = scroll.createDiv({ cls: "codex-review-comment-list" });
    if (comments.length === 0) {
      list.createDiv({
        cls: "codex-review-empty",
        text: this.commentScope === "resolved" ? "Решенных комментариев пока нет" : "Комментариев пока нет"
      });
    } else {
      for (const comment of comments) this.renderComment(list, comment);
    }
    const scrollKey = `${activePath ?? ""}:${this.commentScope}`;
    scroll.scrollTop = this.commentScrollPositions.get(scrollKey) ?? 0;
    this.renderedCommentBody = { element: scroll, key: scrollKey };
  }

  private renderActivity(root: HTMLElement, activePath: string): Promise<void>[] {
    const renderTasks: Promise<void>[] = [];
    const container = root.createDiv({ cls: "codex-review-activity", attr: { "aria-live": "polite" } });
    const activity = this.plugin.data.activities[activePath];
    if (!activity) return renderTasks;
    const activeAgentName = agentName(activity.provider);

    const heading = container.createDiv({ cls: "codex-review-activity-heading" });
    const task = heading.createDiv({ cls: "codex-review-activity-task", text: activity.taskLabel });
    task.title = activity.taskLabel;
    const controls = heading.createDiv({ cls: "codex-review-activity-controls" });
    const status = controls.createDiv({ cls: `codex-review-activity-status is-${activity.status}` });
    setIcon(status.createSpan(), activity.status === "completed"
      ? "circle-check"
      : activity.status === "failed" ? "circle-alert"
        : activity.status === "interrupted" ? "circle-stop" : "loader-circle");
    status.createSpan({ text: this.activityStatus(activity) });

    const stream = container.createDiv({ cls: "codex-review-stream" });
    for (const item of activity.entries) {
      const itemText = visibleChatMessageText(item.kind, item.text);
      if (!itemText.trim()) continue;
      const section = stream.createDiv({ cls: `codex-review-stream-entry is-${item.kind}` });
      const label = section.createDiv({ cls: "codex-review-stream-label" });
      setIcon(label.createSpan(), item.kind === "reasoning" ? "sparkles" : "message-circle");
      label.createSpan({ text: item.kind === "reasoning" ? "Рассуждение" : activeAgentName });
      section.createDiv({ cls: "codex-review-stream-text", text: itemText });
    }

    const visibleFinalMessage = activity.source === "review"
      ? isTerminalActivity(activity)
        ? reviewChatCompletionMessage(
            activity.finalMessage,
            reviewTurnNeedsAttention(this.plugin.data.comments, activePath, activity.turnId)
          )
        : ""
      : visibleChatMessageText("assistant", activity.finalMessage);
    if (visibleFinalMessage.trim()) {
      const final = container.createDiv({ cls: "codex-review-final" });
      const label = final.createDiv({ cls: "codex-review-final-label" });
      setIcon(label.createSpan(), "message-square-text");
      label.createSpan({ text: activeAgentName });
      const content = final.createDiv({ cls: "codex-review-final-content markdown-rendered" });
      if (isTerminalActivity(activity)) {
        renderTasks.push(MarkdownRenderer.render(this.app, visibleFinalMessage, content, activePath, this));
      } else {
        content.addClass("is-streaming");
        content.setText(visibleFinalMessage);
      }
    }

    for (const message of activity.steeringMessages ?? []) {
      const followUp = container.createDiv({ cls: "codex-review-live-user-message" });
      const label = followUp.createDiv({ cls: "codex-review-history-label" });
      setIcon(label.createSpan(), "user-round");
      label.createSpan({ text: "Вы" });
      followUp.createDiv({ cls: "codex-review-history-text", text: message });
    }

    if (activity.error) {
      const error = container.createDiv({ cls: "codex-review-activity-error" });
      setIcon(error.createSpan(), "triangle-alert");
      error.createSpan({ text: activity.error });
    }

    return renderTasks;
  }

  private renderVersions(root: HTMLElement, activePath: string): void {
    const versions = this.plugin.getVersions(activePath);
    if (versions.length === 0) {
      root.createDiv({ cls: "codex-review-empty", text: "Версий пока нет" });
      return;
    }

    const list = root.createDiv({ cls: "codex-review-version-list" });
    const originalId = originalVersionId(versions, activePath);
    for (const [index, version] of versions.entries()) {
      const isOriginal = version.id === originalId;
      const previousVersion = versions[index + 1];
      const details = list.createEl("details", { cls: "codex-review-version" });
      const summary = details.createEl("summary", { cls: "codex-review-version-summary" });
      const icon = summary.createSpan({ cls: "codex-review-version-icon" });
      setIcon(icon, version.source === "restored" ? "history" : "file-clock");
      const meta = summary.createSpan({ cls: "codex-review-version-meta" });
      meta.createSpan({ cls: "codex-review-version-date", text: formatVersionDate(version.createdAt) });
      meta.createSpan({
        cls: "codex-review-version-source",
        text: isOriginal ? "Исходная версия" : VERSION_SOURCE_LABELS[version.source]
      });
      const chevron = summary.createSpan({ cls: "codex-review-version-chevron" });
      setIcon(chevron, "chevron-right");

      const body = details.createDiv({ cls: "codex-review-version-body" });
      const actions = body.createDiv({ cls: "codex-review-version-actions" });
      const restore = actions.createEl("button", { cls: "codex-review-labeled-button" });
      setIcon(restore.createSpan(), "history");
      restore.createSpan({ text: "Восстановить" });
      restore.addEventListener("click", () => this.plugin.openRestoreVersion(version));
      const preview = body.createDiv({ cls: "codex-review-version-preview" });
      let rendered = false;
      details.addEventListener("toggle", () => {
        if (!details.open || rendered) return;
        rendered = true;
        if (isOriginal) {
          const content = preview.createDiv({ cls: "codex-review-version-content markdown-rendered" });
          void MarkdownRenderer.render(this.app, version.text, content, activePath, this);
          return;
        }
        for (const part of contextualVersionParts(previousVersion?.text ?? "", version.text)) {
          if (part.kind === "content") {
            if (!part.text.trim()) continue;
            const content = preview.createDiv({ cls: "codex-review-version-content markdown-rendered" });
            void MarkdownRenderer.render(this.app, part.text, content, activePath, this);
            continue;
          }
          const item = preview.createDiv({ cls: "codex-review-version-change" });
          const before = item.createDiv({ cls: "codex-review-version-change-part is-before" });
          before.createDiv({ cls: "codex-review-version-change-label", text: "Было" });
          const beforeContent = before.createDiv({ cls: "codex-review-version-change-content markdown-rendered" });
          if (part.before) void MarkdownRenderer.render(this.app, part.before, beforeContent, activePath, this);
          else beforeContent.createDiv({ cls: "is-empty", text: "Фрагмент отсутствовал" });
          const after = item.createDiv({ cls: "codex-review-version-change-part is-after" });
          after.createDiv({ cls: "codex-review-version-change-label", text: "Стало" });
          const afterContent = after.createDiv({ cls: "codex-review-version-change-content markdown-rendered" });
          if (part.after) void MarkdownRenderer.render(this.app, part.after, afterContent, activePath, this);
          else afterContent.createDiv({ cls: "is-empty", text: "Фрагмент удалён" });
        }
      });
    }
  }

  private renderHistory(root: HTMLElement, activePath: string): void {
    const target = this.plugin.getFileThread(activePath);
    if (!hasExplicitTaskSelection(target)) {
      root.createDiv({ cls: "codex-review-empty", text: `Выберите задачу ${agentName(this.plugin.getFileProvider(activePath))} или создайте новую` });
      return;
    }
    root.addClass("is-chat");

    const heading = root.createDiv({ cls: "codex-review-history-heading" });
    heading.createDiv({ cls: "codex-review-history-title", text: target?.threadLabel ?? activePath });
    if (target?.threadId) {
      iconButton(heading, "refresh-cw", "Обновить переписку", () => void this.plugin.loadThreadHistory(target.threadId, true));
    }

    const history: CodexThreadHistory = target?.threadId
      ? this.plugin.getThreadHistory(target.threadId)
      : { status: "ready", messages: [] };
    const historyFrame = root.createDiv({ cls: "codex-review-history-frame" });
    const messages = historyFrame.createDiv({ cls: "codex-review-history", attr: { "aria-live": "polite" } });
    const renderTasks: Promise<void>[] = [];
    const reviewTurnIds = reviewTurnIdsForFile(this.plugin.data.comments, activePath);
    const reviewAssistantText = new Map<string, string[]>();
    const lastReviewAssistantId = new Map<string, string>();
    for (const message of history.messages) {
      if (message.kind !== "assistant" || !reviewTurnIds.has(message.turnId)) continue;
      reviewAssistantText.set(message.turnId, [
        ...(reviewAssistantText.get(message.turnId) ?? []),
        message.text
      ]);
      lastReviewAssistantId.set(message.turnId, message.id);
    }
    const renderMessage = (
      kind: "user" | "assistant" | "reasoning" | "commentary",
      text: string,
      turnId = "",
      messageId = ""
    ) => {
      let visibleText = text;
      if (kind === "assistant" && reviewTurnIds.has(turnId)) {
        if (lastReviewAssistantId.get(turnId) !== messageId) return;
        visibleText = reviewChatCompletionMessage(
          (reviewAssistantText.get(turnId) ?? [text]).join("\n\n"),
          reviewTurnNeedsAttention(this.plugin.data.comments, activePath, turnId)
        );
      }
      const task = this.renderHistoryMessage(messages, kind, visibleText, activePath);
      if (task) renderTasks.push(task);
    };
    const activity = this.plugin.data.activities[activePath];
    const historyHasCurrentTurn = Boolean(
      activity?.turnId && history.messages.some((message) => message.turnId === activity.turnId)
    );
    const showCurrentActivity = Boolean(activity && (!isTerminalActivity(activity) || !historyHasCurrentTurn));
    if (history.status === "idle" || history.status === "loading") {
      if (history.messages.length === 0 && !showCurrentActivity) {
        messages.createDiv({ cls: "codex-review-empty", text: "Загружаю переписку…" });
      } else {
        for (const message of history.messages) renderMessage(message.kind, message.text, message.turnId, message.id);
      }
      if (history.status === "idle" && target?.threadId) void this.plugin.loadThreadHistory(target.threadId);
    } else if (history.status === "error") {
      messages.createDiv({ cls: "codex-review-activity-error", text: history.error ?? "Не удалось загрузить переписку" });
    } else if (history.messages.length === 0 && !showCurrentActivity) {
      messages.createDiv({ cls: "codex-review-empty", text: "В задаче пока нет сообщений" });
    } else {
      for (const message of history.messages) renderMessage(message.kind, message.text, message.turnId, message.id);
    }
    if (showCurrentActivity) {
      if (activity?.requestText) renderMessage("user", activity.requestText);
      const activityHost = messages.createDiv({ cls: "codex-review-live-activity" });
      renderTasks.push(...this.renderActivity(activityHost, activePath));
      this.renderedChatActivity = { element: activityHost, key: activePath };
    }

    const contentRevision = this.currentChatContentRevision(activePath);
    const agentContentRevision = this.currentAgentChatContentRevision(activePath);
    const previousAgentRevision = this.chatAgentContentRevisions.get(activePath);
    const storedPosition = this.chatScrollPositions.get(activePath);
    if (this.chatScrollRequested) {
      this.chatUnreadPaths.delete(activePath);
    } else if (
      previousAgentRevision !== undefined
      && previousAgentRevision !== agentContentRevision
      && storedPosition?.atBottom === false
    ) {
      this.chatUnreadPaths.add(activePath);
    }
    this.chatContentRevisions.set(activePath, contentRevision);
    this.chatAgentContentRevisions.set(activePath, agentContentRevision);

    const newMessagesButton = historyFrame.createEl("button", {
      cls: "codex-review-new-messages",
      attr: { type: "button" }
    });
    setIcon(newMessagesButton.createSpan(), "arrow-down");
    newMessagesButton.createSpan({ cls: "codex-review-new-messages-label" });
    this.syncChatJumpControl(newMessagesButton, activePath, storedPosition?.atBottom ?? true);
    newMessagesButton.addEventListener("click", () => {
      this.chatUnreadPaths.delete(activePath);
      messages.scrollTop = messages.scrollHeight;
      const position = this.captureChatPosition(messages, activePath);
      this.syncChatJumpControl(newMessagesButton, activePath, position.atBottom);
    });
    messages.addEventListener("scroll", () => {
      const position = this.captureChatPosition(messages, activePath);
      if (position.atBottom) this.chatUnreadPaths.delete(activePath);
      this.syncChatJumpControl(newMessagesButton, activePath, position.atBottom);
    }, { passive: true });

    const composer = root.createDiv({ cls: "codex-review-composer" });
    const goal = this.plugin.getFileGoal(activePath);
    if (goal) {
      const goalSummary = composer.createDiv({ cls: "codex-review-chat-goal" });
      setIcon(goalSummary.createSpan(), "target");
      const goalText = goalSummary.createSpan({ text: goal });
      goalText.title = goal;
    }
    const attachments = this.chatAttachments.get(activePath) ?? [];
    if (attachments.length > 0) {
      const attachmentList = composer.createDiv({ cls: "codex-review-chat-attachments" });
      for (const attachment of attachments) {
        const chip = attachmentList.createDiv({ cls: "codex-review-chat-attachment" });
        setIcon(chip.createSpan(), "paperclip");
        const name = chip.createSpan({ cls: "codex-review-chat-attachment-name", text: attachment.name });
        name.title = attachment.path;
        const remove = iconButton(chip, "x", `Убрать файл ${attachment.name}`, () => {
          const next = (this.chatAttachments.get(activePath) ?? [])
            .filter((item) => item.path !== attachment.path);
          if (next.length > 0) this.chatAttachments.set(activePath, next);
          else this.chatAttachments.delete(activePath);
          void this.plugin.removeClipboardAttachment(attachment);
          this.render();
        });
        remove.addClass("codex-review-chat-attachment-remove");
      }
    }
    const inputWrap = composer.createDiv({ cls: "codex-review-skill-mention-host codex-review-chat-input" });
    const input = inputWrap.createEl("textarea", {
      attr: { rows: "4", placeholder: `Продолжить разговор с ${agentName(this.plugin.getFileProvider(activePath))}` }
    });
    input.value = this.chatDrafts.get(activePath) ?? "";
    const skillMentions = new SkillMentionAutocomplete(
      input,
      this.plugin,
      () => this.plugin.getFileProvider(activePath)
    );
    input.addEventListener("paste", (event) => {
      const files = clipboardFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      this.chatDrafts.set(activePath, input.value);
      void this.plugin.resolveClipboardAttachments(files).then((resolved) => {
        if (resolved.length === 0) return;
        const existing = this.chatAttachments.get(activePath) ?? [];
        this.chatAttachments.set(activePath, [...existing, ...resolved].filter((item, index, all) =>
          all.findIndex((candidate) => candidate.path === item.path) === index
        ));
        this.render();
      });
    });
    const actions = composer.createDiv({ cls: "codex-review-composer-actions" });
    const tools = actions.createDiv({ cls: "codex-review-chat-tools" });
    const filePicker = composer.createEl("input", {
      cls: "codex-review-local-file-picker",
      attr: { type: "file", multiple: "" }
    });
    filePicker.addEventListener("change", () => {
      const selected = [...(filePicker.files ?? [])];
      const resolved = selected.flatMap((file) => {
        const path = localPathForFile(file);
        return path ? [{ name: file.name, path }] : [];
      });
      if (resolved.length !== selected.length) {
        new Notice("Не удалось получить локальный путь одного из файлов");
      }
      if (resolved.length > 0) {
        const existing = this.chatAttachments.get(activePath) ?? [];
        this.chatAttachments.set(activePath, [...existing, ...resolved].filter((item, index, all) =>
          all.findIndex((candidate) => candidate.path === item.path) === index
        ));
        this.render();
      }
    });
    iconButton(tools, "paperclip", "Прикрепить файл", () => filePicker.click());
    iconButton(tools, "sparkles", "Выбрать навык агента", () => void skillMentions.startMention());
    const goalButton = iconButton(tools, "target", "Установить цель", () => void this.plugin.openGoalEditor(activePath));
    if (goal) goalButton.addClass("has-goal");
    const primaryAction = actions.createDiv({ cls: "codex-review-chat-primary-action" });
    let send: HTMLButtonElement | null = null;
    let stop: HTMLButtonElement | null = null;
    const busy = isBusyActivity(activity);
    const syncPrimaryAction = () => {
      const hasMessage = Boolean(input.value.trim() || (this.chatAttachments.get(activePath) ?? []).length > 0);
      if (busy) {
        send?.toggleClass("is-hidden", !hasMessage);
        stop?.toggleClass("is-hidden", hasMessage);
      }
    };
    input.addEventListener("input", () => {
      this.chatDrafts.set(activePath, input.value);
      syncPrimaryAction();
    });
    const submit = async () => {
      const selectedAttachments = this.chatAttachments.get(activePath) ?? [];
      const text = input.value.trim() || (selectedAttachments.length > 0 ? "Review the attached files." : "");
      if (!text) {
        input.focus();
        return;
      }
      if (send) send.disabled = true;
      const started = await this.plugin.sendFollowUp(text, selectedAttachments);
      if (started) {
        this.chatDrafts.delete(activePath);
        this.chatAttachments.delete(activePath);
        this.panel = "history";
        this.chatScrollRequested = true;
        this.render();
      } else if (send) {
        send.disabled = false;
      }
    };
    send = iconButton(
      primaryAction,
      "send",
      busy ? "Отправить дополнительную информацию" : "Отправить сообщение",
      () => void submit()
    );
    send.addClass("codex-review-chat-send");
    if (!busy) send.addClass("mod-cta");
    if (busy) {
      stop = iconButton(
        primaryAction,
        "square",
        "Остановить обработку",
        () => void this.plugin.stopProcessing(activePath)
      );
      stop.addClass("codex-review-chat-stop");
      stop.disabled = this.plugin.isStopping(activity?.turnId ?? "");
    }
    syncPrimaryAction();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        void submit();
      }
    });
    this.restoreChatPosition(messages, activePath, renderTasks);
    this.renderedChatBody = { element: messages, key: activePath, newMessagesButton };
    if (this.chatFocus?.key === activePath) {
      const focus = this.chatFocus;
      this.chatFocus = null;
      window.requestAnimationFrame(() => {
        input.focus({ preventScroll: true });
        input.setSelectionRange(focus.start, focus.end);
      });
    }
  }

  private captureChatPosition(
    container: HTMLElement,
    key: string
  ): { scrollTop: number; atBottom: boolean } {
    const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    const position = {
      scrollTop: container.scrollTop,
      atBottom: distanceFromBottom <= 32
    };
    this.chatScrollPositions.set(key, position);
    return position;
  }

  private syncChatJumpControl(button: HTMLButtonElement, key: string, atBottom: boolean): void {
    const state = chatJumpControlState(atBottom, this.chatUnreadPaths.has(key));
    button.toggleClass("is-hidden", state.hidden);
    button.toggleClass("has-unread", state.unread);
    button.title = state.title;
    button.setAttribute("aria-label", state.title);
    const label = button.querySelector<HTMLElement>(".codex-review-new-messages-label");
    if (label) label.setText(state.label);
  }

  private restoreChatPosition(
    container: HTMLElement,
    key: string,
    renderTasks: Promise<void>[]
  ): void {
    const state = this.chatScrollPositions.get(key);
    const followLatest = this.chatScrollRequested || state?.atBottom !== false;
    const storedScrollTop = state?.scrollTop ?? 0;
    const revision = this.chatRenderRevision;
    this.chatScrollRequested = false;
    if (followLatest) this.chatUnreadPaths.delete(key);

    const applyPosition = () => {
      if (revision !== this.chatRenderRevision || !container.isConnected) return;
      const current = this.chatScrollPositions.get(key);
      const shouldFollow = current?.atBottom ?? followLatest;
      container.scrollTop = shouldFollow ? container.scrollHeight : current?.scrollTop ?? storedScrollTop;
      this.captureChatPosition(container, key);
    };

    container.scrollTop = followLatest ? container.scrollHeight : storedScrollTop;
    this.chatScrollPositions.set(key, {
      scrollTop: followLatest ? container.scrollTop : storedScrollTop,
      atBottom: followLatest
    });

    void Promise.allSettled(renderTasks).then(() => {
      if (revision !== this.chatRenderRevision) return;
      this.chatRestoreFrame = window.requestAnimationFrame(() => {
        this.chatRestoreFrame = null;
        applyPosition();
      });
    });
  }

  private currentChatContentRevision(activePath: string): string {
    const target = this.plugin.getFileThread(activePath);
    const history = target?.threadId
      ? this.plugin.getThreadHistory(target.threadId)
      : { status: "ready", messages: [] } satisfies CodexThreadHistory;
    const activity = this.plugin.data.activities[activePath];
    const historyParts = history.messages.map((message) =>
      `${message.id}:${message.kind}:${message.text.length}:${message.text.slice(-48)}`
    );
    const activityParts = activity
      ? [
          activity.turnId,
          activity.status,
          ...activity.entries.map((entry) =>
            `${entry.id}:${entry.kind}:${entry.text.length}:${entry.text.slice(-48)}`
          ),
          ...(activity.steeringMessages ?? []).map((message, index) =>
            `steer:${index}:${message.length}:${message.slice(-48)}`
          ),
          `final:${activity.finalMessage.length}:${activity.finalMessage.slice(-48)}`,
          `error:${activity.error ?? ""}`
        ]
      : [];
    return [...historyParts, ...activityParts].join("|");
  }

  private currentAgentChatContentRevision(activePath: string): string {
    const target = this.plugin.getFileThread(activePath);
    const history = target?.threadId
      ? this.plugin.getThreadHistory(target.threadId)
      : { status: "ready", messages: [] } satisfies CodexThreadHistory;
    const activity = this.plugin.data.activities[activePath];
    const entries: ChatRevisionEntry[] = history.messages.map((message) => ({
      id: `${message.id}:${message.kind}`,
      author: message.kind === "user" ? "user" : "agent",
      text: visibleChatMessageText(message.kind, message.text)
    }));
    if (activity) {
      entries.push(...activity.entries.map((entry) => ({
        id: `${entry.id}:${entry.kind}`,
        author: "agent" as const,
        text: visibleChatMessageText(entry.kind, entry.text)
      })));
      entries.push({ id: "final", author: "agent", text: activity.finalMessage });
      for (const [index, text] of (activity.steeringMessages ?? []).entries()) {
        entries.push({ id: `steer:${index}`, author: "user", text });
      }
    }
    return agentChatContentRevision(entries);
  }

  refreshCodexActivity(activePath: string): void {
    if (this.panel !== "history") return;
    const body = this.renderedChatBody;
    const activityHost = this.renderedChatActivity;
    if (!body || !activityHost || body.key !== activePath || activityHost.key !== activePath) return;
    if (!body.element.isConnected || !activityHost.element.isConnected) return;

    const position = this.captureChatPosition(body.element, activePath);
    const previousAgentRevision = this.chatAgentContentRevisions.get(activePath);
    activityHost.element.empty();
    void Promise.allSettled(this.renderActivity(activityHost.element, activePath));
    this.chatContentRevisions.set(activePath, this.currentChatContentRevision(activePath));
    const agentContentRevision = this.currentAgentChatContentRevision(activePath);
    this.chatAgentContentRevisions.set(activePath, agentContentRevision);

    if (position.atBottom) {
      body.element.scrollTop = body.element.scrollHeight;
      const nextPosition = this.captureChatPosition(body.element, activePath);
      this.chatUnreadPaths.delete(activePath);
      this.syncChatJumpControl(body.newMessagesButton, activePath, nextPosition.atBottom);
    } else {
      if (previousAgentRevision !== undefined && previousAgentRevision !== agentContentRevision) {
        this.chatUnreadPaths.add(activePath);
      }
      this.syncChatJumpControl(body.newMessagesButton, activePath, false);
    }
  }

  private renderHistoryMessage(
    parent: HTMLElement,
    kind: "user" | "assistant" | "reasoning" | "commentary",
    rawText: string,
    sourcePath: string
  ): Promise<void> | undefined {
    const text = visibleChatMessageText(kind, rawText);
    if (!text.trim()) return undefined;
    const message = parent.createDiv({ cls: `codex-review-history-message is-${kind}` });
    const label = message.createDiv({ cls: "codex-review-history-label" });
    setIcon(label.createSpan(), kind === "user" ? "user-round" : kind === "reasoning" ? "sparkles" : "bot");
    label.createSpan({
      text: kind === "user"
        ? "Вы"
        : kind === "reasoning" ? "Рассуждение" : agentName(this.plugin.getFileProvider(sourcePath))
    });

    if (kind === "reasoning" || kind === "commentary") {
      message.createDiv({ cls: "codex-review-history-text", text });
    } else {
      const content = message.createDiv({ cls: "codex-review-history-text markdown-rendered" });
      return MarkdownRenderer.render(this.app, text, content, sourcePath, this);
    }
    return undefined;
  }

  private activityStatus(activity: CodexActivity): string {
    if (activity.status === "starting") return "Подключение";
    if (activity.status === "running") return this.plugin.isStopping(activity.turnId) ? "Останавливается" : "В работе";
    if (activity.status === "completed") return "Готово";
    if (activity.status === "interrupted") return "Остановлено";
    return "Ошибка";
  }

  private renderComment(parent: HTMLElement, comment: ReviewComment): void {
    const attentionSeenClass = comment.status === "needs_attention" && !commentHasUnreadAttention(comment)
      ? " is-attention-seen"
      : "";
    const card = parent.createDiv({ cls: `codex-review-card is-${comment.status}${attentionSeenClass}` });
    card.dataset.codexReviewCommentId = comment.id;
    let pointerStart: { x: number; y: number } | null = null;
    let selectionDrag = false;
    card.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerStart = { x: event.clientX, y: event.clientY };
      selectionDrag = false;
    });
    card.addEventListener("pointermove", (event) => {
      if (!pointerStart) return;
      if (
        Math.abs(event.clientX - pointerStart.x) >= 4
        || Math.abs(event.clientY - pointerStart.y) >= 4
      ) selectionDrag = true;
    });
    card.addEventListener("pointerup", () => {
      pointerStart = null;
      window.setTimeout(() => {
        selectionDrag = false;
      }, 0);
    });
    card.addEventListener("pointercancel", () => {
      pointerStart = null;
      selectionDrag = false;
    });
    card.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (selectionDrag) return;
      if (target.closest(
        "button, input, textarea, select, a, [contenteditable='true'], .codex-review-comment-follow-up"
      )) return;
      const selection = card.ownerDocument.getSelection();
      if (
        selection
        && !selection.isCollapsed
        && selection.toString()
        && (
          (selection.anchorNode && card.contains(selection.anchorNode))
          || (selection.focusNode && card.contains(selection.focusNode))
        )
      ) return;
      void this.plugin.revealComment(comment);
    });
    const top = card.createDiv({ cls: "codex-review-card-top" });
    const file = top.createDiv({ cls: "codex-review-file", text: comment.filePath });
    file.title = comment.filePath;
    const actions = top.createDiv({ cls: "codex-review-card-actions" });
    if (isUnsentDraftComment(comment)) {
      iconButton(actions, "pencil", "Изменить комментарий", () => this.plugin.editComment(comment));
      const remove = iconButton(
        actions,
        "trash-2",
        "Удалить комментарий",
        () => void this.plugin.deleteUnsentComment(comment.id)
      );
      remove.addClass("is-delete");
    }
    const issueTarget = comment.issue
      ? { id: comment.id, issue: comment.issue }
      : [...comment.followUps].reverse().flatMap((followUp) =>
          followUp.issue ? [{ id: followUp.id, issue: followUp.issue }] : []
        )[0];
    const hasChanges = this.plugin.hasInlineChanges(comment.id);
    const available = commentActionAvailability(comment, hasChanges);
    if (available.canReopen) {
      iconButton(actions, "rotate-ccw", "Вернуть в работу", () => void this.plugin.reopenComment(comment.id));
    } else if (available.canAcceptChanges) {
      const accept = iconButton(actions, "check", "Принять изменения", () => void this.plugin.acceptComment(comment.id));
      accept.addClass("is-accept");
      const cancel = iconButton(
        actions,
        "undo-2",
        "Отменить изменения",
        () => void this.plugin.cancelCommentChanges(comment.id)
      );
      cancel.addClass("is-cancel");
    } else if (available.canResolve) {
      const resolve = iconButton(actions, "check", "Завершить комментарий", () => void this.plugin.resolveComment(comment.id));
      resolve.addClass("is-resolve");
    }
    if (comment.status === "needs_attention") {
      if (issueTarget?.issue.kind === "missing_response") {
        iconButton(
          actions,
          "refresh-cw",
          "Подготовить к повторной отправке",
          () => void this.plugin.retryFeedback(issueTarget.id)
        );
      }
    }

    if (comment.kind === "document") {
      const scope = card.createDiv({ cls: "codex-review-document-scope" });
      setIcon(scope.createSpan(), "file-text");
      scope.createSpan({ text: "Весь документ" });
    } else {
      card.createEl("blockquote", {
        cls: "codex-review-quote",
        text: comment.quote.trim() ? shortText(comment.quote, 220) : "Пробел в месте удаления"
      });
    }
    this.renderCommentMessage(card, "user", comment.feedback, comment.filePath, comment.provider);
    if (comment.agentResponse) {
      this.renderCommentMessage(
        card,
        "codex",
        comment.agentResponse,
        comment.filePath,
        responseAgentProvider(comment),
        false,
        undefined,
        comment.respondedAt
      );
    }
    if (comment.issue) this.renderCommentIssue(card, comment.issue);
    for (const followUp of comment.followUps) {
      this.renderCommentMessage(
        card,
        "user",
        followUp.feedback,
        comment.filePath,
        comment.provider,
        isDraftFollowUp(followUp),
        isDraftFollowUp(followUp) ? (actions) => {
          iconButton(
            actions,
            "pencil",
            "Изменить дополнительный комментарий",
            () => this.plugin.editCommentFollowUp(comment.id, followUp.id)
          );
          const remove = iconButton(
            actions,
            "trash-2",
            "Удалить дополнительный комментарий",
            () => void this.plugin.deleteCommentFollowUp(comment.id, followUp.id)
          );
          remove.addClass("is-delete");
        } : undefined,
        followUp.createdAt
      );
      if (followUp.agentResponse) {
        this.renderCommentMessage(
          card,
          "codex",
          followUp.agentResponse,
          comment.filePath,
          responseAgentProvider(comment, followUp),
          false,
          undefined,
          followUp.respondedAt
        );
      }
      if (followUp.issue) this.renderCommentIssue(card, followUp.issue);
    }
    if (canAddCommentFollowUp(comment)) {
      if (this.openFollowUpCommentIds.has(comment.id)) {
        this.renderCommentFollowUpComposer(card, comment);
      } else {
        const replyRow = card.createDiv({ cls: "codex-review-comment-reply-row" });
        const reply = replyRow.createEl("button", { cls: "codex-review-comment-reply", text: "Добавить" });
        reply.addEventListener("click", () => {
          void this.plugin.acknowledgeCommentAttention(comment.id);
          this.openFollowUpCommentIds.clear();
          this.openFollowUpCommentIds.add(comment.id);
          this.render();
          window.requestAnimationFrame(() => {
            this.containerEl.querySelector<HTMLTextAreaElement>(
              `.codex-review-comment-follow-up textarea[data-comment-id="${comment.id}"]`
            )?.focus();
          });
        });
      }
    }
    renderCommentStatus(card, comment);
  }

  private renderCommentMessage(
    parent: HTMLElement,
    role: "user" | "codex",
    text: string,
    sourcePath: string,
    provider: AgentProvider | undefined,
    draft = false,
    renderActions?: (actions: HTMLElement) => void,
    timestamp?: string
  ): void {
    const message = parent.createDiv({ cls: `codex-review-comment-message is-${role}` });
    const label = message.createDiv({ cls: "codex-review-comment-message-label" });
    setIcon(label.createSpan(), role === "user" ? "user-round" : "bot");
    label.createSpan({
      text: role === "user" ? "Вы" : agentName(normalizeAgentProvider(provider ?? this.plugin.getFileProvider(sourcePath)))
    });
    const formattedTimestamp = formatCommentTimestamp(timestamp);
    if (formattedTimestamp) {
      const time = label.createEl("time", { cls: "codex-review-comment-message-time", text: formattedTimestamp });
      time.dateTime = timestamp ?? "";
    }
    if (draft) label.createSpan({ cls: "codex-review-comment-draft-label", text: "Ожидает отправки" });
    if (renderActions) {
      const actions = label.createDiv({ cls: "codex-review-comment-message-actions" });
      renderActions(actions);
    }
    const content = message.createDiv({
      cls: `codex-review-comment-message-text is-${role}${role === "codex" ? " markdown-rendered" : ""}`
    });
    if (role === "codex") {
      void MarkdownRenderer.render(this.app, text, content, sourcePath, this);
    } else {
      content.setText(text);
    }
  }

  private renderCommentIssue(parent: HTMLElement, issue: ReviewCommentIssue): void {
    const notice = parent.createDiv({ cls: `codex-review-comment-issue is-${issue.kind}` });
    setIcon(notice.createSpan(), isRetryableCommentIssue(issue) ? "refresh-cw" : "circle-alert");
    const text = notice.createDiv({ cls: "codex-review-comment-issue-text" });
    text.createDiv({
      cls: "codex-review-comment-issue-label",
      text: commentIssueLabel(issue)
    });
    text.createDiv({ text: issue.message });
  }

  private renderCommentFollowUpComposer(parent: HTMLElement, comment: ReviewComment): void {
    const composer = parent.createDiv({ cls: "codex-review-comment-follow-up" });
    const inputWrap = composer.createDiv({ cls: "codex-review-skill-mention-host codex-review-comment-follow-up-input" });
    const input = inputWrap.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: "Добавить комментарий",
        "aria-label": "Добавить комментарий",
        "data-comment-id": comment.id
      }
    });
    input.value = this.commentFollowUpDrafts.get(comment.id) ?? "";
    input.addEventListener("input", () => this.commentFollowUpDrafts.set(comment.id, input.value));
    const skillMentions = new SkillMentionAutocomplete(
      input,
      this.plugin,
      () => this.plugin.getFileProvider(comment.filePath)
    );
    const insertSkill = iconButton(
      inputWrap,
      "sparkles",
      "Выбрать навык агента",
      () => void skillMentions.startMention()
    );
    insertSkill.addClass("codex-review-skill-trigger");
    const actions = composer.createDiv({ cls: "codex-review-comment-follow-up-actions" });
    const cancel = actions.createEl("button", { text: "Отмена", cls: "codex-review-cancel-follow-up" });
    cancel.addEventListener("click", () => {
      this.openFollowUpCommentIds.delete(comment.id);
      this.render();
    });
    const save = actions.createEl("button", {
      text: "Добавить",
      cls: "codex-review-save-follow-up",
      attr: { "aria-label": "Добавить дополнительный комментарий" }
    });
    save.title = "Добавить дополнительный комментарий";
    const submit = async () => {
      if (save.disabled) return;
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      save.disabled = true;
      const saved = await this.plugin.saveCommentFollowUp(comment.id, text);
      if (saved) {
        this.commentFollowUpDrafts.delete(comment.id);
        this.openFollowUpCommentIds.delete(comment.id);
        this.render();
      } else {
        save.disabled = false;
      }
    };
    save.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void submit();
      }
    });
  }
}

class CodexReviewSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CodexReviewPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Agent Review" });

    new Setting(containerEl)
      .setName("Команда Codex CLI")
      .setDesc(`Найдено: ${resolveCodexCommand(this.plugin.data.settings.codexCommand)}. Если команда не найдена, укажите полный путь к исполняемому файлу.`)
      .addText((text) => text
        .setPlaceholder("codex или полный путь к файлу")
        .setValue(this.plugin.data.settings.codexCommand)
        .onChange(async (value) => {
          this.plugin.data.settings.codexCommand = value.trim() || "codex";
          this.plugin.resetCodexClient();
          await this.plugin.persist();
        }));

    new Setting(containerEl)
      .setName("Claude Code")
      .setDesc([
        `Найдено: ${resolveClaudeCommand(this.plugin.data.settings.claudeCommand)}.`,
        isClaudeLoggedIn() ? "Вход выполнен." : "Требуется вход в Claude Code.",
        "Если команда не найдена, укажите полный путь к исполняемому файлу."
      ].join(" "))
      .addText((text) => text
        .setPlaceholder("claude или полный путь к файлу")
        .setValue(this.plugin.data.settings.claudeCommand)
        .onChange(async (value) => {
          this.plugin.data.settings.claudeCommand = value.trim() || "claude";
          this.plugin.resetAgentClient("claude");
          await this.plugin.persist();
        }));

    const file = this.plugin.getActiveMarkdownFile();
    if (file) {
      new Setting(containerEl)
        .setName("Агент текущего файла")
        .addDropdown((dropdown) => dropdown
          .addOption("codex", "Codex")
          .addOption("claude", "Claude")
          .setValue(this.plugin.getFileProvider(file.path))
          .onChange(async (value) => {
            await this.plugin.setFileProvider(file.path, normalizeAgentProvider(value));
            this.display();
          }));
    }
    const target = file ? this.plugin.getFileThread(file.path) : undefined;
    new Setting(containerEl)
      .setName("Задача текущего файла")
      .setDesc(target?.threadLabel || "Не выбрана")
      .addButton((button) => button.setButtonText("Выбрать").onClick(() => this.plugin.chooseThread(() => this.display())));

    new Setting(containerEl)
      .setName("Подключение")
      .addButton((button) => button.setButtonText("Проверить").onClick(async () => {
        button.setDisabled(true);
        try {
          const provider = file ? this.plugin.getFileProvider(file.path) : "codex";
          const client = this.plugin.getAgentClient(provider);
          const result = await client.readAccount();
          const account = result.account;
          if (account) {
            const version = account.version ? `, ${account.version}` : "";
            new Notice(`${agentName(provider)} подключён${account.email ? `: ${account.email}` : ""}${version}`);
          } else if (result.requiresOpenaiAuth && provider === "codex") {
            new LoginModal(this.app, client as CodexAppServerClient, () => this.display()).open();
          } else {
            new Notice(`${agentName(provider)} доступен`);
          }
        } catch (error) {
          const provider = file ? this.plugin.getFileProvider(file.path) : "codex";
          if (!this.plugin.showAgentConnectionError(error, provider, () => this.display())) {
            new Notice(error instanceof Error ? error.message : String(error), 10000);
          }
        } finally {
          button.setDisabled(false);
        }
      }));
  }
}

export default class CodexReviewPlugin extends Plugin {
  data: CodexReviewData = structuredClone(DEFAULT_DATA);
  highlightRevision = 0;
  private agentClients = new Map<AgentProvider, AgentClient>();
  private stopAgentNotifications = new Map<AgentProvider, () => void>();
  private sidebarRefreshFrame: number | null = null;
  private sidebarActivityRefreshFrame: number | null = null;
  private pendingActivityRefreshPaths = new Set<string>();
  private editorRefreshFrame: number | null = null;
  private editorAnchorSaveTimer: number | null = null;
  private models: CodexModelOption[] = [];
  private modelsProvider: AgentProvider | null = null;
  private modelStatus: "idle" | "loading" | "ready" | "error" = "idle";
  private skills: CodexSkillOption[] = [];
  private skillsProvider: AgentProvider | null = null;
  private skillStatus: "idle" | "loading" | "ready" | "error" = "idle";
  private histories = new Map<string, CodexThreadHistory>();
  private editorSurfaces = new Set<EditorReviewSurface>();
  private navigationCommentIds = new Map<string, string>();
  private stoppingTurnIds = new Set<string>();
  private queuedReviewFiles = new Set<string>();
  private documentTokenEstimates = new Map<string, { length: number; tokens: number }>();
  private lastEditorSelection: EditorSelectionSnapshot | null = null;
  private readonly clipboardAttachments = new ClipboardAttachmentStore();

  async onload(): Promise<void> {
    const stored = (await this.loadData()) as Partial<CodexReviewData> | null;
    const storedSettings = stored?.settings as Partial<CodexReviewSettings> | undefined;
    const storedFileProviders = normalizeFileProviders(storedSettings?.fileProviders);
    const storedFileThreads = normalizeFileTaskSelections(storedSettings?.fileThreads, storedFileProviders);
    const rawActivities = stored?.activities && typeof stored.activities === "object" && !Array.isArray(stored.activities)
      ? stored.activities
      : {};
    this.data = {
      schemaVersion: 3,
      settings: {
        ...DEFAULT_SETTINGS,
        codexCommand: typeof storedSettings?.codexCommand === "string" ? storedSettings.codexCommand : "codex",
        claudeCommand: typeof storedSettings?.claudeCommand === "string" ? storedSettings.claudeCommand : "claude",
        threadId: typeof storedSettings?.threadId === "string" ? storedSettings.threadId : "",
        threadLabel: typeof storedSettings?.threadLabel === "string" ? storedSettings.threadLabel : "",
        fileThreads: storedFileThreads,
        fileProviders: storedFileProviders,
        fileModels: normalizeFileAgentStrings(storedSettings?.fileModels, storedFileProviders),
        fileContexts: normalizeFileContexts(storedSettings?.fileContexts),
        fileGoals: normalizeFileAgentStrings(storedSettings?.fileGoals, storedFileProviders),
        instructions: normalizeInstructionSettings(storedSettings?.instructions)
      },
      comments: Array.isArray(stored?.comments) ? stored.comments.map(normalizeComment) : [],
      activities: Object.fromEntries(
        Object.entries(rawActivities).map(([filePath, activity]) => [filePath, normalizeActivity(activity, filePath)])
      ),
      inlineChanges: Array.isArray(stored?.inlineChanges)
        ? stored.inlineChanges.flatMap((value) => {
            const normalized = normalizeInlineChange(value);
            return normalized ? [normalized] : [];
          })
        : [],
      appliedChanges: Array.isArray(stored?.appliedChanges)
        ? stored.appliedChanges.flatMap((value) => {
            const normalized = normalizeInlineChange(value);
            return normalized ? [normalized] : [];
          })
        : [],
      versions: Array.isArray(stored?.versions)
        ? stored.versions.flatMap((value) => {
            const normalized = normalizeDocumentVersion(value);
            return normalized ? [normalized] : [];
          })
        : [],
      queuedMessages: stored?.queuedMessages && typeof stored.queuedMessages === "object"
        ? stored.queuedMessages
        : {}
    };
    for (const [filePath, selections] of Object.entries(this.data.settings.fileThreads)) {
      const providers = (["codex", "claude"] as const).filter((provider) => Boolean(selections[provider]));
      for (const provider of providers) selections[provider]!.provider = provider;
      if (!Object.prototype.hasOwnProperty.call(this.data.settings.fileProviders, filePath) && providers[0]) {
        this.data.settings.fileProviders[filePath] = providers[0];
      }
    }
    let interruptedAfterShutdown = false;
    const recoveredAt = new Date().toISOString();
    for (const activity of Object.values(this.data.activities)) {
      if (this.endInterruptedActivity(activity, recoveredAt)) interruptedAfterShutdown = true;
    }
    const hasLegacySkills = Array.isArray(stored?.comments) && stored.comments.some((comment: any) =>
      Boolean(comment?.skill) || (Array.isArray(comment?.followUps) && comment.followUps.some((followUp: any) => Boolean(followUp?.skill)))
    );
    let migrated = stored?.schemaVersion !== 3 || interruptedAfterShutdown || hasLegacySkills || Boolean(storedSettings && (
      !Object.prototype.hasOwnProperty.call(storedSettings, "claudeCommand")
      || !Object.prototype.hasOwnProperty.call(storedSettings, "fileProviders")
      || !Object.prototype.hasOwnProperty.call(storedSettings, "fileContexts")
      || !Object.prototype.hasOwnProperty.call(storedSettings, "fileGoals")
      || !Object.prototype.hasOwnProperty.call(storedSettings, "instructions")
      || Object.prototype.hasOwnProperty.call(storedSettings, "includeLinkedNotes")
      || Object.prototype.hasOwnProperty.call(storedSettings, "maxLinkedNotes")
    ));
    if (backfillReviewResponseRoutes(this.data.activities, this.data.comments)) migrated = true;
    for (const record of backfillVersionsFromActivities(this.data.activities)) {
      if (this.recordVersion(record.filePath, record.text, record.source, record.createdAt, {
        originId: record.originId
      })) migrated = true;
    }
    const restoredChanges = backfillInlineChangesFromActivities(
      this.data.activities,
      this.data.comments,
      this.data.inlineChanges,
      makeId
    );
    if (restoredChanges.length > 0) {
      this.data.inlineChanges.push(...restoredChanges);
      migrated = true;
    }
    const relocatedAt = new Date().toISOString();
    for (const activity of Object.values(this.data.activities)) {
      if (relocateTurnCommentAnchors(activity, this.data.comments, relocatedAt)) migrated = true;
    }
    if (migrated) {
      await this.saveData(this.data);
    }

    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewSidebarView(leaf, this));
    addIcon("codex-review", `
      <path d="M14 25h25a10 10 0 0 1 10 10v21a10 10 0 0 1-10 10H27L15 77V66h-1A10 10 0 0 1 4 56V35a10 10 0 0 1 10-10Z" fill="currentColor" stroke="none" />
      <path d="M62 32h20a12 12 0 0 1 12 12v26a12 12 0 0 1-12 12H62a12 12 0 0 1-12-12V44a12 12 0 0 1 12-12Z" fill="none" stroke="currentColor" stroke-width="6" />
      <path d="M72 32V22" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
      <circle cx="72" cy="17" r="4" fill="currentColor" stroke="none" />
      <path d="M50 51h-5M94 51h5" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
      <circle cx="63" cy="54" r="4" fill="currentColor" stroke="none" />
      <circle cx="81" cy="54" r="4" fill="currentColor" stroke="none" />
      <path d="M62 68c2.8 2.5 6.1 3.7 10 3.7s7.2-1.2 10-3.7" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none" />
    `);
    this.addRibbonIcon("codex-review", "Agent Review", () => void this.activateSidebar("history"));
    this.addCommand({
      id: "add-comment",
      name: "Добавить комментарий для агента",
      editorCallback: (editor, info) => this.addComment(editor, info.file)
    });
    this.addCommand({
      id: "add-document-comment",
      name: "Добавить комментарий ко всему документу",
      callback: () => this.addDocumentComment()
    });
    this.addCommand({
      id: "open-sidebar",
      name: "Открыть комментарии, чат и версии",
      callback: () => void this.activateSidebar("history")
    });
    this.addCommand({ id: "send-feedback", name: "Отправить комментарии", callback: () => void this.sendFeedback() });
    this.addCommand({
      id: "clear-current-file-review-data",
      name: "Очистить данные текущего файла",
      callback: () => {
        const file = this.getActiveMarkdownFile();
        if (file) this.confirmClearFileData(file.path);
        else new Notice("Откройте Markdown-файл");
      }
    });
    this.addCommand({ id: "next-comment", name: "Следующее замечание", callback: () => void this.navigateComment(1) });
    this.addCommand({ id: "previous-comment", name: "Предыдущее замечание", callback: () => void this.navigateComment(-1) });
    this.addCommand({
      id: "stop-processing",
      name: "Остановить обработку агента",
      callback: () => {
        const file = this.getActiveMarkdownFile();
        if (file) void this.stopProcessing(file.path);
      }
    });
    this.registerEvent((this.app.workspace as any).on(
      "editor-menu",
      (menu: Menu, editor: Editor, info: { file?: TFile | null }) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) => item
          .setTitle("Комментарий для агента")
          .setIcon("message-square-plus")
          .onClick(() => this.addComment(editor, info.file ?? null)));
      }
    ));
    this.registerEditorExtension(this.createHighlightExtension());
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!(leaf?.view instanceof ReviewSidebarView)) this.refreshSidebar();
      this.scheduleEditorRefresh();
      if (this.getActiveMarkdownFile()) void this.loadModels();
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleEditorRefresh()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.refreshSidebar()));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.scheduleEditorRefresh();
      const active = this.getActiveMarkdownFile();
      if (active) void this.loadModels();
      if (active && !isBusyActivity(this.data.activities[active.path])) {
        if (this.queuedReviewFiles.has(active.path)) void this.sendQueuedReviewBatch(active.path);
        else void this.sendNextQueuedMessage(active.path);
      }
    }));
    this.app.workspace.onLayoutReady(() => {
      this.scheduleEditorRefresh();
      void this.loadModels();
    });
    this.addSettingTab(new CodexReviewSettingTab(this.app, this));
  }

  private endInterruptedActivity(activity: CodexActivity, completedAt: string): boolean {
    return finishInterruptedActivity(
      activity,
      this.data.comments,
      completedAt,
      OBSIDIAN_CLOSED_ACTIVITY_MESSAGE,
      "Obsidian закрылся во время обработки. Комментарий возвращён в очередь отправки."
    );
  }

  onunload(): void {
    const interruptedAt = new Date().toISOString();
    let interrupted = false;
    for (const activity of Object.values(this.data.activities)) {
      if (this.endInterruptedActivity(activity, interruptedAt)) interrupted = true;
    }
    if (interrupted) void this.saveData(this.data);
    for (const stop of this.stopAgentNotifications.values()) stop();
    this.stopAgentNotifications.clear();
    if (this.sidebarRefreshFrame !== null) window.cancelAnimationFrame(this.sidebarRefreshFrame);
    if (this.sidebarActivityRefreshFrame !== null) window.cancelAnimationFrame(this.sidebarActivityRefreshFrame);
    if (this.editorRefreshFrame !== null) window.cancelAnimationFrame(this.editorRefreshFrame);
    if (this.editorAnchorSaveTimer !== null) window.clearTimeout(this.editorAnchorSaveTimer);
    void this.clipboardAttachments.dispose();
    for (const client of this.agentClients.values()) client.close();
    this.agentClients.clear();
  }

  private createHighlightExtension() {
    return [
      createReviewDecorationField((path, text) => this.buildDecorations(path, text)),
      createPendingHighlightField(),
      ViewPlugin.define((view) => new EditorReviewSurface(view, this)),
      EditorView.domEventHandlers({
        click: (event, view) => this.handleReviewEditorClick(event, view)
      }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const markdown = this.getMarkdownViewForEditor(update.view);
        if (!markdown?.file) return;
        const selection = update.state.selection.main;
        if (selection.empty) {
          if (update.view.hasFocus && this.lastEditorSelection?.filePath === markdown.file.path) {
            this.lastEditorSelection = null;
            this.refreshEditorSelectionActions();
          }
          return;
        }
        this.lastEditorSelection = this.mapEditorSelection(update.view, markdown, selection);
      })
    ];
  }

  private handleReviewEditorClick(event: MouseEvent, view: EditorView): boolean {
    if (event.button !== 0) return false;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const reviewElement = target.closest<HTMLElement>(
      "[data-codex-review-id], [data-codex-review-comment-id]"
    );
    if (!reviewElement || !view.dom.contains(reviewElement)) return false;
    const commentId = reviewElement.dataset.codexReviewId
      ?? reviewElement.dataset.codexReviewCommentId?.split(" ").find(Boolean);
    if (!commentId || !this.data.comments.some((comment) => comment.id === commentId)) return false;
    this.focusMarginCommentFromEditor(commentId, view, true);
    return false;
  }

  private focusMarginCommentFromEditor(
    commentId: string,
    editorView: EditorView,
    acknowledgeAttention = true
  ): void {
    for (const surface of this.editorSurfaces) {
      if (surface.owns(editorView)) surface.focusComment(commentId, acknowledgeAttention);
    }
  }

  registerEditorSurface(surface: EditorReviewSurface): void {
    this.editorSurfaces.add(surface);
  }

  unregisterEditorSurface(surface: EditorReviewSurface): void {
    this.editorSurfaces.delete(surface);
  }

  refreshEditorSelectionActions(): void {
    for (const surface of this.editorSurfaces) surface.refreshSelectionAction();
  }

  private getMarkdownViewForEditor(editorView: EditorView): MarkdownView | null {
    const markdownViews = this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((candidate): candidate is MarkdownView => candidate instanceof MarkdownView);
    const direct = markdownViews.find((candidate) =>
      (candidate.editor as Editor & { cm?: EditorView }).cm === editorView
    );
    if (direct) return direct;

    const sourceView = editorView.dom.closest<HTMLElement>(".markdown-source-view.mod-cm6");
    if (!sourceView) return null;
    const containingView = markdownViews.find((candidate) => candidate.containerEl.contains(sourceView));
    if (containingView) return containingView;
    if (sourceView.querySelector(".cm-editor") !== editorView.dom) return null;

    const documentText = editorView.state.doc.toString();
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.editor.getValue() === documentText) return active;
    const matchingText = markdownViews.filter((candidate) => candidate.editor.getValue() === documentText);
    return matchingText.length === 1 ? matchingText[0] : null;
  }

  isPrimaryMarkdownEditor(editorView: EditorView): boolean {
    const markdown = this.getMarkdownViewForEditor(editorView);
    if (!markdown) return false;
    if ((markdown.editor as Editor & { cm?: EditorView }).cm === editorView) return true;
    const sourceView = editorView.dom.closest<HTMLElement>(".markdown-source-view.mod-cm6");
    return Boolean(sourceView && sourceView.querySelector(".cm-editor") === editorView.dom);
  }

  private mapEditorSelection(
    editorView: EditorView,
    markdown: MarkdownView,
    selection: { from: number; to: number }
  ): EditorSelectionSnapshot | null {
    const editorText = editorView.state.doc.toString();
    const quote = editorText.slice(selection.from, selection.to);
    if (!quote || !markdown.file) return null;
    const documentText = markdown.editor.getValue();
    if (this.isPrimaryMarkdownEditor(editorView)) {
      return {
        filePath: markdown.file.path,
        quote,
        from: selection.from,
        to: selection.to,
        text: documentText,
        editorView,
        localTo: selection.to
      };
    }

    const cursor = markdown.editor.posToOffset(markdown.editor.getCursor("from"));
    const candidates: Array<{ from: number; to: number }> = [];
    let offset = documentText.indexOf(editorText);
    while (offset !== -1) {
      candidates.push({ from: offset + selection.from, to: offset + selection.to });
      offset = documentText.indexOf(editorText, offset + 1);
    }
    if (candidates.length === 0) {
      offset = documentText.indexOf(quote);
      while (offset !== -1) {
        candidates.push({ from: offset, to: offset + quote.length });
        offset = documentText.indexOf(quote, offset + 1);
      }
    }
    if (candidates.length === 0) return null;
    const mapped = candidates.reduce((best, candidate) =>
      Math.abs(candidate.from - cursor) < Math.abs(best.from - cursor) ? candidate : best
    );
    return {
      filePath: markdown.file.path,
      quote: documentText.slice(mapped.from, mapped.to),
      from: mapped.from,
      to: mapped.to,
      text: documentText,
      editorView,
      localTo: selection.to
    };
  }

  getExternalEditorSelection(filePath: string, ownerView: EditorView): EditorSelectionSnapshot | null {
    const selection = this.lastEditorSelection;
    if (!selection || selection.filePath !== filePath || selection.editorView === ownerView) return null;
    if (!selection.editorView.dom.isConnected || !selection.editorView.hasFocus) return null;
    return selection;
  }

  getEditorFilePath(editorView: EditorView): string | null {
    return this.getMarkdownViewForEditor(editorView)?.file?.path ?? null;
  }

  isEditorMode(editorView: EditorView): boolean {
    return this.getMarkdownViewForEditor(editorView)?.getMode() === "source";
  }

  isActiveMarkdownPreview(): boolean {
    const file = this.getActiveMarkdownFile();
    return Boolean(file && this.findOpenMarkdownView(file.path)?.getMode() === "preview");
  }

  private buildDecorations(path: string, text: string): DecorationSet {
    const activeComments = this.data.comments
      .filter((comment) => comment.filePath === path && comment.kind === "selection")
      .filter((comment) => comment.status !== "resolved" && comment.status !== "accepted");
    const commentRanges = activeComments
      .map((comment) => ({ comment, location: locateComment(text, comment) }))
      .filter((item): item is { comment: ReviewComment; location: { from: number; to: number } } => item.location !== null)
      .map((item) => {
        if (item.location.from >= item.location.to) {
          return Decoration.widget({
            widget: new CommentPointWidget(item.comment, item.location.from),
            side: 1
          }).range(item.location.from);
        }
        return Decoration.mark({
          class: item.comment.status === "addressed"
            || (item.comment.status === "needs_attention" && !commentHasUnreadAttention(item.comment))
            ? "codex-review-highlight"
            : `codex-review-highlight is-${item.comment.status}`,
          attributes: {
            "data-codex-review-id": item.comment.id,
            "data-codex-review-from": String(item.location.from)
          }
        }).range(item.location.from, item.location.to);
      });
    const activeCommentIds = new Set(this.data.comments
      .filter((comment) => comment.filePath === path)
      .filter((comment) => comment.status !== "resolved" && comment.status !== "accepted")
      .map((comment) => comment.id));
    const activeChanges = this.data.inlineChanges
      .filter((change) => change.filePath === path && activeCommentIds.has(change.commentId));
    const changeRanges = groupInlineChangesByParagraph(text, activeChanges)
      .flatMap((change) => {
        const decorations = [];
        if (change.oldText) {
          decorations.push(Decoration.widget({
            widget: new InlineChangeWidget(change),
            side: -1
          }).range(change.from));
        }
        if (change.from === change.to) return decorations;
        const mark = Decoration.mark({
          class: "codex-review-inline-new",
          attributes: {
            "data-codex-review-change-id": change.changeIds.join(" "),
            "data-codex-review-comment-id": change.commentIds.join(" "),
            "data-codex-review-from": String(change.from)
          }
        }).range(change.from, change.to);
        decorations.push(mark);
        return decorations;
      });
    return Decoration.set([...commentRanges, ...changeRanges], true);
  }

  getAgentClient(provider: AgentProvider = this.getActiveAgentProvider()): AgentClient {
    let client = this.agentClients.get(provider);
    if (!client) {
      client = provider === "claude"
        ? new ClaudeAgentClient(this.data.settings.claudeCommand)
        : new CodexAppServerClient(this.data.settings.codexCommand);
      const stop = client.onNotification((message) => {
        let changed = false;
        let shouldSave = false;
        const changedPaths = new Set<string>();
        for (const activity of Object.values(this.data.activities)) {
          if (!isBusyActivity(activity)) continue;
          if (activity.provider !== provider) continue;
          if (!applyCodexNotification(activity, message)) continue;
          changed = true;
          changedPaths.add(activity.filePath);
          if (isTerminalActivity(activity)) shouldSave = true;
        }
        if (changed) {
          if (shouldSave) this.scheduleSidebarRefresh();
          else for (const filePath of changedPaths) this.scheduleSidebarActivityRefresh(filePath);
        }
        if (shouldSave) void this.saveData(this.data);
      });
      this.agentClients.set(provider, client);
      this.stopAgentNotifications.set(provider, stop);
    }
    return client;
  }

  getCodexClient(): CodexAppServerClient {
    return this.getAgentClient("codex") as CodexAppServerClient;
  }

  resetAgentClient(provider?: AgentProvider): void {
    const providers = provider ? [provider] : [...this.agentClients.keys()];
    for (const item of providers) {
      this.stopAgentNotifications.get(item)?.();
      this.stopAgentNotifications.delete(item);
      this.agentClients.get(item)?.close();
      this.agentClients.delete(item);
    }
    this.models = [];
    this.modelsProvider = null;
    this.modelStatus = "idle";
    this.skills = [];
    this.skillsProvider = null;
    this.skillStatus = "idle";
    this.histories.clear();
  }

  showAgentConnectionError(error: unknown, provider: AgentProvider, retry: () => void): boolean {
    if (
      provider === "claude"
      && (error instanceof ClaudeNotInstalledError || error instanceof ClaudeNotLoggedInError)
    ) {
      new ClaudeSetupModal(this.app, error, this.data.settings.claudeCommand, retry).open();
      return true;
    }
    return false;
  }

  resetCodexClient(): void {
    this.resetAgentClient("codex");
  }

  async resolveClipboardAttachments(files: File[]): Promise<CodexLocalAttachment[]> {
    const resolved: CodexLocalAttachment[] = [];
    for (const file of files) {
      try {
        resolved.push(await this.clipboardAttachments.resolve(file));
      } catch (error) {
        new Notice(`Не удалось вставить ${file.name || "файл"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return resolved;
  }

  async removeClipboardAttachment(attachment: CodexLocalAttachment): Promise<void> {
    await this.clipboardAttachments.remove(attachment);
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Agent Review работает с локальным хранилищем");
    return adapter.getBasePath();
  }

  private absolutePath(relativePath: string): string {
    return vaultFilePath(this.getVaultPath(), relativePath);
  }

  private pluginDirectory(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  /**
   * Writes the snapshot the agent starts from into a working copy outside the vault notes. The
   * agent edits that copy while the user keeps editing the document itself.
   */
  private async prepareWorkingCopy(
    filePath: string,
    text: string
  ): Promise<{ path: string; absolutePath: string }> {
    const location = workingCopyLocation(this.pluginDirectory(), filePath);
    const adapter = this.app.vault.adapter;
    const segments = location.directory.split("/");
    for (let depth = segments.length - 2; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth + 1).join("/");
      if (!(await adapter.exists(directory))) await adapter.mkdir(directory);
    }
    await adapter.write(location.path, text);
    return { path: location.path, absolutePath: this.absolutePath(location.path) };
  }

  private async readWorkingCopy(path: string): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    return (await adapter.exists(path)) ? adapter.read(path) : null;
  }

  /** The document of a turn, with a token estimate kept between turns of the same file. */
  private turnDocument(filePath: string, text: string, workingCopyAbsolutePath: string): TurnDocument {
    const cached = this.documentTokenEstimates.get(filePath);
    const tokens = cached?.length === text.length ? cached.tokens : estimateTokens(text);
    this.documentTokenEstimates.set(filePath, { length: text.length, tokens });
    return { filePath, text, workingCopyAbsolutePath, tokens };
  }

  private isFirstTurn(threadId: string): boolean {
    return !threadId || this.getThreadHistory(threadId).messages.length === 0;
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
    this.highlightRevision += 1;
    this.refreshEditors();
    this.refreshSidebar();
  }

  private refreshEditors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const markdown = leaf.view;
      if (!(markdown instanceof MarkdownView)) continue;
      const cm = (markdown.editor as Editor & { cm?: EditorView }).cm;
      cm?.dispatch({
        effects: syncReviewDecorations.of({
          path: markdown.file?.path ?? null,
          revision: this.highlightRevision
        })
      });
    }
  }

  private scheduleEditorRefresh(): void {
    if (this.editorRefreshFrame !== null) return;
    this.editorRefreshFrame = window.requestAnimationFrame(() => {
      this.editorRefreshFrame = null;
      this.refreshEditors();
    });
  }

  refreshSidebarLayout(): void {
    this.scheduleEditorRefresh();
  }

  refreshSidebar(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ReviewSidebarView) view.render();
    }
    for (const surface of this.editorSurfaces) surface.refresh();
  }

  private refreshSidebarActivities(filePaths: ReadonlySet<string>): void {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof ReviewSidebarView)) continue;
      for (const filePath of filePaths) view.refreshCodexActivity(filePath);
    }
  }

  private scheduleSidebarActivityRefresh(filePath: string): void {
    this.pendingActivityRefreshPaths.add(filePath);
    if (this.sidebarRefreshFrame !== null || this.sidebarActivityRefreshFrame !== null) return;
    this.sidebarActivityRefreshFrame = window.requestAnimationFrame(() => {
      this.sidebarActivityRefreshFrame = null;
      const pending = new Set(this.pendingActivityRefreshPaths);
      this.pendingActivityRefreshPaths.clear();
      this.refreshSidebarActivities(pending);
    });
  }

  private scheduleSidebarRefresh(): void {
    this.pendingActivityRefreshPaths.clear();
    if (this.sidebarActivityRefreshFrame !== null) {
      window.cancelAnimationFrame(this.sidebarActivityRefreshFrame);
      this.sidebarActivityRefreshFrame = null;
    }
    if (this.sidebarRefreshFrame !== null) return;
    this.sidebarRefreshFrame = window.requestAnimationFrame(() => {
      this.sidebarRefreshFrame = null;
      this.refreshSidebar();
    });
  }

  private beginCodexActivity(
    file: TFile,
    threadId: string,
    options: {
      source: CodexActivity["source"];
      commentIds?: string[];
      beforeText: string;
      workingCopyPath?: string;
      requestText?: string;
      model?: string;
      followUpId?: string;
    }
  ): CodexActivity {
    const target = this.getFileThread(file.path);
    const activity = createCodexActivity(
      file.path,
      threadId,
      target?.threadLabel || file.basename,
      { ...options, provider: this.getFileProvider(file.path) }
    );
    this.data.activities[file.path] = activity;
    return activity;
  }

  private markCodexActivityFailed(activity: CodexActivity, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    failCodexActivity(activity, message);
    for (const id of activity.commentIds) {
      const target = findFeedbackTarget(this.data.comments, id);
      const status = target?.followUp?.status ?? target?.comment.status;
      if (status !== "sent") continue;
      returnFeedbackToDraft(this.data.comments, id, {
        kind: "processing_failed",
        message: `${agentName(activity.provider)} не завершил обработку: ${message}`
      });
    }
    this.scheduleSidebarRefresh();
    void this.saveData(this.data);
  }


  private recordVersion(
    filePath: string,
    text: string,
    source: ReviewVersionSource,
    createdAt = new Date().toISOString(),
    options: { originId?: string; restoredFromVersionId?: string } = {}
  ): boolean {
    const version = createDocumentVersion(filePath, text, source, makeId, createdAt, options);
    const next = appendDocumentVersion(this.data.versions, version);
    if (next === this.data.versions) return false;
    this.data.versions = next;
    return true;
  }

  getVersions(filePath?: string): ReviewDocumentVersion[] {
    return versionsForFile(this.data.versions, filePath);
  }

  async activateSidebar(panel: "comments" | "history" | "versions" = "history"): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = await this.app.workspace.ensureSideLeaf(REVIEW_VIEW_TYPE, "right", {
        active: true,
        reveal: true
      });
    }
    if (leaf.view instanceof ReviewSidebarView) leaf.view.showPanel(panel);
    this.app.workspace.rightSplit.expand();
    await this.app.workspace.revealLeaf(leaf);
    this.scheduleEditorRefresh();
  }

  isReviewSidebarVisible(): boolean {
    const leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (!leaf) return false;
    const split = this.app.workspace.rightSplit as unknown as { collapsed?: boolean };
    return !split.collapsed;
  }

  addCommentFromActiveEditor(): void {
    const snapshot = this.lastEditorSelection;
    const activePath = this.getActiveMarkdownFile()?.path;
    const snapshotFile = snapshot ? this.app.vault.getAbstractFileByPath(snapshot.filePath) : null;
    if (snapshot
      && snapshotFile instanceof TFile
      && snapshot.editorView.hasFocus
      && (!activePath || activePath === snapshot.filePath)) {
      const surface = [...this.editorSurfaces].find((candidate) => candidate.showsFile(snapshot.filePath));
      if (surface) {
        surface.startSelectionComment({ from: snapshot.from, to: snapshot.to });
        return;
      }
    }
    const view = this.findMarkdownViewForComment();
    if (view) {
      this.addComment(view.editor, view.file);
      return;
    }

    const file = snapshot ? this.app.vault.getAbstractFileByPath(snapshot.filePath) : null;
    if (snapshot && file instanceof TFile && (!activePath || activePath === snapshot.filePath)) {
      const surface = [...this.editorSurfaces].find((candidate) => candidate.showsFile(snapshot.filePath));
      if (surface) {
        surface.startSelectionComment({ from: snapshot.from, to: snapshot.to });
        return;
      }
      new Notice("Откройте файл в режиме редактирования, чтобы добавить комментарий");
      return;
    }
    new Notice(activePath ? "Выделите текст" : "Откройте Markdown-файл");
  }

  private findMarkdownViewForComment(): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.editor.getSelection()) return activeView;

    const activePath = this.getActiveMarkdownFile()?.path;
    const views = this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
    return views.find((view) => view.file?.path === activePath && Boolean(view.editor.getSelection()))
      ?? views.find((view) => Boolean(view.editor.getSelection()))
      ?? null;
  }

  confirmClearFileData(filePath: string): void {
    if (isBusyActivity(this.data.activities[filePath])) {
      new Notice(`Сначала остановите обработку ${agentName(this.data.activities[filePath].provider)}`);
      return;
    }
    const target = this.getFileThread(filePath);
    const commentCount = this.data.comments.filter((comment) => comment.filePath === filePath).length;
    const versionCount = this.data.versions.filter((version) => version.filePath === filePath).length;
    new ClearFileDataModal(
      this.app,
      filePath,
      target?.threadLabel,
      commentCount,
      versionCount,
      () => this.clearFileData(filePath)
    ).open();
  }

  private async clearFileData(filePath: string): Promise<void> {
    if (isBusyActivity(this.data.activities[filePath])) {
      new Notice(`Сначала остановите обработку ${agentName(this.data.activities[filePath].provider)}`);
      return;
    }

    const targets = Object.entries(this.data.settings.fileThreads[filePath] ?? {})
      .flatMap(([provider, target]) => target ? [{ provider: normalizeAgentProvider(provider), target }] : []);
    const removedComments = this.data.comments.filter((comment) => comment.filePath === filePath);
    const removedCommentIds = new Set(removedComments.flatMap((comment) => [
      comment.id,
      ...comment.followUps.map((followUp) => followUp.id)
    ]));

    this.data.comments = this.data.comments.filter((comment) => comment.filePath !== filePath);
    this.data.inlineChanges = this.data.inlineChanges.filter((change) => change.filePath !== filePath);
    this.data.versions = this.data.versions.filter((version) => version.filePath !== filePath);
    delete this.data.activities[filePath];
    delete this.data.settings.fileThreads[filePath];
    delete this.data.settings.fileProviders[filePath];
    delete this.data.settings.fileModels[filePath];
    delete this.data.settings.fileGoals[filePath];
    for (const { provider, target } of targets) {
      if (target.threadId) this.histories.delete(this.historyKey(target.threadId, provider));
    }
    this.navigationCommentIds.delete(filePath);
    this.pendingActivityRefreshPaths.delete(filePath);
    if (this.lastEditorSelection?.filePath === filePath) this.lastEditorSelection = null;

    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ReviewSidebarView) view.clearFileState(filePath, removedCommentIds);
    }

    await this.persist();
    new Notice("Комментарии, версии и история файла удалены");
  }

  private addComment(editor: Editor, file: TFile | null): void {
    const quote = editor.getSelection();
    if (!quote) {
      new Notice("Выделите текст");
      return;
    }
    if (!file) return;
    const cm = (editor as Editor & { cm?: EditorView }).cm;
    const surface = (cm ? [...this.editorSurfaces].find((candidate) => candidate.owns(cm)) : undefined)
      ?? [...this.editorSurfaces].find((candidate) => candidate.showsFile(file.path));
    if (surface) {
      const from = editor.posToOffset(editor.getCursor("from"));
      const to = editor.posToOffset(editor.getCursor("to"));
      surface.startSelectionComment({ from, to });
      return;
    }
    new Notice("Откройте файл в режиме редактирования, чтобы добавить комментарий");
  }

  async saveSelectionComment(comment: ReviewComment, feedback: string): Promise<string | null> {
    const normalized = feedback.trim();
    if (!normalized) return null;
    const id = makeId();
    this.data.comments.push({
      ...comment,
      id,
      feedback: normalized,
      status: "draft",
      createdAt: new Date().toISOString()
    });
    await this.persist();
    this.notifyCommentSaved(comment.filePath);
    return id;
  }

  async updateDraftComment(commentId: string, feedback: string): Promise<boolean> {
    const comment = this.data.comments.find((item) => item.id === commentId);
    const normalized = feedback.trim();
    if (!comment || !isUnsentDraftComment(comment) || !normalized) return false;
    comment.feedback = normalized;
    comment.status = "draft";
    comment.agentResponse = undefined;
    comment.respondedAt = undefined;
    await this.persist();
    return true;
  }

  addDocumentComment(): void {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return;
    }
    new CommentModal(this.app, this, file.path, "document", "", "", (feedback) => {
      this.data.comments.push({
        id: makeId(),
        filePath: file.path,
        kind: "document",
        quote: "",
        anchor: { prefix: "", quote: "", suffix: "" },
        fromOffset: 0,
        toOffset: 0,
        feedback,
        createdAt: new Date().toISOString(),
        status: "draft",
        followUps: []
      });
      void this.persist().then(() => this.notifyCommentSaved(file.path));
      void this.activateSidebar();
    }).open();
  }

  editComment(comment: ReviewComment): void {
    if (!isUnsentDraftComment(comment)) {
      new Notice("Изменить можно только комментарий, который ещё не отправлен");
      return;
    }
    new CommentModal(this.app, this, comment.filePath, comment.kind, comment.quote, comment.feedback, (feedback) => {
      comment.feedback = feedback;
      comment.status = "draft";
      comment.agentResponse = undefined;
      comment.respondedAt = undefined;
      void this.persist();
    }).open();
  }

  async deleteUnsentComment(id: string): Promise<void> {
    const comments = removeUnsentDraftComment(this.data.comments, id);
    if (comments === this.data.comments) {
      new Notice("Удалить можно только комментарий, который ещё не отправлен");
      return;
    }
    this.data.comments = comments;
    this.data.inlineChanges = this.data.inlineChanges.filter((change) => change.commentId !== id);
    this.data.appliedChanges = this.data.appliedChanges.filter((change) => change.commentId !== id);
    await this.persist();
  }

  async acceptComment(id: string): Promise<void> {
    const comment = this.data.comments.find((item) => item.id === id);
    if (!comment) return;
    const changes = this.data.inlineChanges.filter((change) => change.commentId === id);
    if (changes.length === 0) {
      new Notice("У комментария нет изменений для принятия");
      return;
    }
    const currentText = await this.readCurrentMarkdownText(comment.filePath);
    if (currentText !== null) {
      this.recordVersion(
        comment.filePath,
        currentText,
        "accepted",
        new Date().toISOString()
      );
    }
    const affectedTurnIds = new Set(changes.map((change) => change.turnId));
    comment.status = "accepted";
    clearCommentAttention(comment);
    this.data.inlineChanges = this.data.inlineChanges.filter((change) => change.commentId !== id);
    this.rememberAppliedChanges(changes);
    this.settleInlineChangeTurns(affectedTurnIds);
    await this.persist();
  }

  /**
   * Keeps accepted agent edits so that reopening the comment can undo exactly those edits later,
   * without touching what the user wrote afterwards.
   */
  private rememberAppliedChanges(changes: ReviewInlineChange[]): void {
    const acceptedIds = new Set(changes.map((change) => change.id));
    this.data.appliedChanges = [
      ...this.data.appliedChanges.filter((change) => !acceptedIds.has(change.id)),
      ...changes
    ].slice(-MAX_REMEMBERED_APPLIED_CHANGES);
  }

  hasInlineChanges(commentId: string): boolean {
    return this.data.inlineChanges.some((change) => change.commentId === commentId);
  }

  hasInlineChangesForFile(filePath: string): boolean {
    return this.data.inlineChanges.some((change) => change.filePath === filePath);
  }

  async acceptAllChanges(filePath: string): Promise<void> {
    const changes = this.data.inlineChanges.filter((change) => change.filePath === filePath);
    if (changes.length === 0) return;
    const currentText = await this.readCurrentMarkdownText(filePath);
    if (currentText === null) {
      new Notice("Markdown-файл больше не найден");
      return;
    }
    this.recordVersion(filePath, currentText, "accepted", new Date().toISOString());
    const commentIds = new Set(changes.map((change) => change.commentId));
    const turnIds = new Set(changes.map((change) => change.turnId));
    for (const comment of this.data.comments) {
      if (!commentIds.has(comment.id)) continue;
      comment.status = "accepted";
      clearCommentAttention(comment);
    }
    this.data.inlineChanges = this.data.inlineChanges.filter((change) => change.filePath !== filePath);
    this.rememberAppliedChanges(changes);
    this.settleInlineChangeTurns(turnIds);
    await this.persist();
    new Notice("Все правки приняты");
  }

  async cancelCommentChanges(id: string): Promise<void> {
    const comment = this.data.comments.find((item) => item.id === id);
    if (!comment) return;
    const changes = this.data.inlineChanges.filter((change) => change.commentId === id);
    if (changes.length === 0) {
      new Notice("У комментария нет изменений для отмены");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(comment.filePath);
    if (!(file instanceof TFile)) {
      new Notice("Markdown-файл больше не найден");
      return;
    }

    const openView = this.findOpenMarkdownView(comment.filePath);
    const currentText = openView?.editor.getValue() ?? await this.app.vault.read(file);
    const reverted = revertInlineChanges(currentText, changes);
    if (reverted.revertedIds.length === 0) {
      new Notice("Изменённые фрагменты больше не удалось найти в тексте");
      return;
    }

    const changedAt = new Date();
    this.recordVersion(comment.filePath, currentText, "before_cancel", changedAt.toISOString());
    await this.replaceMarkdownText(file, reverted.text, openView);
    this.relocateFileCommentAnchors(comment.filePath, currentText, reverted.text);
    const revertedIds = new Set(reverted.revertedIds);
    const affectedTurnIds = new Set(changes
      .filter((change) => revertedIds.has(change.id))
      .map((change) => change.turnId));
    this.data.inlineChanges = refreshInlineChangeLocations(
      reverted.text,
      this.data.inlineChanges.filter((change) => !revertedIds.has(change.id))
    );
    this.settleInlineChangeTurns(affectedTurnIds);
    this.recordVersion(
      comment.filePath,
      reverted.text,
      "cancelled",
      new Date(changedAt.getTime() + 1).toISOString()
    );
    comment.status = "resolved";
    clearCommentAttention(comment);
    await this.persist();
    new Notice(reverted.unresolvedIds.length > 0
      ? "Часть изменений отменена; некоторые фрагменты уже были изменены вручную"
      : "Изменения агента отменены");
  }

  openRestoreVersion(version: ReviewDocumentVersion): void {
    new RestoreVersionModal(this.app, version, () => this.restoreVersion(version)).open();
  }

  private async restoreVersion(version: ReviewDocumentVersion): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(version.filePath);
    if (!(file instanceof TFile)) {
      new Notice("Markdown-файл больше не найден");
      return;
    }
    const openView = this.findOpenMarkdownView(version.filePath);
    const currentText = openView?.editor.getValue() ?? await this.app.vault.read(file);
    if (currentText === version.text) {
      new Notice("Эта версия уже открыта в файле");
      return;
    }

    const restoredAt = new Date();
    this.recordVersion(version.filePath, currentText, "before_restore", restoredAt.toISOString());
    await this.replaceMarkdownText(file, version.text, openView);
    this.relocateFileCommentAnchors(version.filePath, currentText, version.text);

    const removedChanges = this.data.inlineChanges.filter((change) => change.filePath === version.filePath);
    const affectedCommentIds = new Set(removedChanges.map((change) => change.commentId));
    const affectedTurnIds = new Set(removedChanges.map((change) => change.turnId));
    this.data.inlineChanges = this.data.inlineChanges.filter((change) => change.filePath !== version.filePath);
    this.data.appliedChanges = this.data.appliedChanges.filter((change) => change.filePath !== version.filePath);
    this.settleInlineChangeTurns(affectedTurnIds);
    for (const comment of this.data.comments) {
      if (!affectedCommentIds.has(comment.id)) continue;
      if (comment.status !== "accepted") {
        comment.status = "resolved";
        clearCommentAttention(comment);
      }
    }
    this.recordVersion(
      version.filePath,
      version.text,
      "restored",
      new Date(restoredAt.getTime() + 1).toISOString(),
      { restoredFromVersionId: version.id }
    );
    await this.persist();
    new Notice(`Версия от ${formatVersionDate(version.createdAt)} восстановлена`);
  }

  private findOpenMarkdownView(filePath: string): MarkdownView | undefined {
    return this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === filePath);
  }

  private async readCurrentMarkdownText(filePath: string): Promise<string | null> {
    const openView = this.findOpenMarkdownView(filePath);
    if (openView) return openView.editor.getValue();
    const file = this.app.vault.getAbstractFileByPath(filePath);
    return file instanceof TFile ? this.app.vault.read(file) : null;
  }

  private async replaceMarkdownText(
    file: TFile,
    text: string,
    openView = this.findOpenMarkdownView(file.path)
  ): Promise<void> {
    if (!openView) {
      await this.app.vault.modify(file, text);
      return;
    }
    const cm = (openView.editor as Editor & { cm?: EditorView }).cm;
    if (cm) {
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
    } else {
      openView.editor.setValue(text);
    }
  }

  private settleInlineChangeTurns(turnIds: Set<string>): void {
    if (turnIds.size === 0) return;
    const settledAt = new Date().toISOString();
    for (const activity of Object.values(this.data.activities)) {
      const turnId = activityChangeTurnId(activity);
      if (!turnIds.has(turnId)) continue;
      if (this.data.inlineChanges.some((change) => change.turnId === turnId)) continue;
      activity.inlineChangesSettledAt = settledAt;
    }
  }

  private relocateFileCommentAnchors(filePath: string, beforeText: string, afterText: string): boolean {
    let changed = false;
    for (const comment of this.data.comments) {
      if (comment.filePath !== filePath || comment.kind !== "selection") continue;
      const location = relocateComment(beforeText, afterText, comment);
      if (!location) continue;
      const quote = afterText.slice(location.from, location.to);
      const anchor = createAnchor(afterText, location.from, location.to);
      if (
        comment.fromOffset === location.from
        && comment.toOffset === location.to
        && comment.quote === quote
        && comment.anchor.prefix === anchor.prefix
        && comment.anchor.quote === anchor.quote
        && comment.anchor.suffix === anchor.suffix
      ) continue;
      comment.fromOffset = location.from;
      comment.toOffset = location.to;
      comment.quote = quote;
      comment.anchor = anchor;
      changed = true;
    }
    return changed;
  }

  trackManualDocumentChange(filePath: string, beforeText: string, afterText: string): void {
    if (beforeText === afterText || !this.relocateFileCommentAnchors(filePath, beforeText, afterText)) return;
    if (this.editorAnchorSaveTimer !== null) window.clearTimeout(this.editorAnchorSaveTimer);
    this.editorAnchorSaveTimer = window.setTimeout(() => {
      this.editorAnchorSaveTimer = null;
      void this.saveData(this.data);
    }, 350);
  }

  async reopenComment(id: string): Promise<void> {
    const comment = this.data.comments.find((item) => item.id === id);
    if (!comment) return;
    comment.status = "addressed";
    clearCommentAttention(comment);
    await this.restoreAcceptedChanges(comment);
    await this.persist();
  }

  /**
   * Brings the accepted agent edits of a comment back as pending changes, so they can be cancelled
   * one by one. Edits the user has rewritten since are dropped instead of being forced back.
   */
  private async restoreAcceptedChanges(comment: ReviewComment): Promise<void> {
    const accepted = this.data.appliedChanges.filter((change) => change.commentId === comment.id);
    if (accepted.length === 0) return;
    this.data.appliedChanges = this.data.appliedChanges.filter((change) => change.commentId !== comment.id);
    const currentText = await this.readCurrentMarkdownText(comment.filePath);
    if (currentText === null) return;
    const restored = refreshInlineChangeLocations(currentText, accepted)
      .filter((change) => locateInlineChange(currentText, change) !== null);
    if (restored.length === 0) {
      new Notice("Изменённые фрагменты уже переписаны вручную, отменять нечего");
      return;
    }
    this.data.inlineChanges = [...this.data.inlineChanges, ...restored];
  }

  async resolveComment(id: string): Promise<void> {
    const comment = this.data.comments.find((item) => item.id === id);
    if (!comment) return;
    comment.status = "resolved";
    clearCommentAttention(comment);
    await this.persist();
  }

  async retryFeedback(id: string): Promise<void> {
    const target = findFeedbackTarget(this.data.comments, id);
    if (!target) return;
    const issue = target.followUp?.issue ?? target.comment.issue;
    if (issue?.kind !== "missing_response") return;
    prepareFeedbackForRetry(this.data.comments, id);
    await this.persist();
  }

  async saveCommentFollowUp(commentId: string, text: string): Promise<boolean> {
    const comment = this.data.comments.find((item) => item.id === commentId);
    const feedback = text.trim();
    if (!comment || !feedback) return false;
    prepareCommentForFollowUp(comment);
    comment.followUps.push({
      id: makeId(),
      feedback,
      createdAt: new Date().toISOString(),
      status: "draft"
    });
    await this.persist();
    this.notifyCommentSaved(comment.filePath);
    return true;
  }

  private notifyCommentSaved(filePath: string): void {
    new Notice(isBusyActivity(this.data.activities[filePath])
      ? "Комментарий сохранён и готов к отправке после завершения текущей обработки"
      : "Комментарий сохранён");
  }

  editCommentFollowUp(commentId: string, followUpId: string): void {
    const comment = this.data.comments.find((item) => item.id === commentId);
    const followUp = comment?.followUps.find((item) => item.id === followUpId);
    if (!comment || !followUp || !isDraftFollowUp(followUp)) return;
    new CommentModal(this.app, this, comment.filePath, "document", "", followUp.feedback, (feedback) => {
      if (!updateDraftFollowUp(this.data.comments, commentId, followUpId, feedback)) return;
      void this.persist().then(() => new Notice("Дополнительный комментарий изменён"));
    }).open();
  }

  async deleteCommentFollowUp(commentId: string, followUpId: string): Promise<void> {
    if (!removeDraftFollowUp(this.data.comments, commentId, followUpId)) return;
    await this.persist();
    new Notice("Дополнительный комментарий удалён");
  }

  getNavigableComments(filePath?: string): ReviewComment[] {
    if (!filePath) return [];
    return this.data.comments
      .filter((comment) => comment.filePath === filePath)
      .filter((comment) => comment.status !== "accepted" && comment.status !== "resolved")
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "document" ? -1 : 1;
        return left.fromOffset - right.fromOffset || left.createdAt.localeCompare(right.createdAt);
      });
  }

  async navigateComment(direction: -1 | 1): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return;
    }
    const comments = this.getNavigableComments(file.path);
    if (comments.length === 0) {
      new Notice("В файле нет активных замечаний");
      return;
    }
    const currentId = this.navigationCommentIds.get(file.path);
    const currentIndex = comments.findIndex((comment) => comment.id === currentId);
    const nextIndex = currentIndex >= 0
      ? (currentIndex + direction + comments.length) % comments.length
      : direction === 1 ? 0 : comments.length - 1;
    await this.revealComment(comments[nextIndex]);
  }

  async revealFirstAttentionComment(filePath: string): Promise<void> {
    const comment = this.getNavigableComments(filePath).find(commentHasUnreadAttention);
    if (!comment) return;
    await this.revealComment(comment);
  }

  async acknowledgeCommentAttention(commentId: string): Promise<boolean> {
    if (!markCommentAttentionSeen(this.data.comments, commentId, new Date().toISOString())) return false;
    await this.saveData(this.data);
    this.highlightRevision += 1;
    this.refreshEditors();
    this.refreshSidebar();
    return true;
  }

  async revealComment(comment: ReviewComment, acknowledgeAttention = true): Promise<void> {
    if (acknowledgeAttention) void this.acknowledgeCommentAttention(comment.id);
    const file = this.app.vault.getAbstractFileByPath(comment.filePath);
    if (!(file instanceof TFile)) return;
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path !== comment.filePath) {
      const openView = this.findOpenMarkdownView(comment.filePath);
      if (openView) {
        this.app.workspace.setActiveLeaf(openView.leaf, { focus: true });
        view = openView;
      } else {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file, { active: true });
        view = leaf.view instanceof MarkdownView ? leaf.view : null;
      }
    }
    if (!(view instanceof MarkdownView)) return;
    this.navigationCommentIds.set(comment.filePath, comment.id);
    const editorView = (view.editor as Editor & { cm?: EditorView }).cm;
    if (editorView) this.focusMarginCommentFromEditor(comment.id, editorView, false);
    const text = view.editor.getValue();
    const oldParagraph = firstOldParagraphForComment(text, this.data.inlineChanges, comment.id);
    if (comment.kind === "document" && !oldParagraph) {
      const top = { line: 0, ch: 0 };
      view.editor.setCursor(top);
      view.editor.scrollIntoView({ from: top, to: top }, true);
      view.editor.focus();
      return;
    }
    const location = comment.kind === "selection" ? locateComment(text, comment) : null;
    if (comment.kind === "selection" && !location && !oldParagraph) {
      new Notice("Фрагмент изменился и больше не найден");
      return;
    }
    if (location) {
      view.editor.setSelection(view.editor.offsetToPos(location.from), view.editor.offsetToPos(location.to));
    }
    view.editor.focus();
    if (oldParagraph) {
      this.scrollToOldParagraph(view, comment.filePath, oldParagraph);
      return;
    }
    if (location) {
      view.editor.scrollIntoView({
        from: view.editor.offsetToPos(location.from),
        to: view.editor.offsetToPos(location.to)
      }, true);
    }
  }

  private scrollToOldParagraph(
    view: MarkdownView,
    filePath: string,
    paragraph: InlineChangeParagraph
  ): void {
    const cm = (view.editor as Editor & { cm?: EditorView }).cm;
    if (!cm) {
      const start = view.editor.offsetToPos(paragraph.from);
      view.editor.scrollIntoView({ from: start, to: start }, false);
      return;
    }

    cm.dispatch({
      effects: [
        syncReviewDecorations.of({ path: filePath, revision: this.highlightRevision }),
        EditorView.scrollIntoView(paragraph.from, { y: "start", yMargin: 0 })
      ]
    });
    const changeIds = new Set(paragraph.changeIds);
    const alignOldParagraph = () => {
      const comparison = [...cm.contentDOM.querySelectorAll<HTMLElement>(".codex-review-inline-comparison")]
        .find((element) => (element.dataset.codexReviewChangeId ?? "")
          .split(" ")
          .some((id) => changeIds.has(id)));
      if (!comparison) return;
      const scrollerTop = cm.scrollDOM.getBoundingClientRect().top;
      const paragraphTop = comparison.getBoundingClientRect().top;
      cm.scrollDOM.scrollTop += paragraphTop - scrollerTop;
    };
    window.requestAnimationFrame(() => {
      alignOldParagraph();
      window.requestAnimationFrame(alignOldParagraph);
    });
  }

  chooseThread(afterPick?: () => void, title?: string): void {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return;
    }
    const provider = this.getFileProvider(file.path);
    new ThreadPickerModal(
      this.app,
      this,
      title ?? `Задача ${agentName(provider)}`,
      (thread) => {
        rememberFileTaskSelection(this.data.settings.fileThreads, file.path, provider, {
          threadId: thread.id,
          threadLabel: threadLabel(thread),
          provider,
          cwd: thread.cwd?.trim() || undefined
        });
        this.data.settings.fileProviders[file.path] = provider;
        forgetFileAgentString(this.data.settings.fileGoals, file.path, provider);
        this.data.settings.threadId = "";
        this.data.settings.threadLabel = "";
        void this.persist().then(() => {
          void this.loadThreadHistory(thread.id, true, this.getAgentClient(provider));
          void this.syncFileGoalFromThread(file.path, thread.id);
          afterPick?.();
        });
      },
      () => {
        void this.prepareNewThread(file.path).then((prepared) => {
          if (prepared) afterPick?.();
        });
      }
    ).open();
  }

  getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file?.extension.toLocaleLowerCase() === "md" ? file : null;
  }

  getInstructionEntry(scope: CodexInstructionScope, filePath: string): CodexInstructionEntry | undefined {
    return instructionEntryForScope(this.data.settings.instructions, scope, filePath);
  }

  hasDocumentInstructions(filePath: string): boolean {
    return applicableInstructionEntries(this.data.settings.instructions, filePath).length > 0;
  }

  openInstructions(): void {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return;
    }
    new InstructionsModal(this.app, this, file).open();
  }

  async saveInstructionDrafts(filePath: string, drafts: InstructionDraft[]): Promise<void> {
    let changed = false;
    for (const draft of drafts) {
      const text = draft.text.trim();
      const sourcePaths = [...new Set(draft.sourcePaths.map((path) => path.trim()).filter(Boolean))];
      const current = instructionEntryForScope(this.data.settings.instructions, draft.scope, filePath);
      const sameSources = sourcePaths.length === (current?.sourcePaths.length ?? 0)
        && sourcePaths.every((path, index) => path === current?.sourcePaths[index]);
      if (text === (current?.text ?? "") && sameSources) continue;
      saveInstructionEntry(
        this.data.settings.instructions,
        draft.scope,
        filePath,
        { text, sourcePaths }
      );
      changed = true;
    }
    if (changed) await this.persist();
    new Notice(changed ? "Инструкции для агента сохранены" : "Инструкции не изменились");
  }

  private async documentInstructionPayload(filePath: string): Promise<DocumentInstructionPayload> {
    const resolved = [];
    const includedSourcePaths = new Set<string>();
    const attachments: CodexLocalAttachment[] = [];
    const currentAbsolutePath = this.absolutePath(filePath);
    for (const applicable of applicableInstructionEntries(this.data.settings.instructions, filePath)) {
      const sources: Array<{
        path: string;
        content?: string;
        kind?: "file" | "google-drive" | "notion";
      }> = [];
      for (const sourcePath of applicable.entry.sourcePaths) {
        if (
          sourcePath === filePath
          || sourcePath === currentAbsolutePath
          || includedSourcePaths.has(sourcePath)
        ) continue;
        const cloud = parseCloudInstructionSource(sourcePath);
        if (cloud) {
          sources.push({ path: cloud.url, kind: cloud.provider });
          includedSourcePaths.add(sourcePath);
          continue;
        }
        const source = this.app.vault.getAbstractFileByPath(sourcePath);
        if (source instanceof TFile) {
          const absolutePath = this.absolutePath(source.path);
          try {
            if (
              TEXT_INSTRUCTION_EXTENSIONS.has(`.${source.extension.toLocaleLowerCase()}`)
              && source.stat.size <= MAX_INLINE_INSTRUCTION_BYTES
            ) {
              sources.push({ path: source.path, content: await this.app.vault.cachedRead(source) });
            } else {
              sources.push({ path: source.path });
              attachments.push({ name: source.name, path: absolutePath });
            }
            includedSourcePaths.add(sourcePath);
          } catch {
            // A temporarily unavailable source should not block the user's comments.
          }
          continue;
        }
        if (!isAbsolute(sourcePath)) continue;
        try {
          const info = await stat(sourcePath);
          if (!info.isFile()) continue;
          if (
            TEXT_INSTRUCTION_EXTENSIONS.has(extname(sourcePath).toLocaleLowerCase())
            && info.size <= MAX_INLINE_INSTRUCTION_BYTES
          ) {
            sources.push({ path: sourcePath, content: await readFile(sourcePath, "utf8") });
          } else {
            sources.push({ path: sourcePath });
            attachments.push({ name: basename(sourcePath), path: sourcePath });
          }
          includedSourcePaths.add(sourcePath);
        } catch {
          // A temporarily unavailable source should not block the user's comments.
        }
      }
      if (!applicable.entry.text && sources.length === 0) continue;
      resolved.push({ ...applicable, sources });
    }
    return {
      developerInstructions: formatDocumentInstructions(resolved),
      attachments: attachments.filter((attachment, index, all) =>
        all.findIndex((candidate) => candidate.path === attachment.path) === index
      )
    };
  }

  getOpenMarkdownText(filePath: string): string | undefined {
    const view = this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((candidate): candidate is MarkdownView =>
        candidate instanceof MarkdownView && candidate.file?.path === filePath);
    return view?.editor.getValue();
  }

  getFileThread(filePath: string, provider = this.getFileProvider(filePath)): CodexFileThread | undefined {
    const direct = fileTaskSelection(this.data.settings.fileThreads, filePath, provider);
    if (direct) return direct;
    if (provider !== "codex" || !this.data.settings.threadId) return undefined;
    const migrated = {
      threadId: this.data.settings.threadId,
      threadLabel: this.data.settings.threadLabel || filePath,
      provider: "codex" as const
    };
    rememberFileTaskSelection(this.data.settings.fileThreads, filePath, "codex", migrated);
    this.data.settings.threadId = "";
    this.data.settings.threadLabel = "";
    void this.saveData(this.data);
    return migrated;
  }

  getFileProvider(filePath: string): AgentProvider {
    return normalizeAgentProvider(this.data.settings.fileProviders[filePath]);
  }

  getActiveAgentProvider(): AgentProvider {
    return this.getActiveMarkdownFile()?.path
      ? this.getFileProvider(this.getActiveMarkdownFile()!.path)
      : "codex";
  }

  async setFileProvider(filePath: string, provider: AgentProvider): Promise<void> {
    if (this.getFileProvider(filePath) === provider) return;
    const activity = this.data.activities[filePath];
    if (isBusyActivity(activity)) {
      new Notice(`Сначала остановите обработку ${agentName(activity.provider)}`);
      this.refreshSidebar();
      this.scheduleEditorRefresh();
      return;
    }
    this.data.settings.fileProviders[filePath] = provider;
    this.models = [];
    this.modelStatus = "idle";
    this.skills = [];
    this.skillsProvider = null;
    this.skillStatus = "idle";
    await this.persist();
    void this.loadModels(true);
  }

  async prepareNewThread(filePath?: string): Promise<boolean> {
    const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : this.getActiveMarkdownFile();
    if (!(file instanceof TFile)) {
      new Notice("Откройте Markdown-файл");
      return false;
    }
    const provider = this.getFileProvider(file.path);
    this.data.settings.fileProviders[file.path] = provider;
    rememberFileTaskSelection(
      this.data.settings.fileThreads,
      file.path,
      provider,
      createNewTaskSelection(file.basename, provider)
    );
    forgetFileAgentString(this.data.settings.fileGoals, file.path, provider);
    this.data.settings.threadId = "";
    this.data.settings.threadLabel = "";
    await this.persist();
    return true;
  }

  getFileModel(filePath: string): string {
    return fileAgentString(this.data.settings.fileModels, filePath, this.getFileProvider(filePath));
  }

  async setFileModel(filePath: string, model: string): Promise<void> {
    rememberFileAgentString(this.data.settings.fileModels, filePath, this.getFileProvider(filePath), model);
    await this.persist();
  }

  getFileGoal(filePath: string): string {
    return fileAgentString(this.data.settings.fileGoals, filePath, this.getFileProvider(filePath));
  }

  private async syncFileGoalFromThread(filePath: string, threadId: string): Promise<void> {
    const provider = this.getFileProvider(filePath);
    if (provider === "claude") return;
    try {
      const goal = (await this.getAgentClient(provider).readThreadGoal(threadId))?.objective.trim() ?? "";
      rememberFileAgentString(this.data.settings.fileGoals, filePath, provider, goal);
      await this.persist();
    } catch {
      // Goal loading should not block selecting and opening the task.
    }
  }

  async openGoalEditor(filePath: string): Promise<void> {
    const target = this.getFileThread(filePath);
    let currentGoal = this.getFileGoal(filePath);
    const provider = this.getFileProvider(filePath);
    if (target?.threadId && provider === "codex") {
      try {
        currentGoal = (await this.getAgentClient(provider).readThreadGoal(target.threadId))?.objective ?? "";
        rememberFileAgentString(this.data.settings.fileGoals, filePath, provider, currentGoal);
        await this.saveData(this.data);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 10000);
        return;
      }
    }
    new GoalModal(this.app, currentGoal, (goal) => this.saveFileGoal(filePath, goal)).open();
  }

  private async saveFileGoal(filePath: string, goal: string): Promise<boolean> {
    const target = this.getFileThread(filePath);
    const provider = this.getFileProvider(filePath);
    try {
      if (target?.threadId) {
        const client = this.getAgentClient(provider);
        if (goal) await client.setThreadGoal(target.threadId, goal);
        else await client.clearThreadGoal(target.threadId);
      }
      rememberFileAgentString(this.data.settings.fileGoals, filePath, provider, goal);
      await this.persist();
      new Notice(goal ? "Цель задачи сохранена" : "Цель задачи очищена");
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 10000);
      return false;
    }
  }

  getModels(provider = this.getActiveAgentProvider()): CodexModelOption[] {
    return this.modelsProvider === provider ? this.models : [];
  }

  async loadModels(force = false): Promise<void> {
    const provider = this.getActiveAgentProvider();
    if (this.modelsProvider !== provider) {
      this.models = [];
      this.modelStatus = "idle";
      this.modelsProvider = provider;
    }
    if (this.modelStatus === "loading") return;
    if (!force && (this.modelStatus === "ready" || this.modelStatus === "error")) return;
    this.modelStatus = "loading";
    this.refreshSidebar();
    try {
      const models = await this.getAgentClient(provider).listModels();
      if (this.getActiveAgentProvider() !== provider) return;
      this.models = models;
      this.modelStatus = "ready";
    } catch {
      if (this.getActiveAgentProvider() !== provider) return;
      this.modelStatus = "error";
    }
    this.refreshSidebar();
  }

  async listSkills(
    force = false,
    provider = this.getActiveAgentProvider()
  ): Promise<CodexSkillOption[]> {
    if (this.skillsProvider !== provider) {
      this.skills = [];
      this.skillStatus = "idle";
      this.skillsProvider = provider;
    }
    if (!force && this.skillStatus === "ready") return this.skills;
    this.skillStatus = "loading";
    try {
      const skills = await this.getAgentClient(provider).listSkills(this.getVaultPath(), force);
      if (this.skillsProvider !== provider) return [];
      this.skills = skills;
      this.skillStatus = "ready";
      return this.skills;
    } catch (error) {
      if (this.skillsProvider !== provider) return [];
      this.skillStatus = "error";
      throw error;
    }
  }

  private historyKey(threadId: string, provider: AgentProvider): string {
    return `${provider}:${threadId}`;
  }

  private taskDirectory(threadId: string, provider: AgentProvider): string {
    const target = allFileTaskSelections(this.data.settings.fileThreads).find((thread) =>
      thread.threadId === threadId && normalizeAgentProvider(thread.provider) === provider
    );
    return taskWorkingDirectory(target, this.getVaultPath(), provider);
  }

  getThreadHistory(threadId: string, provider = this.getActiveAgentProvider()): CodexThreadHistory {
    return this.histories.get(this.historyKey(threadId, provider)) ?? { status: "idle", messages: [] };
  }

  async loadThreadHistory(
    threadId: string,
    force = false,
    client: AgentClient = this.getAgentClient()
  ): Promise<void> {
    const key = this.historyKey(threadId, client.provider);
    const current = this.histories.get(key);
    if (current?.status === "loading") return;
    if (!force && current?.status === "ready") return;
    this.histories.set(key, { status: "loading", messages: current?.messages ?? [] });
    this.refreshSidebar();
    try {
      const thread = await client.readThread(threadId, this.taskDirectory(threadId, client.provider));
      this.histories.set(key, { status: "ready", messages: parseThreadHistory(thread) });
    } catch (error) {
      this.histories.set(key, {
        status: "error",
        messages: current?.messages ?? [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
    this.refreshSidebar();
  }

  getFileContextPaths(filePath: string): string[] {
    return (this.data.settings.fileContexts[filePath] ?? []).filter((path) =>
      path !== filePath && this.app.vault.getAbstractFileByPath(path) instanceof TFile
    );
  }

  openContextPicker(): void {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return;
    }
    const selected = new Set(this.getFileContextPaths(file.path));
    const files = this.app.vault.getFiles()
      .filter((candidate) => candidate.path !== file.path && !selected.has(candidate.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    new ContextPickerModal(this.app, files, (contextFile) => {
      void this.addContextFile(file.path, contextFile.path);
    }).open();
  }

  private async addContextFile(filePath: string, contextPath: string): Promise<void> {
    if (filePath === contextPath) return;
    const paths = this.data.settings.fileContexts[filePath] ?? [];
    if (paths.includes(contextPath)) return;
    this.data.settings.fileContexts[filePath] = [...paths, contextPath];
    await this.persist();
  }

  async removeContextFile(filePath: string, contextPath: string): Promise<void> {
    const paths = (this.data.settings.fileContexts[filePath] ?? []).filter((path) => path !== contextPath);
    if (paths.length > 0) this.data.settings.fileContexts[filePath] = paths;
    else delete this.data.settings.fileContexts[filePath];
    await this.persist();
  }

  private manualContextFiles(file: TFile): string[] {
    return this.getFileContextPaths(file.path).map((path) => this.absolutePath(path));
  }

  private buildBatch(file: TFile) {
    return buildFeedbackBatchForFile(
      this.data.comments,
      file.path,
      (path) => this.absolutePath(path),
      this.manualContextFiles(file)
    );
  }

  private chooseBusyThreadAction(): Promise<BusyThreadChoice | null> {
    return new Promise((resolve) => new BusyThreadModal(this.app, resolve).open());
  }

  private async dispatchToFileTask(
    client: AgentClient,
    file: TFile,
    currentThreadId: string,
    message: string,
    model: string,
    beginActivity: (threadId: string) => CodexActivity,
    options: ThreadDispatchOptions = {}
  ): Promise<ThreadDispatchResult | null> {
    const vaultCwd = this.getVaultPath();
    const selectedTarget = this.getFileThread(file.path);
    const existingTaskCwd = taskWorkingDirectory(selectedTarget, vaultCwd, client.provider);
    const previousActivity = this.data.activities[file.path];
    let currentActivity: CodexActivity | null = null;

    const startTurn = async (
      threadId: string,
      resume: boolean,
      destination: ThreadDestination,
      cwd: string
    ): Promise<ThreadDispatchResult> => {
      const activity = beginActivity(threadId);
      currentActivity = activity;
      if (options.goal?.trim() && (destination !== "existing" || client.provider === "claude")) {
        await client.setThreadGoal(threadId, options.goal.trim());
      }
      const result = await client.sendToThread(threadId, cwd, message, {
        resume,
        model,
        attachments: options.attachments,
        skills: options.skills,
        developerInstructions: options.developerInstructions,
        applicationContext: options.applicationContext,
        workspaceRoots: [vaultCwd]
      });
      bindCodexActivityTurn(activity, result.turnId);
      this.scheduleSidebarRefresh();
      return { activity, threadId, turnId: result.turnId, destination };
    };

    if (!currentThreadId) {
      try {
        const thread = await client.startThread(vaultCwd, file.basename, model, options.developerInstructions);
        rememberFileTaskSelection(this.data.settings.fileThreads, file.path, client.provider, {
          threadId: thread.id,
          threadLabel: file.basename,
          provider: client.provider,
          cwd: thread.cwd?.trim() || vaultCwd
        });
        this.data.settings.fileProviders[file.path] = client.provider;
        return await startTurn(thread.id, false, "initial", vaultCwd);
      } catch (error) {
        if (currentActivity) this.markCodexActivityFailed(currentActivity, error);
        throw error;
      }
    }

    try {
      return await startTurn(currentThreadId, true, "existing", existingTaskCwd);
    } catch (error) {
      if (!isActiveWriterConflict(error)) {
        if (currentActivity) this.markCodexActivityFailed(currentActivity, error);
        throw error;
      }
    }

    if (previousActivity) this.data.activities[file.path] = previousActivity;
    else delete this.data.activities[file.path];
    currentActivity = null;
    this.refreshSidebar();

    const choice = await this.chooseBusyThreadAction();
    if (!choice) {
      this.closeClientIfIdle(client);
      return null;
    }

    try {
      const thread = choice === "fork"
        ? await client.forkThread(
            currentThreadId,
            vaultCwd,
            `${file.basename} — копия`,
            model,
            options.developerInstructions
          )
        : await client.startThread(vaultCwd, file.basename, model, options.developerInstructions);
      const label = choice === "fork" ? `${file.basename} — копия` : file.basename;
      rememberFileTaskSelection(this.data.settings.fileThreads, file.path, client.provider, {
        threadId: thread.id,
        threadLabel: label,
        provider: client.provider,
        cwd: thread.cwd?.trim() || vaultCwd
      });
      this.data.settings.fileProviders[file.path] = client.provider;
      return await startTurn(thread.id, false, choice, vaultCwd);
    } catch (error) {
      if (currentActivity) this.markCodexActivityFailed(currentActivity, error);
      throw error;
    }
  }

  async sendFeedback(): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return;
    }
    const batch = this.buildBatch(file);
    if (batch.pages.length === 0) {
      new Notice("В текущем файле нет черновиков");
      return;
    }
    if (isBusyActivity(this.data.activities[file.path])) {
      this.queuedReviewFiles.add(file.path);
      new Notice(queuedReviewNotice(this.data.activities[file.path]));
      return;
    }
    const target = this.getFileThread(file.path);
    if (!hasExplicitTaskSelection(target)) {
      this.chooseThread(
        () => void this.sendFeedback(),
        "Выберите, в какую задачу отправить комментарии"
      );
      return;
    }

    const provider = this.getFileProvider(file.path);
    const agent = agentName(provider);
    let client: AgentClient | null = null;
    try {
      client = this.getAgentClient(provider);
      const account = await client.readAccount();
      if (!account.account && account.requiresOpenaiAuth && provider === "codex") {
        new LoginModal(this.app, client as CodexAppServerClient, () => void this.sendFeedback()).open();
        return;
      }
      const hasDocumentContext = Boolean(
        target?.threadId
        && !target.createNew
        && hasCompletedReviewContext(this.data.comments, file.path, target.threadId)
      );
      const beforeText = await this.readCurrentMarkdownText(file.path) ?? await this.app.vault.read(file);
      const workingCopy = await this.prepareWorkingCopy(file.path, beforeText);
      const instructionPayload = await this.documentInstructionPayload(file.path);
      const model = this.getFileModel(file.path);
      const threadId = target?.threadId ?? "";
      const request = buildReviewTurnRequest({
        comments: this.data.comments,
        document: this.turnDocument(file.path, beforeText, workingCopy.absolutePath),
        absolutePath: (path) => this.absolutePath(path),
        contextFiles: this.manualContextFiles(file),
        documentInstructions: instructionPayload.developerInstructions,
        hasDocumentContext,
        firstTurn: this.isFirstTurn(threadId)
      });
      const { message, commentIds, instructions: turnInstructions } = request;

      const dispatched = await this.dispatchToFileTask(
        client,
        file,
        threadId,
        message,
        model,
        (targetThreadId) => this.beginCodexActivity(file, targetThreadId, {
          source: "review",
          commentIds,
          beforeText,
          workingCopyPath: workingCopy.path,
          requestText: message,
          model
        }),
        {
          goal: this.getFileGoal(file.path),
          developerInstructions: turnInstructions,
          applicationContext: turnInstructions,
          attachments: instructionPayload.attachments
        }
      );
      if (!dispatched) return;

      markFeedbackSent(this.data.comments, commentIds, {
        threadId: dispatched.threadId,
        turnId: dispatched.turnId,
        provider,
        now: new Date().toISOString()
      });
      await this.persist();
      await this.activateSidebar("history");
      new Notice(dispatched.destination === "fork"
        ? `Комментарии отправлены в копию задачи ${agent}`
        : dispatched.destination === "existing"
          ? `Комментарии отправлены в ${agent}`
          : `Комментарии отправлены в новую задачу ${agent}`);
      this.monitorTurn(client, file.path, dispatched.activity, dispatched.threadId, dispatched.turnId);
    } catch (error) {
      const reported = toUserFacingAgentError(error, provider);
      if (!this.showAgentConnectionError(reported, provider, () => void this.sendFeedback())) {
        new Notice(reported.message, 12000);
      }
      if (client) this.closeClientIfIdle(client);
    }
  }

  async sendFollowUp(text: string, attachments: CodexLocalAttachment[] = []): Promise<boolean> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Откройте Markdown-файл");
      return false;
    }
    const target = this.getFileThread(file.path);
    if (!hasExplicitTaskSelection(target)) {
      new Notice(`Сначала выберите задачу ${agentName(this.getFileProvider(file.path))} или создайте новую`);
      return false;
    }
    const activeActivity = this.data.activities[file.path];
    if (isBusyActivity(activeActivity)) {
      return this.steerActiveTurn(file, activeActivity, text, attachments);
    }

    const provider = this.getFileProvider(file.path);
    const agent = agentName(provider);
    let client: AgentClient | null = null;
    try {
      client = this.getAgentClient(provider);
      const account = await client.readAccount();
      if (!account.account && account.requiresOpenaiAuth && provider === "codex") {
        new LoginModal(this.app, client as CodexAppServerClient, () => void this.sendFollowUp(text, attachments)).open();
        return false;
      }
      const beforeText = await this.readCurrentMarkdownText(file.path) ?? await this.app.vault.read(file);
      const workingCopy = await this.prepareWorkingCopy(file.path, beforeText);
      const instructionPayload = await this.documentInstructionPayload(file.path);
      const combinedAttachments = [...instructionPayload.attachments, ...attachments]
        .filter((attachment, index, all) =>
          all.findIndex((candidate) => candidate.path === attachment.path) === index
        );
      const model = this.getFileModel(file.path);
      const threadId = target?.threadId ?? "";
      let skills: CodexSkillOption[] = [];
      if (text.includes("$")) {
        try {
          const mentioned = new Set(
            [...text.matchAll(/\$([\p{L}\p{N}_:-]+)/gu)].map((match) => match[1])
          );
          skills = (await this.listSkills()).filter((skill) => mentioned.has(skill.name));
        } catch {
          skills = [];
        }
      }
      const turnInstructions = buildChatTurnInstructions({
        document: this.turnDocument(file.path, beforeText, workingCopy.absolutePath),
        documentInstructions: instructionPayload.developerInstructions,
        firstTurn: this.isFirstTurn(threadId)
      });
      const dispatched = await this.dispatchToFileTask(
        client,
        file,
        threadId,
        text,
        model,
        (targetThreadId) => this.beginCodexActivity(file, targetThreadId, {
          source: "conversation",
          beforeText,
          workingCopyPath: workingCopy.path,
          requestText: text,
          model
        }),
        {
          attachments: combinedAttachments,
          skills,
          goal: this.getFileGoal(file.path),
          developerInstructions: turnInstructions,
          applicationContext: turnInstructions
        }
      );
      if (!dispatched) return false;

      await this.persist();
      await this.activateSidebar("history");
      new Notice(dispatched.destination === "fork"
        ? `Сообщение отправлено в копию задачи ${agent}`
        : dispatched.destination === "existing"
          ? `Сообщение отправлено в ${agent}`
          : `Сообщение отправлено в новую задачу ${agent}`);
      this.monitorTurn(client, file.path, dispatched.activity, dispatched.threadId, dispatched.turnId);
      return true;
    } catch (error) {
      const reported = toUserFacingAgentError(error, provider);
      if (!this.showAgentConnectionError(reported, provider, () => void this.sendFollowUp(text, attachments))) {
        new Notice(reported.message, 12000);
      }
      if (client) this.closeClientIfIdle(client);
      return false;
    }
  }

  private async steerActiveTurn(
    file: TFile,
    activity: CodexActivity,
    text: string,
    attachments: CodexLocalAttachment[]
  ): Promise<boolean> {
    const provider = activity.provider;
    const decision = resolveOutgoingMessage(activity);
    if (decision.action === "wait") {
      new Notice(decision.notice!);
      return false;
    }
    if (decision.action === "queue") {
      queueAgentMessage(this.data.queuedMessages, file.path, {
        id: makeId(),
        text,
        createdAt: new Date().toISOString(),
        attachments
      });
      rememberSteeringMessage(activity, text);
      await this.saveData(this.data);
      this.scheduleSidebarRefresh();
      new Notice(decision.notice!);
      return true;
    }
    let skills: CodexSkillOption[] = [];
    if (text.includes("$")) {
      try {
        const mentioned = new Set([...text.matchAll(/\$([\p{L}\p{N}_:-]+)/gu)].map((match) => match[1]));
        skills = (await this.listSkills()).filter((skill) => mentioned.has(skill.name));
      } catch {
        skills = [];
      }
    }
    try {
      const client = this.getAgentClient(provider);
      await client.steerTurn(activity.threadId, activity.turnId, text, { attachments, skills });
      rememberSteeringMessage(activity, text);
      await this.saveData(this.data);
      this.scheduleSidebarRefresh();
      new Notice("Дополнительная информация отправлена в текущую обработку");
      return true;
    } catch (error) {
      const reported = toUserFacingAgentError(error, provider);
      new Notice(reported.message, 12000);
      return false;
    }
  }

  isStopping(turnId: string): boolean {
    return Boolean(turnId) && this.stoppingTurnIds.has(turnId);
  }

  async stopProcessing(filePath: string): Promise<void> {
    const activity = this.data.activities[filePath];
    if (!activity || !isBusyActivity(activity) || !activity.turnId) return;
    if (this.stoppingTurnIds.has(activity.turnId)) return;
    this.stoppingTurnIds.add(activity.turnId);
    this.refreshSidebar();
    try {
      await this.getAgentClient(activity.provider).interruptTurn(activity.threadId, activity.turnId);
      new Notice(`Останавливаю обработку ${agentName(activity.provider)}`);
    } catch (error) {
      this.stoppingTurnIds.delete(activity.turnId);
      this.refreshSidebar();
      new Notice(error instanceof Error ? error.message : String(error), 10000);
    }
  }

  private monitorTurn(
    client: AgentClient,
    filePath: string,
    activity: CodexActivity,
    threadId: string,
    turnId: string
  ): void {
    void client.waitForTurnCompletion(threadId, turnId)
      .then(async ({ status }) => {
        await this.finalizeActivity(filePath, activity, status, client);
        const agent = agentName(activity.provider);
        new Notice(status === "completed"
          ? activity.source === "review" ? `${agent} обработал все комментарии` : `${agent} ответил`
          : status === "interrupted" ? `Обработка ${agent} остановлена` : `Задача ${agent} завершилась: ${status}`);
        if (status === "completed") await this.sendNextQueuedMessage(filePath);
        if (status === "completed") await this.sendQueuedReviewBatch(filePath);
      })
      .catch((error) => {
        this.markCodexActivityFailed(activity, error);
        new Notice(error instanceof Error ? error.message : String(error), 10000);
      })
      .finally(() => {
        this.stoppingTurnIds.delete(turnId);
        this.scheduleSidebarRefresh();
        this.closeClientIfIdle(client);
      });
  }

  /**
   * Reads what the turn produced, asks the core what it means, and carries that out in Obsidian:
   * the edits go into the document, the resulting state is stored, the notices are shown.
   */
  private async finalizeActivity(
    filePath: string,
    activity: CodexActivity,
    status: string,
    client: AgentClient
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    const agentText = activity.workingCopyPath
      ? (await this.readWorkingCopy(activity.workingCopyPath)) ?? activity.beforeText
      : file instanceof TFile ? await this.app.vault.read(file) : undefined;

    // With the document open, reading it, resolving the outcome and writing happen in one tick, so
    // the text cannot change under the merge. With no view open nobody can be typing into it.
    const openView = this.findOpenMarkdownView(filePath);
    const documentText = file instanceof TFile
      ? openView ? openView.editor.getValue() : await this.app.vault.read(file)
      : null;
    const outcome = resolveTurnOutcome({
      activity,
      status,
      comments: this.data.comments,
      inlineChanges: this.data.inlineChanges,
      documentText,
      agentText,
      makeId,
      now: new Date().toISOString()
    });
    if (outcome.documentChanges.length > 0 && file instanceof TFile) {
      await this.applyDocumentChanges(file, openView, outcome);
    }

    this.data.comments.push(...outcome.newComments);
    this.data.inlineChanges = outcome.inlineChanges;
    for (const version of outcome.versions) {
      this.recordVersion(filePath, version.text, version.source, version.createdAt, {
        originId: version.originId
      });
    }
    relocateTurnCommentAnchors(activity, this.data.comments, new Date().toISOString());
    for (const notice of outcome.notices) new Notice(notice, 12000);

    await this.loadThreadHistory(activity.threadId, true, client);
    await this.persist();
    if (status === "completed") await this.revealFirstProcessedComment(filePath, activity);
  }

  private async applyDocumentChanges(
    file: TFile,
    openView: MarkdownView | undefined,
    outcome: TurnOutcome
  ): Promise<void> {
    const cm = openView ? (openView.editor as Editor & { cm?: EditorView }).cm : undefined;
    if (cm) {
      cm.dispatch({ changes: outcome.documentChanges });
      return;
    }
    if (openView) {
      openView.editor.setValue(outcome.documentText ?? openView.editor.getValue());
      return;
    }
    if (outcome.documentText !== null) await this.app.vault.modify(file, outcome.documentText);
  }

  private async revealFirstProcessedComment(filePath: string, activity: CodexActivity): Promise<void> {
    if (this.getActiveMarkdownFile()?.path !== filePath || activity.commentIds.length === 0) return;
    const processedIds = new Set(activity.commentIds);
    const first = commentsForFile(
      this.data.comments,
      filePath,
      "active",
      activity.documentTextAfter ?? activity.afterText ?? activity.beforeText
    ).find((comment) =>
      processedIds.has(comment.id)
      || comment.followUps.some((followUp) => processedIds.has(followUp.id))
    );
    if (first) await this.revealComment(first, false);
  }

  private async sendNextQueuedMessage(filePath: string): Promise<void> {
    if (!this.data.queuedMessages[filePath]?.length) return;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    if (this.getActiveMarkdownFile()?.path !== filePath) return;
    const next = takeQueuedMessage(this.data.queuedMessages, filePath);
    if (!next) return;
    await this.saveData(this.data);
    const sent = await this.sendFollowUp(next.text, next.attachments);
    if (!sent) {
      returnQueuedMessage(this.data.queuedMessages, filePath, next);
      await this.saveData(this.data);
    }
  }

  private async sendQueuedReviewBatch(filePath: string): Promise<void> {
    if (!this.queuedReviewFiles.has(filePath) || isBusyActivity(this.data.activities[filePath])) return;
    if (this.getActiveMarkdownFile()?.path !== filePath) return;
    this.queuedReviewFiles.delete(filePath);
    await this.sendFeedback();
  }

  private closeClientIfIdle(client: AgentClient): void {
    if (!client.isIdle() || this.agentClients.get(client.provider) !== client) return;
    this.stopAgentNotifications.get(client.provider)?.();
    this.stopAgentNotifications.delete(client.provider);
    client.close();
    this.agentClients.delete(client.provider);
  }
}
