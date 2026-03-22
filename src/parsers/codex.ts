import type {
  TUIParser,
  ParsedEvent,
  AgentState,
  ProcessIO,
  DiscoveryResult,
  ModelInfo,
  ModeInfo,
  SlashCommandInfo,
  TokenUsage,
} from "./types.ts";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

/**
 * Codex parser using `codex app-server` JSON-RPC protocol.
 *
 * Communicates via JSON-RPC over stdio. Notifications arrive as
 * JSON lines with a `method` field (no `id`). RPC responses arrive
 * as JSON lines with an `id` field matching a pending request.
 */
export class CodexParser implements TUIParser {
  name = "codex";
  command = "codex";

  private nextId = 1;
  private state: AgentState = "idle";
  private threadId: string | null = null;
  private pendingModel: string | null = null;
  private pendingMode: string | null = null;
  private lineBuffer = "";

  /** Map of RPC request id -> pending promise */
  readonly pending = new Map<number, PendingRpc>();

  spawnArgs(_cwd: string): { args: string[]; env?: Record<string, string> } {
    return { args: ["app-server"] };
  }

  async discover(io: ProcessIO): Promise<DiscoveryResult> {
    let lineBuffer = "";

    const dataHandler = (data: string) => {
      lineBuffer += data;
      const parts = lineBuffer.split("\n");
      lineBuffer = parts.pop()!;
      // Resolve pending RPC responses during discovery
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id != null && !obj.method) {
            const pending = this.pending.get(obj.id);
            if (pending) {
              this.pending.delete(obj.id);
              if (obj.error) {
                pending.reject(new Error(obj.error.message ?? JSON.stringify(obj.error)));
              } else {
                pending.resolve(obj.result);
              }
            }
          }
        } catch {}
      }
    };

    io.onData(dataHandler);

    try {
      // Send initialize
      await this.sendRpc(io, "initialize", {
        clientInfo: { name: "adapter-acp", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });

      // Send model/list, skills/list, collaborationMode/list in parallel
      const [modelResult, skillsResult, modesResult] = await Promise.all([
        this.sendRpc(io, "model/list", {}),
        this.sendRpc(io, "skills/list", {}),
        this.sendRpc(io, "collaborationMode/list", {}),
      ]);

      const models: ModelInfo[] = (modelResult?.data ?? []).map((m: any) => ({
        modelId: m.id,
        name: m.displayName ?? m.id,
        description: m.description,
      }));

      const commands: SlashCommandInfo[] = [];
      for (const entry of skillsResult?.data ?? []) {
        for (const skill of entry.skills ?? []) {
          commands.push({
            name: skill.name,
            description: skill.description ?? skill.shortDescription ?? "",
          });
        }
      }

      const modes: ModeInfo[] = (modesResult?.data ?? []).map((m: any) => ({
        id: m.mode ?? m.name,
        name: m.name,
        description: m.model ? `Model: ${m.model}` : undefined,
      }));

      return { models, commands, modes };
    } finally {
      // Reset lineBuffer so session can re-register onData
      this.lineBuffer = "";
    }
  }

  handleOutput(data: string): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    this.lineBuffer += data;
    const parts = this.lineBuffer.split("\n");
    this.lineBuffer = parts.pop()!;

    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        events.push({ type: "raw", text: line });
        continue;
      }

      // Check if this is an RPC response (has id, no method)
      if (obj.id != null && !obj.method) {
        const pending = this.pending.get(obj.id);
        if (pending) {
          this.pending.delete(obj.id);
          if (obj.error) {
            pending.reject(new Error(obj.error.message ?? JSON.stringify(obj.error)));
          } else {
            pending.resolve(obj.result);
          }
        }
        continue;
      }

      // It's a notification
      if (!obj.method) continue;

      const params = obj.params ?? {};
      this.handleNotification(obj.method, params, events);
    }

    return events;
  }

  private handleNotification(method: string, params: any, events: ParsedEvent[]): void {
    switch (method) {
      case "item/agentMessage/delta":
        if (this.state !== "responding") {
          this.state = "responding";
          events.push({ type: "state_change", state: "responding" });
        }
        if (params.delta) {
          events.push({ type: "text", text: params.delta });
        }
        break;

      case "item/started": {
        const itemType = params.item?.type;
        if (itemType === "agentMessage") {
          // "commentary" phase = thinking, "final_answer" phase = responding
          const phase = params.item?.phase;
          if (phase === "commentary") {
            if (this.state !== "thinking") {
              this.state = "thinking";
              events.push({ type: "state_change", state: "thinking" });
            }
          } else {
            if (this.state !== "responding") {
              this.state = "responding";
              events.push({ type: "state_change", state: "responding" });
            }
          }
        } else if (itemType === "reasoning") {
          if (this.state !== "thinking") {
            this.state = "thinking";
            events.push({ type: "state_change", state: "thinking" });
          }
        } else if (itemType === "commandExecution" || itemType === "fileChange") {
          this.state = "tool_calling";
          const item = params.item;
          events.push({
            type: "tool_call",
            name: itemType === "commandExecution" ? (item?.command ?? "command") : "fileChange",
            arguments: itemType === "commandExecution" ? (item?.command ?? "") : (item?.id ?? ""),
            toolCallId: item?.id,
          });
        } else if (itemType === "webSearch") {
          this.state = "tool_calling";
          events.push({
            type: "tool_call",
            name: "webSearch",
            arguments: params.item?.query ?? "",
            toolCallId: params.item?.id,
          });
        }
        break;
      }

      case "item/completed": {
        const itemType = params.item?.type;
        if (itemType === "commandExecution") {
          const item = params.item;
          events.push({
            type: "tool_result",
            name: item?.command ?? "command",
            result: item?.aggregatedOutput ?? item?.text ?? "",
            toolCallId: item?.id,
          });
        } else if (itemType === "fileChange") {
          events.push({
            type: "tool_result",
            name: "fileChange",
            result: params.item?.text ?? params.item?.id ?? "",
            toolCallId: params.item?.id,
          });
        } else if (itemType === "webSearch") {
          events.push({
            type: "tool_result",
            name: "webSearch",
            result: params.item?.result ?? "",
            toolCallId: params.item?.id,
          });
        }
        break;
      }

      case "thread/tokenUsage/updated": {
        const total = params.tokenUsage?.total;
        if (total) {
          events.push({
            type: "usage_update",
            usage: {
              inputTokens: total.inputTokens ?? 0,
              outputTokens: total.outputTokens ?? 0,
              cachedInputTokens: total.cachedInputTokens,
              reasoningOutputTokens: total.reasoningOutputTokens,
              contextWindow: params.tokenUsage?.modelContextWindow,
            },
          });
        }
        break;
      }

      case "turn/started":
        if (this.state === "idle") {
          this.state = "thinking";
          events.push({ type: "state_change", state: "thinking" });
        }
        break;

      case "turn/completed":
        this.state = "idle";
        events.push({ type: "state_change", state: "idle" });
        break;

      // thread/started, thread/status/changed, account/rateLimits/updated, etc.
      // are ignored
    }
  }

  sendPrompt(io: ProcessIO, text: string): void {
    if (!this.threadId) {
      // First prompt: start a thread, then start a turn
      const threadRpc = this.buildRpc("thread/start", { cwd: process.cwd() });
      const threadId = threadRpc.id;

      this.pending.set(threadRpc.id, {
        resolve: (result: any) => {
          this.threadId = result?.thread?.id ?? null;
          // Now send the turn
          const turnParams: Record<string, unknown> = {
            threadId: this.threadId,
            input: [{ type: "text", text }],
          };
          if (this.pendingModel) {
            turnParams.model = this.pendingModel;
            this.pendingModel = null;
          }
          if (this.pendingMode) {
            turnParams.collaborationMode = this.pendingMode;
            this.pendingMode = null;
          }
          const turnRpc = this.buildRpc("turn/start", turnParams);
          this.pending.set(turnRpc.id, {
            resolve: () => {},
            reject: (err: Error) => {
              console.error("[codex] turn/start error:", err.message);
            },
          });
          io.write(JSON.stringify(turnRpc) + "\n");
        },
        reject: (err: Error) => {
          console.error("[codex] thread/start error:", err.message);
        },
      });

      io.write(JSON.stringify(threadRpc) + "\n");
    } else {
      // Subsequent prompts: just start a turn
      const turnParams: Record<string, unknown> = {
        threadId: this.threadId,
        input: [{ type: "text", text }],
      };
      if (this.pendingModel) {
        turnParams.model = this.pendingModel;
        this.pendingModel = null;
      }
      if (this.pendingMode) {
        turnParams.collaborationMode = this.pendingMode;
        this.pendingMode = null;
      }
      const turnRpc = this.buildRpc("turn/start", turnParams);
      this.pending.set(turnRpc.id, {
        resolve: () => {},
        reject: (err: Error) => {
          console.error("[codex] turn/start error:", err.message);
        },
      });
      io.write(JSON.stringify(turnRpc) + "\n");
    }
  }

  setModel(_io: ProcessIO, modelId: string): void {
    this.pendingModel = modelId;
  }

  setMode(_io: ProcessIO, modeId: string): void {
    this.pendingMode = modeId;
  }

  cancel(io: ProcessIO): void {
    if (!this.threadId) return;
    const rpc = this.buildRpc("turn/interrupt", { threadId: this.threadId });
    this.pending.set(rpc.id, {
      resolve: () => {},
      reject: (err: Error) => {
        console.error("[codex] turn/interrupt error:", err.message);
      },
    });
    io.write(JSON.stringify(rpc) + "\n");
  }

  respondToApproval(_io: ProcessIO, _approved: boolean): void {
    // Codex app-server does not have an approval flow via JSON-RPC
  }

  currentState(): AgentState {
    return this.state;
  }

  reset(): void {
    this.nextId = 1;
    this.state = "idle";
    this.threadId = null;
    this.pendingModel = null;
    this.pendingMode = null;
    this.lineBuffer = "";
    this.pending.clear();
  }

  private buildRpc(method: string, params: Record<string, unknown> = {}): RpcRequest {
    return { jsonrpc: "2.0", id: this.nextId++, method, params };
  }

  /**
   * Send an RPC request and wait for the response.
   * Used internally by discover() which has its own onData handler.
   */
  private sendRpc(io: ProcessIO, method: string, params: Record<string, unknown>): Promise<any> {
    const rpc = this.buildRpc(method, params);
    return new Promise<any>((resolve, reject) => {
      this.pending.set(rpc.id, { resolve, reject });
      io.write(JSON.stringify(rpc) + "\n");
    });
  }
}
