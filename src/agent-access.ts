export const AGENT_REVIEW_WEB_SEARCH_MODE = "live" as const;

export const CLAUDE_REVIEW_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch"
] as const;

export const CLAUDE_REVIEW_DISALLOWED_TOOLS = ["Bash"] as const;

export function codexAppServerArgs(): string[] {
  return ["app-server", "-c", `web_search="${AGENT_REVIEW_WEB_SEARCH_MODE}"`];
}
