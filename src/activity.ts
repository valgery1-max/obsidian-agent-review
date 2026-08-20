import type { AgentProvider, CodexActivity, CodexActivityEntry } from "./types";

export interface CodexNotification {
  method?: string;
  params?: any;
}

export function createCodexActivity(
  filePath: string,
  threadId: string,
  taskLabel: string,
  options: {
    source?: CodexActivity["source"];
    commentIds?: string[];
    beforeText?: string;
    workingCopyPath?: string;
    requestText?: string;
    model?: string;
    followUpId?: string;
    provider?: AgentProvider;
  } = {},
  startedAt = new Date().toISOString()
): CodexActivity {
  return {
    filePath,
    provider: options.provider ?? "codex",
    threadId,
    turnId: "",
    taskLabel,
    status: "starting",
    source: options.source ?? "review",
    startedAt,
    entries: [],
    finalMessage: "",
    itemPhases: {},
    commentIds: options.commentIds ?? [],
    beforeText: options.beforeText ?? "",
    workingCopyPath: options.workingCopyPath,
    requestText: options.requestText,
    steeringMessages: [],
    model: options.model,
    followUpId: options.followUpId
  };
}

function entry(activity: CodexActivity, id: string, kind: CodexActivityEntry["kind"]): CodexActivityEntry {
  let current = activity.entries.find((item) => item.id === id);
  if (!current) {
    current = { id, kind, text: "" };
    activity.entries.push(current);
  }
  return current;
}

function eventTurnId(notification: CodexNotification): string | undefined {
  return notification.params?.turnId ?? notification.params?.turn?.id;
}

function matchesActivity(activity: CodexActivity, notification: CodexNotification): boolean {
  const threadId = notification.params?.threadId;
  if (threadId && threadId !== activity.threadId) return false;
  const turnId = eventTurnId(notification);
  if (activity.turnId && turnId && activity.turnId !== turnId) return false;
  return true;
}

function bindTurn(activity: CodexActivity, notification: CodexNotification): void {
  const turnId = eventTurnId(notification);
  if (!activity.turnId && turnId) activity.turnId = turnId;
}

function phaseOf(value: unknown): "commentary" | "final_answer" | "unknown" {
  return value === "commentary" || value === "final_answer" ? value : "unknown";
}

export function bindCodexActivityTurn(activity: CodexActivity, turnId: string): void {
  activity.turnId = turnId;
  activity.status = "running";
}

export function failCodexActivity(activity: CodexActivity, error: string): void {
  activity.status = "failed";
  activity.error = error;
  activity.completedAt = new Date().toISOString();
}

export function interruptCodexActivity(
  activity: CodexActivity,
  reason: string,
  completedAt = new Date().toISOString()
): boolean {
  if (activity.status !== "starting" && activity.status !== "running") return false;
  activity.status = "interrupted";
  activity.completedAt = completedAt;
  activity.error = reason;
  return true;
}

export function applyCodexNotification(activity: CodexActivity, notification: CodexNotification): boolean {
  if (!notification.method || !matchesActivity(activity, notification)) return false;
  const { method, params = {} } = notification;

  if (method === "turn/started") {
    bindTurn(activity, notification);
    activity.status = "running";
    return true;
  }

  if (method === "item/started") {
    bindTurn(activity, notification);
    const item = params.item;
    if (item?.type === "agentMessage" && item.id) {
      const phase = phaseOf(item.phase);
      activity.itemPhases[item.id] = phase;
      if (phase === "commentary" && item.text) entry(activity, `message:${item.id}`, "commentary").text = item.text;
      if (phase === "final_answer" && item.text) activity.finalMessage = item.text;
      return true;
    }
    return item?.type === "reasoning";
  }

  if (method === "item/reasoning/summaryPartAdded") {
    bindTurn(activity, notification);
    entry(activity, `reasoning:${params.itemId}:${params.summaryIndex}`, "reasoning");
    return true;
  }

  if (method === "item/reasoning/summaryTextDelta") {
    bindTurn(activity, notification);
    entry(activity, `reasoning:${params.itemId}:${params.summaryIndex}`, "reasoning").text += params.delta ?? "";
    return true;
  }

  if (method === "item/agentMessage/delta") {
    bindTurn(activity, notification);
    const phase = activity.itemPhases[params.itemId] ?? "unknown";
    if (phase === "commentary") {
      entry(activity, `message:${params.itemId}`, "commentary").text += params.delta ?? "";
    } else if (phase === "final_answer") {
      activity.finalMessage += params.delta ?? "";
    }
    return phase !== "unknown";
  }

  if (method === "item/completed") {
    bindTurn(activity, notification);
    const item = params.item;
    if (item?.type === "reasoning" && item.id) {
      const summaries = Array.isArray(item.summary) ? item.summary : [];
      summaries.forEach((text: string, index: number) => {
        entry(activity, `reasoning:${item.id}:${index}`, "reasoning").text = text;
      });
      return true;
    }
    if (item?.type === "agentMessage" && item.id) {
      const phase = phaseOf(item.phase ?? activity.itemPhases[item.id]);
      activity.itemPhases[item.id] = phase;
      if (phase === "commentary") {
        entry(activity, `message:${item.id}`, "commentary").text = item.text ?? "";
      } else {
        activity.finalMessage = item.text ?? activity.finalMessage;
      }
      return true;
    }
    return false;
  }

  if (method === "turn/completed") {
    bindTurn(activity, notification);
    const status = params.turn?.status ?? params.status ?? "completed";
    activity.status = status === "completed"
      ? "completed"
      : status === "interrupted" ? "interrupted" : "failed";
    if (activity.status === "failed" && !activity.error) activity.error = `Задача завершилась: ${String(status)}`;
    activity.completedAt = new Date().toISOString();
    return true;
  }

  if (method === "error") {
    bindTurn(activity, notification);
    failCodexActivity(activity, params.error?.message ?? "Ошибка обработки комментариев в Codex");
    return true;
  }

  return false;
}
