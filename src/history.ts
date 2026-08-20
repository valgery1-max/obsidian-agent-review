import type { CodexChatMessage } from "./types";

function textInputs(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      Boolean(item) && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string")
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

export function parseThreadHistory(thread: unknown): CodexChatMessage[] {
  if (!thread || typeof thread !== "object") return [];
  const turns = Array.isArray((thread as any).turns) ? (thread as any).turns : [];
  const messages: CodexChatMessage[] = [];

  for (const turn of turns) {
    const turnId = typeof turn?.id === "string" ? turn.id : "";
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      if (item.type === "userMessage") {
        const text = textInputs(item.content);
        if (text) messages.push({ id: item.id, turnId, kind: "user", text });
      } else if (item.type === "reasoning") {
        const text = Array.isArray(item.summary)
          ? item.summary.filter((part: unknown): part is string => typeof part === "string").join("\n\n").trim()
          : "";
        if (text) messages.push({ id: item.id, turnId, kind: "reasoning", text });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push({
          id: item.id,
          turnId,
          kind: item.phase === "commentary" ? "commentary" : "assistant",
          text: item.text
        });
      }
    }
  }

  return messages;
}
