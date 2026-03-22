const TOOL_KIND_MAP: Record<string, string> = {
  Agent: "think",
  Task: "think",
  Bash: "execute",
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
  ExitPlanMode: "switch_mode",
};

export function getToolKind(toolName: string): string {
  return TOOL_KIND_MAP[toolName] ?? "other";
}
