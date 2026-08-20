/**
 * Построение разметки без Obsidian.
 *
 * Интерфейс продукта должен быть одним, а не двумя похожими. Мешает этому только одно: разметка
 * плагина написана на помощниках Obsidian (`createDiv`, `createEl`, `setIcon`), которых вне
 * Obsidian нет. Здесь те же удобства на обычном DOM — он есть везде, и в Obsidian тоже.
 *
 * Поэтому общие части интерфейса пишутся один раз на этих помощниках и работают на обеих
 * поверхностях: и в плагине, и в десктопном приложении.
 */

export interface ElementOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  title?: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  parent?: HTMLElement
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.cls) node.className = options.cls;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  for (const [name, value] of Object.entries(options.attr ?? {})) node.setAttribute(name, value);
  parent?.append(node);
  return node;
}

export function div(options: ElementOptions = {}, parent?: HTMLElement): HTMLDivElement {
  return el("div", options, parent);
}

/** Кнопка со значком: тот же вид и то же поведение, что у кнопок плагина. */
export function iconButton(
  parent: HTMLElement,
  icon: string,
  title: string,
  onClick: () => void,
  cls = ""
): HTMLButtonElement {
  const button = el("button", {
    cls: `clickable-icon${cls ? ` ${cls}` : ""}`,
    title,
    attr: { type: "button", "aria-label": title }
  }, parent);
  setIcon(button, icon);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * Значки Lucide — те же, что рисует Obsidian.
 *
 * Обсидиан подставляет их сам; вне его нужен свой набор. Здесь только те значки, которые
 * действительно встречаются в интерфейсе Agent Review: лишние утяжеляют сборку и устаревают.
 */
const ICONS: Record<string, string> = {
  "message-square-plus": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
  "message-square-text": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M7 9h10"/><path d="M7 13h6"/>',
  "message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  "messages-square": '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  "file-pen-line": '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5"/><path d="M13 2v6h6"/><path d="M18.4 12.6a2 2 0 1 1 3 3L17 20l-4 1 1-4z"/>',
  "book-open-check": '<path d="M12 21V7"/><path d="M2 6h5a3 3 0 0 1 3 3v10a3 3 0 0 0-3-3H2z"/><path d="M22 6h-5a3 3 0 0 0-3 3v3"/><path d="m16 19 2 2 4-4"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/><path d="m15 5 4 4"/>',
  "trash-2": '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  "file-clock": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5"/><path d="M14 2v6h6"/><circle cx="17" cy="17" r="5"/><path d="M17 15v2l1.5 1"/>',
  "clock-3": '<circle cx="12" cy="12" r="10"/><path d="M12 6v6h4"/>',
  hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.2L12 13l-5 4.8V22"/><path d="M7 2v4.2L12 11l5-4.8V2"/>',
  "triangle-alert": '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  "check-check": '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  "square-pen": '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2 2 0 1 1 3 3L12 15l-4 1 1-4z"/>',
  "rotate-ccw": '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  "circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "corner-down-right": '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  "user-round": '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'
};

export function setIcon(target: HTMLElement, name: string): void {
  const path = ICONS[name];
  if (!path) return;
  target.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon">${path}</svg>`;
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}
