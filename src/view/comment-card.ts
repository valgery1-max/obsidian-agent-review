import { agentName, normalizeAgentProvider } from "../agent-client";
import { formatCommentTimestamp } from "../comment-time";
import { commentActionAvailability, isDraftFollowUp, isUnsentDraftComment } from "../comments";
import {
  commentIssueLabel,
  commentStatusLabel,
  isRetryableCommentIssue,
  showsCommentStatus
} from "../comment-labels";
import { russianCountForm } from "../plural";
import { div, el, iconButton, setIcon } from "./dom";
import type { AgentProvider, ReviewComment, ReviewCommentFollowUp, ReviewCommentIssue } from "../types";

/**
 * Карточка комментария.
 *
 * Один и тот же интерфейс на всех поверхностях продукта: разметка, названия классов и тексты живут
 * здесь, а не повторяются в каждом хосте. Стили к ним — общий `styles.css`, поэтому карточка
 * выглядит одинаково и в Obsidian, и в десктопном приложении.
 *
 * Что делать по нажатию, решает хост: сюда он передаёт обработчики, а не свои объекты.
 */

export interface CommentCardCallbacks {
  onActivate?(commentId: string): void;
  /** Принять правки этого комментария целиком. */
  onAccept?(commentId: string): void;
  /** Отменить принятые правки этого комментария и вернуть прежний текст. */
  onCancel?(commentId: string): void;
  onEdit?(commentId: string): void;
  onDelete?(commentId: string): void;
  onResolve?(commentId: string): void;
  onReopen?(commentId: string): void;
  onRetry?(commentId: string): void;
  onFollowUp?(commentId: string): void;
  onEditFollowUp?(commentId: string, followUpId: string): void;
  onDeleteFollowUp?(commentId: string, followUpId: string): void;
  /** Разметка ответа агента: в Obsidian её рисует сам Obsidian, в приложении — свой разбор. */
  renderAnswer?(target: HTMLElement, text: string): void;
}

export interface CommentCardState {
  active: boolean;
  /** У комментария есть непринятые правки агента. */
  hasChanges: boolean;
  /** У комментария есть принятые правки: их ещё можно отменить. */
  hasAcceptedChanges: boolean;
}

function messageBlock(
  parent: HTMLElement,
  role: "user" | "codex",
  text: string,
  provider: AgentProvider | undefined,
  callbacks: CommentCardCallbacks,
  options: { draft?: boolean; timestamp?: string; actions?: (actions: HTMLElement) => void } = {}
): HTMLElement {
  const message = div({ cls: `codex-review-comment-message is-${role}` }, parent);
  const label = div({ cls: "codex-review-comment-message-label" }, message);
  setIcon(el("span", {}, label), role === "user" ? "user-round" : "bot");
  el("span", {
    text: role === "user" ? "Вы" : agentName(normalizeAgentProvider(provider))
  }, label);

  const stamp = formatCommentTimestamp(options.timestamp);
  if (stamp) {
    const time = el("time", { cls: "codex-review-comment-message-time", text: stamp }, label);
    time.dateTime = options.timestamp ?? "";
  }
  if (options.draft) {
    el("span", { cls: "codex-review-comment-draft-label", text: "Ожидает отправки" }, label);
  }
  if (options.actions) {
    options.actions(div({ cls: "codex-review-comment-message-actions" }, label));
  }

  const content = div({
    cls: `codex-review-comment-message-text is-${role}${role === "codex" ? " markdown-rendered" : ""}`
  }, message);
  if (role === "codex" && callbacks.renderAnswer) callbacks.renderAnswer(content, text);
  else content.textContent = text;

  message.classList.add("codex-review-thread-message");
  return message;
}

/** Пояснение о проблеме: заголовок отличает «Можно отправить повторно» от «Что требуется». */
function issueBlock(parent: HTMLElement, issue: ReviewCommentIssue): void {
  const notice = div({ cls: `codex-review-comment-issue is-${issue.kind}` }, parent);
  setIcon(el("span", {}, notice), isRetryableCommentIssue(issue) ? "refresh-cw" : "circle-alert");
  const text = div({ cls: "codex-review-comment-issue-text" }, notice);
  div({ cls: "codex-review-comment-issue-label", text: commentIssueLabel(issue) }, text);
  div({ text: issue.message }, text);
}

function followUpBlock(
  card: HTMLElement,
  comment: ReviewComment,
  followUp: ReviewCommentFollowUp,
  callbacks: CommentCardCallbacks
): void {
  const draft = isDraftFollowUp(followUp);
  messageBlock(card, "user", followUp.feedback, comment.provider, callbacks, {
    draft,
    timestamp: followUp.createdAt,
    actions: draft
      ? (actions) => {
        if (callbacks.onEditFollowUp) {
          iconButton(actions, "pencil", "Изменить дополнительный комментарий", () =>
            callbacks.onEditFollowUp!(comment.id, followUp.id));
        }
        if (callbacks.onDeleteFollowUp) {
          iconButton(actions, "trash-2", "Удалить дополнительный комментарий", () =>
            callbacks.onDeleteFollowUp!(comment.id, followUp.id), "is-delete");
        }
      }
      : undefined
  });
  if (followUp.agentResponse) {
    messageBlock(card, "codex", followUp.agentResponse, followUp.provider ?? comment.provider, callbacks, {
      timestamp: followUp.respondedAt
    });
  }
  if (followUp.issue) issueBlock(card, followUp.issue);
}

/** Действия карточки: тот же набор кнопок, значков и подписей, что в плагине. */
function cardActions(
  parent: HTMLElement,
  comment: ReviewComment,
  state: CommentCardState,
  callbacks: CommentCardCallbacks
): void {
  if (isUnsentDraftComment(comment)) {
    if (callbacks.onEdit) {
      iconButton(parent, "pencil", "Изменить комментарий", () => callbacks.onEdit!(comment.id));
    }
    if (callbacks.onDelete) {
      iconButton(parent, "trash-2", "Удалить комментарий", () => callbacks.onDelete!(comment.id), "is-delete");
    }
  }

  const issueTarget = comment.issue
    ? { id: comment.id, issue: comment.issue }
    : [...comment.followUps].reverse().flatMap(
      (followUp) => followUp.issue ? [{ id: followUp.id, issue: followUp.issue }] : []
    )[0];

  const available = commentActionAvailability(comment, state.hasChanges);
  if (available.canReopen) {
    if (callbacks.onReopen) {
      iconButton(parent, "rotate-ccw", "Вернуть в работу", () => callbacks.onReopen!(comment.id));
    }
  } else if (available.canAcceptChanges) {
    if (callbacks.onAccept) {
      iconButton(parent, "check", "Принять изменения", () => callbacks.onAccept!(comment.id), "is-accept");
    }
    if (callbacks.onCancel) {
      iconButton(parent, "undo-2", "Отменить изменения", () => callbacks.onCancel!(comment.id), "is-cancel");
    }
  } else if (available.canResolve) {
    if (callbacks.onResolve) {
      iconButton(parent, "check", "Завершить комментарий", () => callbacks.onResolve!(comment.id), "is-resolve");
    }
  }

  // Принятые правки можно отменить и после того, как комментарий вернули в работу.
  if (state.hasAcceptedChanges && !available.canAcceptChanges && callbacks.onCancel) {
    iconButton(parent, "undo-2", "Отменить изменения", () => callbacks.onCancel!(comment.id), "is-cancel");
  }

  if (comment.status === "needs_attention" && issueTarget?.issue.kind === "missing_response" && callbacks.onRetry) {
    iconButton(parent, "refresh-cw", "Подготовить к повторной отправке", () => callbacks.onRetry!(issueTarget.id));
  }
}

export function renderCommentCard(
  parent: HTMLElement,
  comment: ReviewComment,
  state: CommentCardState,
  callbacks: CommentCardCallbacks = {}
): HTMLElement {
  const card = div({
    cls: `codex-review-margin-card codex-review-card is-${comment.status}${
      state.active ? " is-editor-target" : " is-collapsed"
    }${comment.kind === "document" ? " is-document-comment" : ""}`,
    attr: {
      role: "article",
      tabindex: "0",
      "aria-expanded": String(state.active)
    }
  }, parent);
  card.dataset.codexReviewCommentId = comment.id;

  const top = div({ cls: "codex-review-margin-card-top" }, card);
  const meta = div({ cls: "codex-review-margin-card-meta" }, top);
  const created = el("time", { text: formatCommentTimestamp(comment.createdAt) }, meta);
  created.dateTime = comment.createdAt;
  cardActions(div({ cls: "codex-review-card-actions" }, top), comment, state, callbacks);

  if (comment.kind === "selection" && comment.quote) {
    el("blockquote", { cls: "codex-review-card-quote", text: comment.quote }, card);
  }

  if (comment.kind === "document") {
    div({ cls: "codex-review-card-scope", text: "Ко всему документу" }, card);
  }

  messageBlock(card, "user", comment.feedback, comment.provider, callbacks, {
    draft: isUnsentDraftComment(comment),
    timestamp: comment.createdAt
  });
  if (comment.agentResponse) {
    messageBlock(card, "codex", comment.agentResponse, comment.provider, callbacks, {
      timestamp: comment.respondedAt
    });
  }
  if (comment.issue) issueBlock(card, comment.issue);
  for (const followUp of comment.followUps) followUpBlock(card, comment, followUp, callbacks);

  // Свёрнутая карточка не показывает всю переписку: длинная ветка иначе занимает весь экран.
  const messages = [...card.querySelectorAll<HTMLElement>(".codex-review-thread-message")];
  if (!state.active && messages.length > 2) {
    for (const message of messages.slice(1, -1)) message.classList.add("is-hidden");
    const hidden = messages.length - 2;
    const more = el("button", {
      cls: "codex-review-comment-message-expand",
      text: hidden + " " + russianCountForm(hidden, "ответ", "ответа", "ответов") + " скрыто",
      attr: { type: "button", "aria-expanded": "false" }
    }, card);
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      callbacks.onActivate?.(comment.id);
    });
  }

  // Словесная стадия комментария: «Агент работает», «Готово», «Требуется внимание».
  if (showsCommentStatus(comment)) {
    div({ cls: `codex-review-status is-${comment.status}`, text: commentStatusLabel(comment) }, card);
  }

  if (callbacks.onActivate) {
    card.addEventListener("click", () => callbacks.onActivate!(comment.id));
  }
  return card;
}
