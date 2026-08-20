import type {
  AgentProvider,
  CodexLocalAttachment,
  CodexModelOption,
  CodexSkillOption,
  CodexThreadGoal,
  CodexThreadSummary
} from "./types";

export interface AgentNotification {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AgentAccountState {
  account: any;
  requiresOpenaiAuth: boolean;
}

export interface AgentTurnOptions {
  resume?: boolean;
  model?: string;
  attachments?: CodexLocalAttachment[];
  skills?: CodexSkillOption[];
  developerInstructions?: string;
  applicationContext?: string;
  workspaceRoots?: string[];
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly displayName: string;
  connect(): Promise<void>;
  onNotification(listener: (message: AgentNotification) => void): () => void;
  readAccount(): Promise<AgentAccountState>;
  startChatGptLogin?(): Promise<{ loginId: string; verificationUrl: string; userCode: string }>;
  listThreads(cwd?: string): Promise<CodexThreadSummary[]>;
  listModels(): Promise<CodexModelOption[]>;
  listSkills(cwd: string, forceReload?: boolean): Promise<CodexSkillOption[]>;
  readThread(threadId: string, cwd?: string): Promise<any>;
  readThreadGoal(threadId: string): Promise<CodexThreadGoal | null>;
  setThreadGoal(threadId: string, objective: string): Promise<CodexThreadGoal>;
  clearThreadGoal(threadId: string): Promise<void>;
  startThread(cwd: string, name?: string, model?: string, developerInstructions?: string): Promise<CodexThreadSummary>;
  forkThread(
    threadId: string,
    cwd: string,
    name?: string,
    model?: string,
    developerInstructions?: string
  ): Promise<CodexThreadSummary>;
  sendToThread(threadId: string, cwd: string, text: string, options?: AgentTurnOptions): Promise<{ turnId: string }>;
  steerTurn(
    threadId: string,
    turnId: string,
    text: string,
    options?: Pick<AgentTurnOptions, "attachments" | "skills">
  ): Promise<{ turnId: string }>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  waitForTurnCompletion(threadId: string, turnId: string, timeoutMs?: number): Promise<{ status: string }>;
  isIdle(): boolean;
  close(): void;
}

export const AGENT_NAMES: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude"
};

export function agentName(provider: AgentProvider): string {
  return AGENT_NAMES[provider];
}

export function normalizeAgentProvider(value: unknown): AgentProvider {
  return value === "claude" ? "claude" : "codex";
}
