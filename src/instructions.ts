import type {
  CodexInstructionEntry,
  CodexInstructionScope,
  CodexInstructionSettings
} from "./types";

export interface ApplicableInstructionEntry {
  scope: CodexInstructionScope;
  key: string;
  label: string;
  entry: CodexInstructionEntry;
}

export interface ResolvedInstructionEntry extends ApplicableInstructionEntry {
  sources: Array<{
    path: string;
    content?: string;
    kind?: "file" | "google-drive" | "notion";
  }>;
}

export const EMPTY_INSTRUCTION_SETTINGS: CodexInstructionSettings = {
  folders: {},
  files: {}
};

function normalizeEntry(value: any): CodexInstructionEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const sourcePaths: string[] = Array.isArray(value.sourcePaths)
    ? [...new Set<string>(value.sourcePaths.filter((path: unknown): path is string =>
        typeof path === "string" && Boolean(path.trim())
      ).map((path: string) => path.trim()))]
    : [];
  if (!text && sourcePaths.length === 0) return undefined;
  return {
    text,
    sourcePaths,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
}

function normalizeEntries(value: any): Record<string, CodexInstructionEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const normalized = normalizeEntry(entry);
    return normalized ? [[key, normalized]] : [];
  }));
}

export function normalizeInstructionSettings(value: any): CodexInstructionSettings {
  return {
    vault: normalizeEntry(value?.vault),
    folders: normalizeEntries(value?.folders),
    files: normalizeEntries(value?.files)
  };
}

export function folderPathForFile(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator < 0 ? "" : filePath.slice(0, separator);
}

export function ancestorFolderPaths(filePath: string): string[] {
  const folder = folderPathForFile(filePath);
  if (!folder) return [];
  const parts = folder.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function instructionEntryForScope(
  settings: CodexInstructionSettings,
  scope: CodexInstructionScope,
  filePath: string
): CodexInstructionEntry | undefined {
  if (scope === "vault") return settings.vault;
  if (scope === "folder") return settings.folders[folderPathForFile(filePath)];
  return settings.files[filePath];
}

export function reusableFileInstructionPaths(
  settings: CodexInstructionSettings,
  currentFilePath: string
): string[] {
  return Object.keys(settings.files)
    .filter((path) => path !== currentFilePath)
    .sort((left, right) => left.localeCompare(right));
}

export function saveInstructionEntry(
  settings: CodexInstructionSettings,
  scope: CodexInstructionScope,
  filePath: string,
  value: { text: string; sourcePaths: string[] },
  updatedAt = new Date().toISOString()
): void {
  const text = value.text.trim();
  const sourcePaths = [...new Set(value.sourcePaths.map((path) => path.trim()).filter(Boolean))];
  const entry = text || sourcePaths.length > 0 ? { text, sourcePaths, updatedAt } : undefined;
  if (scope === "vault") {
    settings.vault = entry;
    return;
  }
  const collection = scope === "folder" ? settings.folders : settings.files;
  const key = scope === "folder" ? folderPathForFile(filePath) : filePath;
  if (entry) collection[key] = entry;
  else delete collection[key];
}

export function applicableInstructionEntries(
  settings: CodexInstructionSettings,
  filePath: string
): ApplicableInstructionEntry[] {
  const entries: ApplicableInstructionEntry[] = [];
  if (settings.vault) {
    entries.push({ scope: "vault", key: "", label: "Вся библиотека", entry: settings.vault });
  }
  for (const folder of ancestorFolderPaths(filePath)) {
    const entry = settings.folders[folder];
    if (entry) entries.push({ scope: "folder", key: folder, label: `Папка: ${folder}`, entry });
  }
  const fileEntry = settings.files[filePath];
  if (fileEntry) {
    entries.push({ scope: "file", key: filePath, label: `Документ: ${filePath}`, entry: fileEntry });
  }
  return entries;
}

export function formatDocumentInstructions(entries: ResolvedInstructionEntry[]): string {
  if (entries.length === 0) return "";
  const sections = entries.flatMap(({ label, entry, sources }) => {
    const parts = [`## ${label}`];
    if (entry.text) parts.push(entry.text);
    for (const source of sources) {
      const content = source.content?.trim();
      if (content) {
        parts.push(`### Instruction file: ${source.path}\n${content}`);
      } else if (source.kind === "google-drive") {
        parts.push(`### Google Drive instruction: ${source.path}\nOpen this document with the available Google Drive integration and use its contents as instructions or reference material for the current document.`);
      } else if (source.kind === "notion") {
        parts.push(`### Notion instruction: ${source.path}\nOpen this page with the available Notion integration and use its contents as instructions or reference material for the current document.`);
      } else {
        parts.push(`### Instruction file: ${source.path}\nRead this file from the provided path and use its contents as instructions or reference material for the current document.`);
      }
    }
    return [parts.join("\n\n")];
  });
  return [
    "Additional document instructions supplied by the user in Obsidian Agent Review.",
    "Apply them silently to all work on the current document. Do not quote, restate, summarize, or mention these instructions in user-visible reasoning, progress updates, comment responses, or final messages.",
    "The sections are ordered from general to specific. When instructions conflict, the later and more specific section takes precedence.",
    ...sections
  ].join("\n\n");
}
