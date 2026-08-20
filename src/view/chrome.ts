import { russianCountForm } from "../plural";
import { div, el, iconButton, setIcon } from "./dom";
import type { AgentProvider } from "../types";

/**
 * Верхняя панель документа и вкладки боковой панели.
 *
 * Разметка одна на все поверхности продукта: те же имена классов, тот же порядок элементов, те же
 * подписи. Стили к ней — общий `styles.css`, поэтому панель выглядит одинаково и в Obsidian, и в
 * десктопном приложении, а правка подписи доходит до обеих сразу.
 */

export interface ToolbarModel {
  id: string;
  label: string;
}

export interface ToolbarProps {
  provider: AgentProvider;
  /** Название выбранной задачи агента или пусто, если задача ещё не выбрана. */
  taskLabel: string;
  model: string;
  models: ToolbarModel[];
  hasInstructions: boolean;
  onSelectionComment(): void;
  onDocumentComment(): void;
  onInstructions(): void;
  onProvider(provider: AgentProvider): void;
  onTask(): void;
  onModel(model: string): void;
  onGo(panel: "history" | "versions" | "comments"): void;
}

const TASK_PROMPT = "Выберите или создайте задачу для файла";

export function renderEditorToolbar(toolbar: HTMLElement, props: ToolbarProps): void {
  toolbar.replaceChildren();
  toolbar.className = "codex-review-editor-toolbar";

  const main = div({ cls: "codex-review-editor-toolbar-main" }, toolbar);
  const quickActions = div({ cls: "codex-review-editor-quick-actions" }, main);
  iconButton(quickActions, "message-square-plus", "Комментарий к выделению", props.onSelectionComment);
  iconButton(quickActions, "file-pen-line", "Комментарий ко всему документу", props.onDocumentComment);
  const instructions = iconButton(quickActions, "book-open-check", "Инструкции для агента", props.onInstructions);
  if (props.hasInstructions) instructions.classList.add("is-configured");

  const provider = el("select", {
    cls: "codex-review-editor-provider",
    title: "Агент для текущего файла",
    attr: { "aria-label": "Агент" }
  }, main);
  el("option", { text: "Codex", attr: { value: "codex" } }, provider);
  el("option", { text: "Claude", attr: { value: "claude" } }, provider);
  provider.value = props.provider;
  provider.addEventListener("change", () => props.onProvider(provider.value === "claude" ? "claude" : "codex"));

  const target = el("button", { cls: "codex-review-editor-target", attr: { type: "button" } }, main);
  setIcon(el("span", {}, target), "messages-square");
  el("span", { text: props.taskLabel || TASK_PROMPT }, target);
  target.title = props.taskLabel ? `Выбор задачи: ${props.taskLabel}` : TASK_PROMPT;
  if (!props.taskLabel) target.classList.add("is-unselected");
  target.addEventListener("click", props.onTask);

  const model = el("select", {
    cls: "codex-review-editor-model",
    title: "Модель агента",
    attr: { "aria-label": "Модель агента" }
  }, main);
  el("option", { text: "Модель по умолчанию", attr: { value: "" } }, model);
  for (const option of props.models) {
    el("option", { text: option.label, attr: { value: option.id } }, model);
  }
  model.value = props.model;
  model.addEventListener("change", () => props.onModel(model.value));

  const destinations = div({ cls: "codex-review-editor-destinations" }, main);
  iconButton(destinations, "message-square-text", "Чат", () => props.onGo("history"));
  iconButton(destinations, "history", "Версии", () => props.onGo("versions"));
  iconButton(destinations, "messages-square", "Все комментарии", () => props.onGo("comments"));
}

export interface StatusProps {
  busy: boolean;
  agentName: string;
  ready: number;
  attention: number;
  total: number;
  pendingChanges: boolean;
  onGoToReady?(): void;
  onGoToAttention?(): void;
  onAcceptAll?(): void;
}

/** Счётчики над документом: те же значки, подписи и склонения, что в плагине. */
export function renderToolbarStatus(toolbar: HTMLElement, props: StatusProps): void {
  const status = div({ cls: "codex-review-editor-status", attr: { "aria-live": "polite" } }, toolbar);

  const item = (icon: string, title: string, cls: string, count?: number, action?: () => void): void => {
    const node = action
      ? el("button", { cls: `codex-review-editor-status-item ${cls}`, title, attr: { type: "button", "aria-label": title } }, status)
      : el("span", { cls: `codex-review-editor-status-item ${cls}`, title, attr: { "aria-label": title } }, status);
    setIcon(el("span", { cls: "codex-review-editor-status-icon" }, node), icon);
    if (count !== undefined) el("span", { cls: "codex-review-editor-status-count", text: String(count) }, node);
    if (action) node.addEventListener("click", action);
  };

  if (props.busy) {
    item("clock-3", `${props.agentName} обрабатывает пакет комментариев`, "is-processing");
  }
  if (props.ready > 0) {
    const form = russianCountForm(props.ready, "комментарий готов", "комментария готовы", "комментариев готовы");
    item("hourglass", `${props.ready} ${form} к отправке`, "is-ready", props.ready, props.onGoToReady);
  }
  if (props.attention > 0) {
    const form = russianCountForm(
      props.attention,
      "комментарий требует",
      "комментария требуют",
      "комментариев требуют"
    );
    item("triangle-alert", `${props.attention} ${form} вашего внимания`, "is-attention", props.attention, props.onGoToAttention);
  }
  if (!props.busy && props.ready === 0 && props.attention === 0) {
    item(
      props.total > 0 ? "circle-check" : "message-square",
      props.total > 0 ? "Все комментарии обработаны" : "Комментариев пока нет",
      "is-complete"
    );
  }
  if (props.pendingChanges && props.onAcceptAll) {
    iconButton(status, "check-check", "Принять все правки", props.onAcceptAll, "codex-review-accept-all");
  }
}

export type SidebarPanel = "history" | "versions" | "comments";

/** Вкладки боковой панели: порядок и подписи те же — Чат, Версии, Комментарии. */
export function renderSidebarTabs(
  parent: HTMLElement,
  active: SidebarPanel,
  onSelect: (panel: SidebarPanel) => void,
  busy = false
): void {
  parent.replaceChildren();
  const tabs = div({ cls: "codex-review-tabs" }, parent);
  for (const [value, label] of [
    ["history", "Чат"],
    ["versions", "Версии"],
    ["comments", "Комментарии"]
  ] as const) {
    const button = el("button", {
      cls: value === active ? "is-active" : "",
      text: label,
      attr: { type: "button" }
    }, tabs);
    if (value === "history" && busy) button.classList.add("has-running-task");
    button.addEventListener("click", () => onSelect(value));
  }
}

/** Кнопка отправки пакета комментариев — с числом и подписью как в плагине. */
export function renderSendButton(
  parent: HTMLElement,
  count: number,
  agentName: string,
  busy: boolean,
  onSend: () => void
): HTMLButtonElement {
  const footer = div({ cls: "codex-review-margin-footer" }, parent);
  const send = el("button", { cls: "codex-review-margin-send mod-cta", attr: { type: "button" } }, footer);
  setIcon(el("span", { cls: "codex-review-margin-send-icon" }, send), "send");
  el("span", { cls: "codex-review-margin-send-count", text: String(count), attr: { "aria-hidden": "true" } }, send);
  const form = russianCountForm(count, "комментарий", "комментария", "комментариев");
  send.title = busy
    ? `Поставить ${count} ${form} в очередь. Остановить обработку можно во вкладке «Чат»`
    : `Отправить ${count} ${form} в ${agentName}`;
  send.setAttribute("aria-label", send.title);
  send.disabled = count === 0;
  send.addEventListener("click", onSend);
  return send;
}
