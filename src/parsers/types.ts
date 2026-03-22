export type AgentState = "idle" | "thinking" | "responding" | "tool_calling" | "awaiting_approval";

export type ParsedEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: string; toolCallId?: string }
  | { type: "tool_result"; name: string; result: string; toolCallId?: string }
  | { type: "approval_request"; description: string; tool?: string }
  | { type: "state_change"; state: AgentState }
  | { type: "usage_update"; usage: TokenUsage }
  | { type: "raw"; text: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  contextWindow?: number;
}

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface ModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
}

export interface ProcessIO {
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  onClose(cb: (code: number) => void): void;
}

export interface DiscoveryResult {
  models: ModelInfo[];
  commands: SlashCommandInfo[];
  modes: ModeInfo[];
}

export interface ConfigOption {
  id: string;
  name: string;
  description: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface TUIParser {
  name: string;
  command: string;

  spawnArgs(cwd: string): { args: string[]; env?: Record<string, string> };
  discover(io: ProcessIO): Promise<DiscoveryResult>;
  handleOutput(data: string): ParsedEvent[];

  sendPrompt(io: ProcessIO, text: string): void;
  setModel(io: ProcessIO, modelId: string): void;
  setMode(io: ProcessIO, modeId: string): void;
  cancel(io: ProcessIO): void;
  respondToApproval(io: ProcessIO, approved: boolean): void;

  currentState(): AgentState;
  reset(): void;
}

export function buildConfigOptions(
  models: ModelInfo[],
  currentModelId: string,
  modes: ModeInfo[],
  currentModeId: string,
): ConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      type: "select",
      currentValue: currentModelId,
      options: models.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description,
      })),
    },
    {
      id: "mode",
      name: "Mode",
      description: "Agent operating mode",
      type: "select",
      currentValue: currentModeId,
      options: modes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
  ];
}
