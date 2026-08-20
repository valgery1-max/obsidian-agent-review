export interface ChatJumpControlState {
  hidden: boolean;
  unread: boolean;
  label: string;
  title: string;
}

export interface ChatRevisionEntry {
  id: string;
  author: "user" | "agent";
  text: string;
}

export function agentChatContentRevision(entries: readonly ChatRevisionEntry[]): string {
  return entries
    .filter((entry) => entry.author === "agent" && entry.text.trim())
    .map((entry) => `${entry.id}:${entry.text.length}:${entry.text.slice(-48)}`)
    .join("|");
}

export function chatJumpControlState(atBottom: boolean, hasUnreadAgentMessage: boolean): ChatJumpControlState {
  if (atBottom) {
    return {
      hidden: true,
      unread: false,
      label: "",
      title: "Прокрутить чат вниз"
    };
  }
  if (hasUnreadAgentMessage) {
    return {
      hidden: false,
      unread: true,
      label: "Новые сообщения",
      title: "Перейти к новым сообщениям"
    };
  }
  return {
    hidden: false,
    unread: false,
    label: "",
    title: "Прокрутить чат вниз"
  };
}
