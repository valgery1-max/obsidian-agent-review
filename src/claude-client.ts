import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CLAUDE_REVIEW_ALLOWED_TOOLS,
  CLAUDE_REVIEW_DISALLOWED_TOOLS
} from "./agent-access";
import {
  agentEnvironment,
  killProcessTree,
  resolveAgentCommand,
  spawnsDetached
} from "./agent-command";
import { REVIEW_DEVELOPER_INSTRUCTIONS } from "./anchors";
import type { AgentClient, AgentNotification, AgentTurnOptions } from "./agent-client";
import type {
  CodexLocalAttachment,
  CodexModelOption,
  CodexSkillOption,
  CodexThreadGoal,
  CodexThreadSummary
} from "./types";

const CLAUDE_MODELS: CodexModelOption[] = [
  { id: "sonnet", model: "sonnet", displayName: "Claude Sonnet", isDefault: true },
  { id: "opus", model: "opus", displayName: "Claude Opus" },
  { id: "fable", model: "fable", displayName: "Claude Fable" }
];
const MAX_CLAUDE_SESSIONS = 200;

export const CLAUDE_REVIEW_RESPONSE_INSTRUCTIONS = [
  "In Agent Review comment batches, give a detailed and complete response inside the response field for each individual comment.",
  "For feedback batches, keep the visible final message to a brief completion report: confirm only that the batch was processed and per-comment responses are ready.",
  "Do not mention what you changed, found, concluded, or explained in the task chat. Keep every substantive answer inside the response field of its comment."
].join("\n");

export function claudeReviewSystemPrompt(
  additional?: string,
  goal?: string,
  turnResources?: string
): string {
  return [
    REVIEW_DEVELOPER_INSTRUCTIONS,
    CLAUDE_REVIEW_RESPONSE_INSTRUCTIONS,
    additional?.trim() || undefined,
    goal?.trim() ? `The user set this goal for the current task:\n${goal.trim()}` : undefined,
    turnResources?.trim() || undefined
  ].filter(Boolean).join("\n\n");
}

function decodeConsole(chunk: Buffer): string {
  const utf8 = chunk.toString("utf8");
  if (process.platform !== "win32" || !utf8.includes("�")) return utf8;
  for (const encoding of ["cp866", "ibm866", "windows-1251"]) {
    try {
      const decoded = new TextDecoder(encoding).decode(chunk);
      if (!decoded.includes("�")) return decoded;
    } catch {
      // Try the next Windows console encoding.
    }
  }
  return utf8;
}

export function resolveClaudeCommand(configured: string): string {
  return resolveAgentCommand(configured, "claude");
}

export function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function claudeProjectDirectory(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(claudeConfigDirectory(), "projects", encoded);
}

export function claudeSessionFile(cwd: string, threadId: string): string {
  return join(claudeProjectDirectory(cwd), `${threadId}.jsonl`);
}

export function claudeCredentialsPath(): string {
  return join(claudeConfigDirectory(), ".credentials.json");
}

export function isClaudeLoggedIn(): boolean {
  return existsSync(claudeCredentialsPath()) || Boolean(process.env.ANTHROPIC_API_KEY);
}

export class ClaudeNotInstalledError extends Error {
  constructor(command: string) {
    super(`Claude Code не найден по пути «${command}». Установите Claude Code или укажите полный путь к исполняемому файлу в настройках Agent Review.`);
    this.name = "ClaudeNotInstalledError";
  }
}

export class ClaudeNotLoggedInError extends Error {
  constructor() {
    super("Claude Code установлен, но вход не выполнен. Запустите Claude Code один раз и войдите в подписку.");
    this.name = "ClaudeNotLoggedInError";
  }
}

interface ClaudeSessionMetadata {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  createdAt?: number;
  updatedAt?: number;
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part) && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function readJsonLines(path: string): any[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function sessionMetadata(path: string, fallbackCwd = ""): ClaudeSessionMetadata {
  const entries = readJsonLines(path);
  const firstUser = entries.find((entry) => entry?.type === "user" && entry?.message?.role === "user");
  const title = [...entries].reverse().find((entry) => entry?.type === "custom-title")?.customTitle;
  const storedCwd = entries.find((entry) => typeof entry?.cwd === "string" && entry.cwd.trim())?.cwd?.trim();
  const preview = stringContent(firstUser?.message?.content).replace(/\s+/gu, " ").slice(0, 180);
  const timestamps = entries
    .map((entry) => Date.parse(entry?.timestamp))
    .filter((value) => Number.isFinite(value));
  const stats = statSync(path);
  return {
    id: basename(path, ".jsonl"),
    name: typeof title === "string" && title.trim() ? title.trim() : preview.slice(0, 80),
    preview,
    cwd: storedCwd || fallbackCwd,
    createdAt: timestamps.length > 0 ? Math.min(...timestamps) / 1000 : stats.birthtimeMs / 1000,
    updatedAt: timestamps.length > 0 ? Math.max(...timestamps) / 1000 : stats.mtimeMs / 1000
  };
}

function workspaceKey(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function claudeSessionCandidates(currentCwd: string): Array<{ path: string; fallbackCwd: string; modifiedAt: number }> {
  const root = join(claudeConfigDirectory(), "projects");
  if (!existsSync(root)) return [];
  const currentDirectory = claudeProjectDirectory(currentCwd);
  const candidates: Array<{ path: string; fallbackCwd: string; modifiedAt: number }> = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(directory, entry.name);
      candidates.push({
        path,
        fallbackCwd: directory === currentDirectory ? currentCwd : "",
        modifiedAt: statSync(path).mtimeMs
      });
    }
  }
  return candidates
    .sort((left, right) =>
      Number(Boolean(right.fallbackCwd)) - Number(Boolean(left.fallbackCwd))
      || right.modifiedAt - left.modifiedAt
    )
    .slice(0, MAX_CLAUDE_SESSIONS);
}

function claudeHistory(path: string, threadId: string): any {
  const turns: any[] = [];
  let current: any | null = null;
  for (const entry of readJsonLines(path)) {
    if (entry?.type === "user" && entry?.message?.role === "user" && entry?.origin?.kind !== "agent") {
      const text = stringContent(entry.message.content);
      if (!text) continue;
      current = { id: entry.uuid ?? randomUUID(), items: [{
        id: entry.uuid ?? randomUUID(),
        type: "userMessage",
        content: [{ type: "text", text }]
      }] };
      turns.push(current);
      continue;
    }
    if (entry?.type !== "assistant" || !current || !Array.isArray(entry?.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        current.items.push({ id: block.id ?? randomUUID(), type: "reasoning", summary: [block.thinking.trim()] });
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        current.items.push({
          id: block.id ?? randomUUID(),
          type: "agentMessage",
          phase: "final_answer",
          text: block.text.trim()
        });
      } else if (block?.type === "tool_use") {
        current.items.push({
          id: block.id ?? randomUUID(),
          type: "agentMessage",
          phase: "commentary",
          text: describeTool(block)
        });
      }
    }
  }
  return { id: threadId, turns };
}

function skillDescription(path: string): string | undefined {
  try {
    const source = readFileSync(path, "utf8").slice(0, 6000);
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? "";
    const description = frontmatter.match(/^description:\s*(.+)$/imu)?.[1]?.trim().replace(/^['"]|['"]$/gu, "");
    return description || undefined;
  } catch {
    return undefined;
  }
}

function collectSkills(root: string, scope: CodexSkillOption["scope"]): CodexSkillOption[] {
  if (!existsSync(root)) return [];
  const found: CodexSkillOption[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 5) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        found.push({ name: basename(dirname(path)), path, description: skillDescription(path), scope });
      }
    }
  };
  visit(root, 0);
  return found;
}

export function claudeResourceInstructions(
  attachments: CodexLocalAttachment[] = [],
  skills: CodexSkillOption[] = []
): string {
  const sections: string[] = [];
  if (attachments.length > 0) {
    sections.push([
      "Files attached by the user. Read them as context before responding:",
      ...attachments.map((attachment) => `- ${attachment.path}`)
    ].join("\n"));
  }
  if (skills.length > 0) {
    sections.push([
      "Skills explicitly mentioned by the user. Read each SKILL.md and follow it for this request:",
      ...skills.map((skill) => `- $${skill.name}: ${skill.path}`)
    ].join("\n"));
  }
  return sections.join("\n\n");
}

export function claudeAdditionalDirectories(options: AgentTurnOptions): string[] {
  return [...new Set([
    ...(options.workspaceRoots ?? []),
    ...(options.attachments ?? []).map((attachment) => dirname(attachment.path)),
    ...(options.skills ?? []).map((skill) => dirname(skill.path))
  ].filter((directory) => directory.trim()))];
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly displayName = "Claude";
  private readonly listeners = new Set<(message: AgentNotification) => void>();
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly interruptedTurns = new Set<string>();
  private readonly threadNames = new Map<string, string>();
  private readonly threadInstructions = new Map<string, string>();
  private readonly threadGoals = new Map<string, string>();
  private lastRateLimit: unknown = null;

  constructor(private readonly command: string) {}

  private executable(): string {
    const resolved = resolveClaudeCommand(this.command);
    if (!existsSync(resolved)) throw new ClaudeNotInstalledError(this.command);
    return resolved;
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ method, params });
  }

  onNotification(listener: (message: AgentNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.executable();
  }

  isIdle(): boolean {
    return this.running.size === 0;
  }

  close(): void {
    for (const [turnId, child] of this.running) {
      this.interruptedTurns.add(turnId);
      this.killProcess(child);
    }
    this.running.clear();
  }

  private killProcess(child: ChildProcessWithoutNullStreams): void {
    if (child.killed) return;
    killProcessTree(child);
  }

  async readAccount(): Promise<{ account: any; requiresOpenaiAuth: boolean }> {
    const executable = this.executable();
    if (!isClaudeLoggedIn()) throw new ClaudeNotLoggedInError();
    const version = spawnSync(executable, ["--version"], {
      windowsHide: true,
      encoding: "utf8",
      env: agentEnvironment()
    });
    return {
      account: {
        email: "Подписка Claude",
        planType: "subscription",
        version: String(version.stdout || "").trim(),
        rateLimit: this.lastRateLimit
      },
      requiresOpenaiAuth: false
    };
  }

  async listThreads(cwd = process.cwd()): Promise<CodexThreadSummary[]> {
    const currentKey = workspaceKey(cwd);
    const sessions = claudeSessionCandidates(cwd).flatMap((candidate): ClaudeSessionMetadata[] => {
      try {
        const metadata = sessionMetadata(candidate.path, candidate.fallbackCwd);
        return metadata.cwd && existsSync(metadata.cwd) ? [metadata] : [];
      } catch {
        return [];
      }
    });
    return sessions
      .filter((thread, index, all) => all.findIndex((candidate) => candidate.id === thread.id) === index)
      .sort((left, right) => {
        const workspaceOrder = Number(workspaceKey(right.cwd) === currentKey) - Number(workspaceKey(left.cwd) === currentKey);
        return workspaceOrder || (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      });
  }

  async listModels(): Promise<CodexModelOption[]> {
    return CLAUDE_MODELS;
  }

  async listSkills(cwd = process.cwd()): Promise<CodexSkillOption[]> {
    const roots: Array<[string, CodexSkillOption["scope"]]> = [
      [join(cwd, ".claude", "skills"), "repo"],
      [join(claudeConfigDirectory(), "skills"), "user"]
    ];
    const merged = roots.flatMap(([root, scope]) => collectSkills(root, scope));
    return merged
      .filter((skill, index, all) => all.findIndex((candidate) => candidate.name === skill.name) === index)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async readThread(threadId: string, cwd = process.cwd()): Promise<any> {
    const path = claudeSessionFile(cwd, threadId);
    return existsSync(path) ? claudeHistory(path, threadId) : { id: threadId, turns: [] };
  }

  async readThreadGoal(threadId: string): Promise<CodexThreadGoal | null> {
    const objective = this.threadGoals.get(threadId);
    return objective ? { threadId, objective, status: "active", tokenBudget: null } : null;
  }

  async setThreadGoal(threadId: string, objective: string): Promise<CodexThreadGoal> {
    this.threadGoals.set(threadId, objective);
    return { threadId, objective, status: "active", tokenBudget: null };
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    this.threadGoals.delete(threadId);
  }

  async startThread(
    cwd: string,
    name?: string,
    _model?: string,
    developerInstructions?: string
  ): Promise<CodexThreadSummary> {
    this.executable();
    const id = randomUUID();
    if (name) this.threadNames.set(id, name);
    if (developerInstructions) this.threadInstructions.set(id, developerInstructions);
    return { id, name: name ?? "", cwd };
  }

  async forkThread(
    _threadId: string,
    cwd: string,
    name?: string,
    model?: string,
    developerInstructions?: string
  ): Promise<CodexThreadSummary> {
    return this.startThread(cwd, name, model, developerInstructions);
  }

  async sendToThread(
    threadId: string,
    cwd: string,
    text: string,
    options: AgentTurnOptions = {}
  ): Promise<{ turnId: string }> {
    const executable = this.executable();
    if (!isClaudeLoggedIn()) throw new ClaudeNotLoggedInError();
    this.threadInstructions.set(threadId, options.developerInstructions?.trim() ?? "");

    const turnId = randomUUID();
    const resuming = options.resume !== false && existsSync(claudeSessionFile(cwd, threadId));
    const systemPrompt = claudeReviewSystemPrompt(
      this.threadInstructions.get(threadId),
      this.threadGoals.get(threadId),
      claudeResourceInstructions(options.attachments, options.skills)
    );
    const resourceDirectories = claudeAdditionalDirectories(options);
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", "acceptEdits",
      "--allowedTools", CLAUDE_REVIEW_ALLOWED_TOOLS.join(","),
      "--disallowedTools", CLAUDE_REVIEW_DISALLOWED_TOOLS.join(","),
      "--append-system-prompt", systemPrompt
    ];
    for (const directory of resourceDirectories) args.push("--add-dir", directory);
    if (resuming) args.push("--resume", threadId);
    else {
      args.push("--session-id", threadId);
      const name = this.threadNames.get(threadId);
      if (name) args.push("--name", name);
    }
    if (options.model) args.push("--model", options.model);

    const child = spawn(executable, args, {
      cwd,
      env: agentEnvironment(),
      windowsHide: true,
      detached: spawnsDetached(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.running.set(turnId, child);
    this.emit("turn/started", { threadId, turnId });
    // Обработчики подключаются до первой записи: если запуск не удался, ошибка приходит раньше,
    // чем мы что-то отправим, и без слушателя ход навсегда остался бы «идущим».
    this.pipeEvents(child, threadId, turnId);
    // При продолжении сессии Claude оставляет системную подсказку той, что была при её создании:
    // `--append-system-prompt` заново не применяется. Правила обработки и контекст хода тогда до
    // агента не доходят, и он отвечает как на обычный вопрос. Поэтому на продолжении они идут
    // вместе с сообщением; из видимой переписки их убирает та же чистка, что и раньше.
    try {
      child.stdin.end(resuming ? `${systemPrompt}

${text}` : text, "utf8");
    } catch (error) {
      // Записать в неживой процесс нельзя: ход заканчивается ошибкой, а не молчанием.
      this.finishTurn(threadId, turnId, "failed", error instanceof Error ? error.message : String(error));
    }
    return { turnId };
  }

  async steerTurn(
    threadId: string,
    _turnId: string,
    text: string,
    options: Pick<AgentTurnOptions, "attachments" | "skills"> = {}
  ): Promise<{ turnId: string }> {
    return this.sendToThread(threadId, process.cwd(), text, options);
  }

  async interruptTurn(_threadId: string, turnId: string): Promise<void> {
    const child = this.running.get(turnId);
    if (!child) return;
    this.interruptedTurns.add(turnId);
    this.killProcess(child);
  }

  waitForTurnCompletion(threadId: string, turnId: string, timeoutMs = 30 * 60 * 1000): Promise<{ status: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        stop();
        reject(new Error("Claude слишком долго обрабатывает запрос"));
      }, timeoutMs);
      const stop = this.onNotification((message) => {
        if (message.params?.threadId !== threadId) return;
        const messageTurnId = message.params?.turnId ?? message.params?.turn?.id;
        if (messageTurnId !== turnId) return;
        if (message.method === "turn/completed") {
          clearTimeout(timeout);
          stop();
          resolve({ status: message.params?.turn?.status ?? "completed" });
        } else if (message.method === "error") {
          clearTimeout(timeout);
          stop();
          reject(new Error(message.params?.error?.message ?? "Ошибка Claude"));
        }
      });
    });
  }

  private pipeEvents(child: ChildProcessWithoutNullStreams, threadId: string, turnId: string): void {
    let buffer = "";
    let stderr = "";
    const blockItems = new Map<number, { id: string; kind: "text" | "thinking" }>();

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          this.translate(JSON.parse(line), threadId, turnId, blockItems);
        } catch {
          // Claude may mix diagnostic output into the JSON stream.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + decodeConsole(chunk)).slice(-6000);
    });
    child.once("error", (error) => this.finishTurn(threadId, turnId, "failed", error.message));
    // Запись в неживой процесс роняет поток ввода. Без этого слушателя ошибка остаётся
    // необработанной и валит весь процесс приложения вместо того, чтобы завершить один ход.
    child.stdin.on("error", (error: Error) => this.finishTurn(threadId, turnId, "failed", error.message));
    child.once("close", (code) => {
      if (!this.running.has(turnId)) return;
      const interrupted = this.interruptedTurns.delete(turnId);
      if (interrupted) this.finishTurn(threadId, turnId, "interrupted");
      else if (code === 0) this.finishTurn(threadId, turnId, "completed");
      else this.finishTurn(threadId, turnId, "failed", stderr.trim() || `Claude Code завершился с кодом ${String(code)}`);
    });
  }

  private translate(
    event: any,
    threadId: string,
    turnId: string,
    blockItems: Map<number, { id: string; kind: "text" | "thinking" }>
  ): void {
    const base = { threadId, turnId };
    if (event.type === "rate_limit_event") {
      this.lastRateLimit = event.rate_limit ?? event;
      this.emit("agent/rateLimit", { ...base, rateLimit: this.lastRateLimit });
      return;
    }
    if (event.type === "stream_event" && event.event) {
      const inner = event.event;
      if (inner.type === "content_block_start") {
        const kind = inner.content_block?.type === "thinking" ? "thinking" : "text";
        const id = `${turnId}:${inner.index}`;
        blockItems.set(inner.index, { id, kind });
        if (kind === "thinking") {
          this.emit("item/started", { ...base, item: { type: "reasoning", id } });
          this.emit("item/reasoning/summaryPartAdded", { ...base, itemId: id, summaryIndex: 0 });
        } else {
          this.emit("item/started", { ...base, item: { type: "agentMessage", id, phase: "final_answer", text: "" } });
        }
        return;
      }
      if (inner.type === "content_block_delta") {
        const item = blockItems.get(inner.index);
        if (!item) return;
        const delta = inner.delta ?? {};
        if (item.kind === "thinking" && typeof delta.thinking === "string") {
          this.emit("item/reasoning/summaryTextDelta", {
            ...base, itemId: item.id, summaryIndex: 0, delta: delta.thinking
          });
        } else if (typeof delta.text === "string") {
          this.emit("item/agentMessage/delta", { ...base, itemId: item.id, delta: delta.text });
        }
      }
      return;
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type !== "tool_use") continue;
        const id = `${turnId}:tool:${block.id ?? randomUUID()}`;
        const text = describeTool(block);
        this.emit("item/started", { ...base, item: { type: "agentMessage", id, phase: "commentary", text } });
        this.emit("item/completed", { ...base, item: { type: "agentMessage", id, phase: "commentary", text } });
      }
      return;
    }
    if (event.type === "result") {
      const text = typeof event.result === "string" ? event.result : "";
      if (text) {
        const id = `${turnId}:final`;
        this.emit("item/completed", { ...base, item: { type: "agentMessage", id, phase: "final_answer", text } });
      }
      if (event.is_error || event.subtype === "error_during_execution") {
        this.finishTurn(threadId, turnId, "failed", text || "Claude вернул ошибку");
      }
    }
  }

  private finishTurn(
    threadId: string,
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    error?: string
  ): void {
    if (!this.running.has(turnId)) return;
    this.running.delete(turnId);
    if (status === "failed" && error) {
      this.emit("error", { threadId, turnId, error: { message: error } });
      return;
    }
    this.emit("turn/completed", { threadId, turnId, turn: { id: turnId, status } });
  }
}

function describeTool(block: any): string {
  const input = block.input ?? {};
  const file = typeof input.file_path === "string" ? basename(input.file_path) : "";
  switch (block.name) {
    case "Read": return file ? `Читает «${file}»` : "Читает файл";
    case "Edit": return file ? `Правит «${file}»` : "Правит файл";
    case "Write": return file ? `Записывает «${file}»` : "Записывает файл";
    case "Glob": return "Ищет файлы";
    case "Grep": return "Ищет по тексту";
    default: return `Использует ${String(block.name ?? "инструмент")}`;
  }
}
