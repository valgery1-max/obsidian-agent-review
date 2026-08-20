import { normalizeAgentProvider } from "./agent-client";
import type { AgentProvider, AgentScopedValue, CodexFileThread } from "./types";

export type FileTaskSelections = Record<string, AgentScopedValue<CodexFileThread>>;
export type FileAgentStrings = Record<string, AgentScopedValue<string>>;

function normalizedThread(value: unknown, provider: AgentProvider): CodexFileThread | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<CodexFileThread>;
  return {
    threadId: typeof item.threadId === "string" ? item.threadId : "",
    threadLabel: typeof item.threadLabel === "string" ? item.threadLabel : "",
    createNew: item.createNew === true || undefined,
    provider,
    cwd: typeof item.cwd === "string" && item.cwd.trim() ? item.cwd.trim() : undefined
  };
}

export function normalizeFileTaskSelections(
  value: unknown,
  activeProviders: Record<string, AgentProvider> = {}
): FileTaskSelections {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([filePath, stored]) => {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
    const record = stored as Record<string, unknown>;
    const scoped = Object.fromEntries((["codex", "claude"] as const).flatMap((provider) => {
      const thread = normalizedThread(record[provider], provider);
      return thread ? [[provider, thread]] : [];
    })) as AgentScopedValue<CodexFileThread>;
    if (Object.keys(scoped).length > 0) return [[filePath, scoped]];

    const provider = normalizeAgentProvider((stored as Partial<CodexFileThread>).provider ?? activeProviders[filePath]);
    const legacy = normalizedThread(stored, provider);
    return legacy ? [[filePath, { [provider]: legacy }]] : [];
  }));
}

export function normalizeFileAgentStrings(
  value: unknown,
  activeProviders: Record<string, AgentProvider> = {}
): FileAgentStrings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([filePath, stored]) => {
    if (typeof stored === "string") {
      const text = stored.trim();
      return text ? [[filePath, { [normalizeAgentProvider(activeProviders[filePath])]: text }]] : [];
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
    const record = stored as Record<string, unknown>;
    const scoped = Object.fromEntries((["codex", "claude"] as const).flatMap((provider) => {
      const text = typeof record[provider] === "string" ? record[provider].trim() : "";
      return text ? [[provider, text]] : [];
    })) as AgentScopedValue<string>;
    return Object.keys(scoped).length > 0 ? [[filePath, scoped]] : [];
  }));
}

export function fileTaskSelection(
  selections: FileTaskSelections,
  filePath: string,
  provider: AgentProvider
): CodexFileThread | undefined {
  return selections[filePath]?.[provider];
}

export function rememberFileTaskSelection(
  selections: FileTaskSelections,
  filePath: string,
  provider: AgentProvider,
  thread: CodexFileThread
): void {
  const scoped = selections[filePath] ?? {};
  scoped[provider] = { ...thread, provider };
  selections[filePath] = scoped;
}

export function allFileTaskSelections(selections: FileTaskSelections): CodexFileThread[] {
  return Object.values(selections).flatMap((scoped) =>
    (["codex", "claude"] as const).flatMap((provider) => scoped[provider] ? [scoped[provider]!] : [])
  );
}

export function fileAgentString(
  values: FileAgentStrings,
  filePath: string,
  provider: AgentProvider
): string {
  return values[filePath]?.[provider] ?? "";
}

export function rememberFileAgentString(
  values: FileAgentStrings,
  filePath: string,
  provider: AgentProvider,
  text: string
): void {
  const scoped = values[filePath] ?? {};
  if (text.trim()) scoped[provider] = text;
  else delete scoped[provider];
  if (Object.keys(scoped).length > 0) values[filePath] = scoped;
  else delete values[filePath];
}

export function forgetFileAgentString(
  values: FileAgentStrings,
  filePath: string,
  provider: AgentProvider
): void {
  rememberFileAgentString(values, filePath, provider, "");
}

export function createNewTaskSelection(fileName: string, provider: AgentProvider = "codex"): CodexFileThread {
  return {
    threadId: "",
    threadLabel: `Новая задача: ${fileName}`,
    createNew: true,
    provider
  };
}

export function hasExplicitTaskSelection(target: CodexFileThread | undefined): boolean {
  return Boolean(target && (target.createNew || target.threadId.trim()));
}

export function sameTaskDirectory(left: string | null | undefined, right: string | null | undefined): boolean {
  const key = (value: string | null | undefined): string =>
    (value ?? "").trim().replace(/[\\/]+$/u, "").replace(/\\/gu, "/").toLocaleLowerCase();
  return Boolean(key(left)) && key(left) === key(right);
}

export function taskWorkingDirectory(
  target: CodexFileThread | undefined,
  vaultDirectory: string,
  provider: AgentProvider
): string {
  return provider === "claude" && target?.threadId && target.cwd?.trim()
    ? target.cwd.trim()
    : vaultDirectory;
}
