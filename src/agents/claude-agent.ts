import type { Agent } from "@agentclientprotocol/sdk";
import { query, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentClient, AgentOptions } from "./shared.ts";
import { buildConfigOptions } from "./shared.ts";
import { getToolKind } from "./tool-mapping.ts";
import { log, warn } from "../utils/logger.ts";

const CLAUDE_MODES = [
  { id: "default", name: "Default", description: "Standard behavior" },
  { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edits" },
  { id: "plan", name: "Plan", description: "Planning mode, no tool execution" },
];

export class ClaudeAgent implements Agent {
  private conn: AgentClient;
  private options: AgentOptions;
  private queryInstance: any = null;
  private sessionId: string = "";
  private _forkOnNextPrompt = false;
  private cwd: string = "";
  private configOptions: any[] = [];
  private currentModel: string = "";
  private currentPermissionMode: string = "default";
  private _loopRunning = false;
  private executablePath: string = "";

  constructor(conn: AgentClient, options: AgentOptions) {
    this.conn = conn;
    this.options = options;
  }

  setExecutablePath(path: string) {
    this.executablePath = path;
  }

  async initialize(params: any): Promise<any> {
    return {
      protocolVersion: params.protocolVersion ?? 1,
      agentInfo: {
        name: `adapter-acp/${this.options.agentName}`,
        version: this.options.agentVersion,
      },
      agentCapabilities: {
        sessionList: true,
        sessionFork: true,
        sessionResume: true,
        sessionClose: true,
      },
    };
  }

  async authenticate(_params: any): Promise<any> {
    return {};
  }

  async newSession(params: any): Promise<any> {
    const cwd = params.cwd || this.options.cwd;
    if (!cwd) throw new Error("cwd is required");

    this.cwd = cwd;

    // SDK requires a prompt to start — we use a lightweight init prompt
    // to get the system init message with models, tools, slash commands.
    // The query completes immediately after init.
    this.queryInstance = query({
      prompt: "/compact", // lightweight command that triggers init without heavy work
      options: {
        cwd,
        ...(this.executablePath ? { pathToClaudeCodeExecutable: this.executablePath } : {}),
        permissionMode: this.currentPermissionMode as any,
        persistSession: true,
      },
    });

    // Collect init message from the query stream
    let initMsg: any = null;
    for await (const msg of this.queryInstance) {
      if (msg.type === "system" && msg.subtype === "init") {
        initMsg = msg;
      }
      if (msg.type === "result") {
        break;
      }
    }

    if (!initMsg) throw new Error("Failed to receive system init from SDK");

    this.sessionId = initMsg.session_id;
    this.currentModel = initMsg.model ?? "";

    // Fetch available models
    let availableModels: any[] = [];
    try {
      const models = await this.queryInstance.supportedModels?.();
      availableModels = (models ?? []).map((m: any) => ({
        modelId: m.value ?? m.id ?? m.name,
        name: m.displayName ?? m.name ?? m.id,
        description: m.description,
      }));
    } catch {
      availableModels = [{ modelId: this.currentModel, name: this.currentModel }];
    }

    if (availableModels.length === 0) {
      availableModels = [{ modelId: this.currentModel, name: this.currentModel }];
    }

    this.configOptions = buildConfigOptions(
      availableModels, this.currentModel,
      CLAUDE_MODES, "default",
    );

    // Emit slash commands from init
    const commands = (initMsg.slash_commands ?? []).map((name: string) => ({
      name, description: "",
    }));
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: commands },
    });

    // Prepare for subsequent prompts by setting up a resumable query
    this.queryInstance = null;

    return {
      sessionId: this.sessionId,
      models: { currentModelId: this.currentModel, availableModels },
      modes: { currentModeId: "default", availableModes: CLAUDE_MODES },
      configOptions: this.configOptions,
    };
  }

  async prompt(params: any): Promise<any> {
    if (!this.sessionId) throw new Error("No active session");

    const text = params.prompt?.[0]?.text;
    if (!text) throw new Error("prompt text is required");

    // Each prompt creates a new query with resume to continue the session
    this.queryInstance = query({
      prompt: text,
      options: {
        cwd: this.cwd,
        ...(this.executablePath ? { pathToClaudeCodeExecutable: this.executablePath } : {}),
        resume: this.sessionId,
        permissionMode: this.currentPermissionMode as any,
        canUseTool: (toolName: string, input: any, opts: any) =>
          this.handleToolPermission(toolName, input, opts),
      },
    });

    let result: any = null;

    for await (const msg of this.queryInstance) {
      switch (msg.type) {
        case "assistant":
          this.handleAssistantMessage(msg);
          break;
        case "user":
          this.handleUserMessage(msg);
          break;
        case "result":
          result = msg;
          break;
      }
      if (result) break;
    }

    this.queryInstance = null;

    if (!result) {
      return { stopReason: "end_turn" };
    }

    // Emit usage update
    if (result.usage) {
      await this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "usage_update",
          usage: {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            totalCostUsd: result.total_cost_usd,
          },
        },
      });
    }

    return { stopReason: result.stop_reason ?? "end_turn" };
  }

  async cancel(_params: any): Promise<void> {
    if (this.queryInstance) {
      await this.queryInstance.interrupt();
    }
  }

  async setSessionMode(params: any): Promise<any> {
    if (params.modeId === "bypassPermissions") {
      throw new Error("bypassPermissions mode must be set at session creation, not at runtime");
    }
    this.currentPermissionMode = params.modeId ?? "default";
    this.updateConfigOptionValue("mode", params.modeId);
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    });
    await this.emitConfigUpdate();
    return {};
  }

  async unstable_setSessionModel(params: any): Promise<any> {
    this.currentModel = params.modelId;
    if (this.queryInstance?.setModel) {
      await this.queryInstance.setModel(params.modelId);
    }
    this.updateConfigOptionValue("model", params.modelId);
    await this.emitConfigUpdate();
    return {};
  }

  async setSessionConfigOption(params: any): Promise<any> {
    const { configId, value } = params;
    if (configId === "model") {
      return this.unstable_setSessionModel({ modelId: value });
    } else if (configId === "mode") {
      return this.setSessionMode({ modeId: value });
    }
    throw new Error(`Unknown config option: ${configId}`);
  }

  async listSessions(_params: any): Promise<any> {
    const sessions = await listSessions();
    return {
      sessions: (sessions ?? []).map((s: any) => ({
        sessionId: s.id ?? s.session_id,
        title: s.title ?? s.name,
      })),
    };
  }

  async loadSession(params: any): Promise<any> {
    await this.closeCurrentQuery();
    this.cwd = params.cwd || this.options.cwd || this.cwd;
    this.sessionId = params.sessionId;
    return {};
  }

  async unstable_forkSession(params: any): Promise<any> {
    await this.closeCurrentQuery();
    this.cwd = params.cwd || this.options.cwd || this.cwd;
    // Fork creates a new session by resuming with forkSession flag on next prompt
    this.sessionId = params.sessionId;
    this._forkOnNextPrompt = true;
    return { sessionId: this.sessionId }; // Will get real new ID on next prompt
  }

  async unstable_closeSession(_params: any): Promise<any> {
    await this.closeCurrentQuery();
    return {};
  }

  destroy() {
    this.closeCurrentQuery();
  }

  // --- Private ---

  private async closeCurrentQuery() {
    this._loopRunning = false;
    if (this.queryInstance) {
      try { this.queryInstance.return(undefined); } catch {}
      this.queryInstance = null;
    }
  }

  private handleAssistantMessage(msg: any) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      switch (block.type) {
        case "text":
          this.conn.sessionUpdate({
            sessionId: this.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } },
          });
          break;
        case "thinking":
          this.conn.sessionUpdate({
            sessionId: this.sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking ?? block.text } },
          });
          break;
        case "tool_use":
          this.conn.sessionUpdate({
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: block.id,
              title: block.name,
              kind: getToolKind(block.name),
              status: "in_progress",
              content: [],
            },
          });
          break;
      }
    }
  }

  private handleUserMessage(msg: any) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "tool_result") {
        const text = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: block.tool_use_id,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text } }],
          },
        });
      }
    }
  }

  private async handleToolPermission(toolName: string, input: any, options: any) {
    if (toolName === "TodoWrite") {
      this.emitPlanUpdate(input);
      return { behavior: "allow", updatedInput: input };
    }

    const response = await this.conn.requestPermission({
      sessionId: this.sessionId,
      toolCall: {
        toolCallId: options.toolUseID,
        title: options.title ?? toolName,
        kind: getToolKind(toolName),
        status: "in_progress",
        content: [],
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "allow_always", name: "Always Allow", optionId: "always_allow" },
        { kind: "deny", name: "Reject", optionId: "reject" },
      ],
    });

    if (response.outcome.outcome === "selected") {
      if (response.outcome.optionId === "always_allow") {
        return { behavior: "allow", updatedInput: input, updatedPermissions: options.suggestions ?? [] };
      }
      if (response.outcome.optionId === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
    }
    return { behavior: "deny" };
  }

  private emitPlanUpdate(input: any) {
    const entries = (input.todos ?? []).map((todo: any) => ({
      id: todo.id, title: todo.content, status: todo.status, priority: todo.priority,
    }));
    this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "plan", entries },
    });
  }

  private async onPostToolUse(input: any) {
    // PostToolUse hook — can be used for streaming tool updates
    return {};
  }

  private updateConfigOptionValue(configId: string, value: string) {
    this.configOptions = this.configOptions.map((opt: any) =>
      opt.id === configId ? { ...opt, currentValue: value } : opt
    );
  }

  private async emitConfigUpdate() {
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: this.configOptions },
    });
  }
}
