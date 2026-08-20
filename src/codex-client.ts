import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import readline from "node:readline";
import { codexAppServerArgs } from "./agent-access";
import {
  agentEnvironment,
  killProcessTree,
  resolveAgentCommand,
  spawnsDetached
} from "./agent-command";
import { CODEX_REVIEW_DEVELOPER_INSTRUCTIONS } from "./anchors";
import type { AgentClient, AgentTurnOptions } from "./agent-client";
import type {
  CodexLocalAttachment,
  CodexModelOption,
  CodexSkillOption,
  CodexThreadGoal,
  CodexThreadSummary
} from "./types";

const CODEX_REVIEW_PERMISSIONS_PROFILE = "obsidian-review";

export function codexReviewDeveloperInstructions(additional?: string): string {
  const custom = additional?.trim();
  return custom
    ? `${CODEX_REVIEW_DEVELOPER_INSTRUCTIONS}\n\n${custom}`
    : CODEX_REVIEW_DEVELOPER_INSTRUCTIONS;
}

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: RpcErrorShape;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CodexRpcError extends Error {
  constructor(message: string, readonly details?: RpcErrorShape) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export function isActiveWriterConflict(error: unknown): boolean {
  return error instanceof CodexRpcError && /already has an active writer|active writer/i.test(error.message);
}

export function toUserFacingCodexError(error: unknown): Error {
  if (isActiveWriterConflict(error)) {
    return new Error(
      "Эта задача сейчас занята в другом интерфейсе Codex. Плагин сохранил прежнюю задачу и комментарии. " +
      "Переключитесь с неё в Codex Desktop; если блокировка останется, закройте Codex Desktop и повторите отправку."
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function skillMenuDescription(skill: any): string | undefined {
  const shortDescription = typeof skill?.shortDescription === "string"
    ? skill.shortDescription
    : typeof skill?.short_description === "string" ? skill.short_description : undefined;
  const source = shortDescription ?? (typeof skill?.description === "string" ? skill.description : undefined);
  if (!source) return undefined;
  const normalized = source.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const phrase = shortDescription
    ? normalized
    : normalized.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim() ?? normalized;
  return phrase.length <= 180 ? phrase : `${phrase.slice(0, 177).trimEnd()}…`;
}

export function buildTurnInput(
  text: string,
  attachments: CodexLocalAttachment[] = [],
  skills: CodexSkillOption[] = []
): any[] {
  const imageExtensions = new Set(["bmp", "gif", "jpeg", "jpg", "png", "webp"]);
  const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]);
  return [
    { type: "text", text, text_elements: [] },
    ...skills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
    ...attachments.map((attachment) => {
      const extension = attachment.name.split(".").at(-1)?.toLocaleLowerCase() ?? "";
      if (imageExtensions.has(extension)) return { type: "localImage", path: attachment.path };
      if (audioExtensions.has(extension)) return { type: "localAudio", path: attachment.path };
      return { type: "mention", name: attachment.name, path: attachment.path };
    })
  ];
}

export const appServerEnvironment = agentEnvironment;

export function resolveCodexCommand(configured: string): string {
  return resolveAgentCommand(configured, "codex");
}

export class CodexAppServerClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly displayName = "Codex";
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stderr = "";
  private starting: Promise<void> | null = null;
  private notificationListeners = new Set<(message: RpcMessage) => void>();
  private activeTurnIds = new Set<string>();

  constructor(private readonly command: string) {}

  async connect(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startProcess(): Promise<void> {
    const executable = resolveCodexCommand(this.command);
    const useShell = process.platform === "win32" && !executable.toLowerCase().endsWith(".exe");
    // cmd.exe splits an unquoted path at its spaces, and a resolved path may well contain one.
    const launched = useShell && /\s/u.test(executable) ? `"${executable}"` : executable;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launched, codexAppServerArgs(), {
        cwd: process.cwd(),
        env: agentEnvironment(),
        windowsHide: true,
        shell: useShell,
        // A shell child of its own would break the group kill on Windows only, where taskkill
        // walks the tree instead.
        detached: spawnsDetached() && !useShell,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw this.asLaunchError(error);
    }

    this.process = child;
    this.stderr = "";
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.once("error", (error) => this.handleProcessFailure(this.asLaunchError(error)));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `\n${detail}` : "";
      this.handleProcessFailure(
        new Error(`Codex App Server завершился (${signal ?? `код ${String(code)}`}).${suffix}`)
      );
    });

    await this.request("initialize", {
      clientInfo: {
        name: "obsidian_agent_review",
        title: "Obsidian Agent Review",
        version: "0.25.3"
      },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  private asLaunchError(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`Не удалось запустить команду Codex «${this.command}»: ${detail}`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexRpcError(message.error.message ?? "Ошибка Codex App Server", message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.id === "number" && message.method) {
      this.answerServerRequest(message);
      return;
    }

    if (message.method === "turn/completed") {
      const completedTurnId = message.params?.turn?.id ?? message.params?.turnId;
      if (typeof completedTurnId === "string") this.activeTurnIds.delete(completedTurnId);
    }
    for (const listener of this.notificationListeners) listener(message);
  }

  private answerServerRequest(message: RpcMessage): void {
    if (message.method === "item/fileChange/requestApproval") {
      this.write({ id: message.id, result: { decision: "accept" } });
      return;
    }
    if (message.method === "item/commandExecution/requestApproval") {
      this.write({ id: message.id, result: { decision: "decline" } });
      return;
    }
    this.write({
      id: message.id,
      error: { code: -32601, message: `Метод ${message.method ?? "unknown"} не поддерживается клиентом` }
    });
  }

  private handleProcessFailure(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.activeTurnIds.clear();
    this.process = null;
  }

  private write(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Codex App Server не подключён");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private async request(method: string, params: unknown = {}, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server не ответил на ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onNotification(listener: (message: RpcMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async readAccount(): Promise<{ account: any; requiresOpenaiAuth: boolean }> {
    await this.connect();
    return this.request("account/read", { refreshToken: false });
  }

  async startChatGptLogin(): Promise<{
    loginId: string;
    verificationUrl: string;
    userCode: string;
  }> {
    await this.connect();
    return this.request("account/login/start", { type: "chatgptDeviceCode" });
  }

  async listThreads(): Promise<CodexThreadSummary[]> {
    await this.connect();
    const result = await this.request("thread/list", {
      cursor: null,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      archived: false
    });
    return Array.isArray(result?.data) ? result.data : [];
  }

  async listModels(): Promise<CodexModelOption[]> {
    await this.connect();
    const result = await this.request("model/list", { cursor: null, limit: 100, includeHidden: false });
    if (!Array.isArray(result?.data)) return [];
    return result.data
      .filter((model: any) => typeof model?.id === "string" && typeof model?.model === "string")
      .map((model: any) => ({
        id: model.id,
        model: model.model,
        displayName: typeof model.displayName === "string" ? model.displayName : model.model,
        description: typeof model.description === "string" ? model.description : undefined,
        isDefault: Boolean(model.isDefault)
      }));
  }

  async listSkills(cwd: string, forceReload = false): Promise<CodexSkillOption[]> {
    await this.connect();
    const result = await this.request("skills/list", { cwds: [cwd], forceReload });
    const entries = Array.isArray(result?.data) ? result.data : [];
    const entry = entries.find((item: any) => item?.cwd === cwd) ?? entries[0];
    if (!Array.isArray(entry?.skills)) return [];
    return entry.skills
      .filter((skill: any) => skill?.enabled !== false
        && typeof skill?.name === "string"
        && typeof skill?.path === "string")
      .map((skill: any) => ({
        name: skill.name,
        path: skill.path,
        description: skillMenuDescription(skill),
        scope: ["user", "repo", "system", "admin"].includes(skill.scope) ? skill.scope : undefined
      }))
      .sort((left: CodexSkillOption, right: CodexSkillOption) => left.name.localeCompare(right.name));
  }

  async readThread(threadId: string): Promise<any> {
    await this.connect();
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    return result?.thread;
  }

  async readThreadGoal(threadId: string): Promise<CodexThreadGoal | null> {
    await this.connect();
    const result = await this.request("thread/goal/get", { threadId });
    return result?.goal ?? null;
  }

  async setThreadGoal(threadId: string, objective: string): Promise<CodexThreadGoal> {
    await this.connect();
    const result = await this.request("thread/goal/set", { threadId, objective, status: "active" });
    return result.goal as CodexThreadGoal;
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    await this.connect();
    await this.request("thread/goal/clear", { threadId });
  }

  async startThread(
    cwd: string,
    name?: string,
    model?: string,
    developerInstructions?: string
  ): Promise<CodexThreadSummary> {
    await this.connect();
    const result = await this.request("thread/start", {
      cwd,
      model: model || undefined,
      approvalPolicy: "never",
      permissions: CODEX_REVIEW_PERMISSIONS_PROFILE,
      runtimeWorkspaceRoots: [cwd],
      developerInstructions: codexReviewDeveloperInstructions(developerInstructions)
    });
    const thread = result.thread as CodexThreadSummary;
    if (name) {
      await this.request("thread/name/set", { threadId: thread.id, name });
      thread.name = name;
    }
    return thread;
  }

  async forkThread(
    threadId: string,
    cwd: string,
    name?: string,
    model?: string,
    developerInstructions?: string
  ): Promise<CodexThreadSummary> {
    await this.connect();
    const result = await this.request("thread/fork", {
      threadId,
      cwd,
      model: model || undefined,
      approvalPolicy: "never",
      permissions: CODEX_REVIEW_PERMISSIONS_PROFILE,
      runtimeWorkspaceRoots: [cwd],
      excludeTurns: true,
      deferGoalContinuation: true,
      developerInstructions: codexReviewDeveloperInstructions(developerInstructions)
    });
    const thread = result.thread as CodexThreadSummary;
    if (name) {
      await this.request("thread/name/set", { threadId: thread.id, name });
      thread.name = name;
    }
    return thread;
  }

  async sendToThread(
    threadId: string,
    cwd: string,
    text: string,
    options: AgentTurnOptions = {}
  ): Promise<{ turnId: string }> {
    await this.connect();
    if (options.resume !== false) {
      await this.request("thread/resume", {
        threadId,
        developerInstructions: codexReviewDeveloperInstructions(options.developerInstructions)
      });
    }
    const input = buildTurnInput(text, options.attachments, options.skills);
    const runtimeWorkspaceRoots = [...new Set([
      cwd,
      ...(options.workspaceRoots ?? []),
      ...(options.attachments ?? []).map((attachment) => dirname(attachment.path))
    ])];
    const applicationContext = options.applicationContext?.trim();
    try {
      const result = await this.request("turn/start", {
        threadId,
        input,
        cwd,
        model: options.model || undefined,
        approvalPolicy: "never",
        permissions: CODEX_REVIEW_PERMISSIONS_PROFILE,
        runtimeWorkspaceRoots,
        ...(applicationContext ? {
          additionalContext: {
            "obsidian-agent-review": {
              kind: "application",
              value: applicationContext
            }
          }
        } : {})
      });
      this.activeTurnIds.add(result.turn.id);
      return { turnId: result.turn.id };
    } catch (error) {
      if (!(error instanceof CodexRpcError) || !/active|in.progress|already/i.test(error.message)) throw error;
      const read = await this.request("thread/read", { threadId, includeTurns: true });
      const turns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
      const active = [...turns].reverse().find((turn: any) =>
        ["inProgress", "in_progress", "active"].includes(turn?.status)
      );
      if (!active?.id) throw error;
      const steered = await this.request("turn/steer", {
        threadId,
        expectedTurnId: active.id,
        input
      });
      this.activeTurnIds.add(steered.turnId);
      return { turnId: steered.turnId };
    }
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    text: string,
    options: {
      attachments?: CodexLocalAttachment[];
      skills?: CodexSkillOption[];
    } = {}
  ): Promise<{ turnId: string }> {
    await this.connect();
    const result = await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: buildTurnInput(text, options.attachments, options.skills)
    });
    return { turnId: result.turnId };
  }

  waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs = 30 * 60 * 1000
  ): Promise<{ status: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        stop();
        reject(new Error("Codex слишком долго обрабатывает комментарии"));
      }, timeoutMs);
      const stop = this.onNotification((message) => {
        const messageThreadId = message.params?.threadId;
        const messageTurnId = message.params?.turn?.id ?? message.params?.turnId;
        if (messageThreadId !== threadId || messageTurnId !== turnId) return;
        if (message.method === "turn/completed") {
          clearTimeout(timeout);
          stop();
          resolve({ status: message.params?.turn?.status ?? message.params?.status ?? "completed" });
        }
        if (message.method === "error") {
          clearTimeout(timeout);
          stop();
          reject(new Error(message.params?.error?.message ?? "Ошибка обработки комментариев в Codex"));
        }
      });
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.connect();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  isIdle(): boolean {
    return this.activeTurnIds.size === 0;
  }

  close(): void {
    const child = this.process;
    this.process = null;
    this.activeTurnIds.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server остановлен"));
    }
    this.pending.clear();
    if (!child || child.killed) return;
    killProcessTree(child);
  }
}
