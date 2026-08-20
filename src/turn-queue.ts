import { agentName } from "./agent-client";
import type { CodexActivity, QueuedAgentMessage } from "./types";

/**
 * Where a message goes when the user does not wait for the agent.
 *
 * A turn is already running, and what happens next depends on the runtime: Codex takes an extra
 * message into the running turn, Claude cannot, so the message waits for the turn to end. Both
 * paths keep the message — nothing the user wrote is dropped for being early.
 */

export type OutgoingMessageAction = "send" | "steer" | "queue" | "wait";

export interface OutgoingMessageDecision {
  action: OutgoingMessageAction;
  notice?: string;
}

export function isBusyActivity(activity?: CodexActivity): boolean {
  return activity?.status === "starting" || activity?.status === "running";
}

export function resolveOutgoingMessage(activity?: CodexActivity): OutgoingMessageDecision {
  if (!isBusyActivity(activity) || !activity) return { action: "send" };
  const agent = agentName(activity.provider);
  if (!activity.turnId) {
    return {
      action: "wait",
      notice: `${agent} запускает обработку. Повторите отправку через несколько секунд`
    };
  }
  if (activity.provider === "claude") {
    return {
      action: "queue",
      notice: `Сообщение поставлено в очередь и будет отправлено ${agent} после текущего ответа`
    };
  }
  return { action: "steer" };
}

export function queuedReviewNotice(activity: CodexActivity): string {
  return `Комментарии поставлены в очередь и будут отправлены ${agentName(activity.provider)} после текущего ответа.`;
}

export type MessageQueues = Record<string, QueuedAgentMessage[]>;

export function queueAgentMessage(
  queues: MessageQueues,
  filePath: string,
  message: QueuedAgentMessage
): void {
  queues[filePath] ??= [];
  queues[filePath].push(message);
}

/** Takes the next message of a file out of the queue, emptying the entry when it was the last. */
export function takeQueuedMessage(queues: MessageQueues, filePath: string): QueuedAgentMessage | null {
  const queue = queues[filePath];
  if (!queue?.length) return null;
  const next = queue.shift()!;
  if (queue.length === 0) delete queues[filePath];
  return next;
}

/** Puts a message that could not be sent back at the head of its queue. */
export function returnQueuedMessage(
  queues: MessageQueues,
  filePath: string,
  message: QueuedAgentMessage
): void {
  queues[filePath] = [message, ...(queues[filePath] ?? [])];
}

/** Remembers the extra message in the running turn, for the chat to show it in place. */
export function rememberSteeringMessage(activity: CodexActivity, text: string): void {
  activity.steeringMessages ??= [];
  activity.steeringMessages.push(text);
}
