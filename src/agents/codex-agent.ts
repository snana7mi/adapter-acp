import type { Agent } from "@agentclientprotocol/sdk";
import { Session } from "../acp/session.ts";
import { getParser } from "../parsers/registry.ts";
import type { AgentClient, AgentOptions } from "./shared.ts";
import { buildConfigOptions } from "./shared.ts";
import type { ParsedEvent } from "../parsers/types.ts";
import { warn } from "../utils/logger.ts";

export class CodexAgent implements Agent {
  private conn: AgentClient;
  private options: AgentOptions;
  private session: Session | null = null;
  private configOptions: any[] = [];

  constructor(conn: AgentClient, options: AgentOptions) {
    this.conn = conn;
    this.options = options;
  }

  async initialize(params: any): Promise<any> {
    return {
      protocolVersion: params.protocolVersion ?? 1,
      agentInfo: {
        name: `adapter-acp/${this.options.agentName}`,
        version: this.options.agentVersion,
      },
      agentCapabilities: {},
    };
  }

  async authenticate(_params: any): Promise<any> {
    return {};
  }

  async newSession(params: any): Promise<any> {
    if (this.session) {
      throw new Error("Session already exists");
    }

    const cwd = params.cwd || this.options.cwd;
    if (!cwd) {
      throw new Error("cwd is required");
    }

    const parser = getParser(this.options.agentName);
    const session = new Session(parser, {
      cwd,
      passEnv: this.options.passEnv,
    });

    session.onEvent((event) => this.handleParserEvent(session.id, event));
    await session.start();
    this.session = session;

    const discovery = await session.discover();

    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: discovery.commands,
      },
    });

    const currentModelId = discovery.models[0]?.modelId ?? "";
    const currentModeId = discovery.modes[0]?.id ?? "";
    this.configOptions = buildConfigOptions(
      discovery.models, currentModelId,
      discovery.modes, currentModeId,
    );

    return {
      sessionId: session.id,
      models: {
        currentModelId,
        availableModels: discovery.models,
      },
      modes: {
        currentModeId,
        availableModes: discovery.modes,
      },
      configOptions: this.configOptions,
    };
  }

  async prompt(params: any): Promise<any> {
    if (!this.session) {
      throw new Error("No active session");
    }
    if (this.session.isPrompting()) {
      throw new Error("A prompt is already in progress");
    }

    const text = params.prompt?.[0]?.text;
    if (!text) {
      throw new Error("prompt text is required");
    }

    const stopReason = await this.session.prompt(text);
    return { stopReason };
  }

  async cancel(_params: any): Promise<void> {
    if (this.session) {
      this.session.cancel();
    }
  }

  async setSessionMode(params: any): Promise<any> {
    if (!this.session) throw new Error("No active session");
    this.session.setMode(params.modeId);
    this.updateConfigOptionValue("mode", params.modeId);
    await this.conn.sessionUpdate({
      sessionId: this.session.id,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    });
    await this.emitConfigUpdate();
    return {};
  }

  async unstable_setSessionModel(params: any): Promise<any> {
    if (!this.session) throw new Error("No active session");
    this.session.setModel(params.modelId);
    this.updateConfigOptionValue("model", params.modelId);
    await this.emitConfigUpdate();
    return {};
  }

  async setSessionConfigOption(params: any): Promise<any> {
    if (!this.session) throw new Error("No active session");

    const { configId, value } = params;
    if (configId === "model") {
      this.session.setModel(value);
    } else if (configId === "mode") {
      this.session.setMode(value);
    } else {
      throw new Error(`Unknown config option: ${configId}`);
    }

    this.updateConfigOptionValue(configId, value);
    await this.emitConfigUpdate();
    return { configOptions: this.configOptions };
  }

  destroy() {
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
  }

  private updateConfigOptionValue(configId: string, value: string) {
    this.configOptions = this.configOptions.map((opt: any) =>
      opt.id === configId ? { ...opt, currentValue: value } : opt
    );
  }

  private async emitConfigUpdate() {
    if (!this.session) return;
    await this.conn.sessionUpdate({
      sessionId: this.session.id,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: this.configOptions,
      },
    });
  }

  private handleParserEvent(sessionId: string, event: ParsedEvent) {
    switch (event.type) {
      case "thinking":
        this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.text },
          },
        });
        break;

      case "text":
      case "raw":
        this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.text },
          },
        });
        break;

      case "tool_call": {
        const toolCallId = event.toolCallId ?? this.session!.nextToolCallId();
        this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: event.name,
            kind: event.name === "webSearch" ? "fetch" : event.name === "fileChange" ? "edit" : "execute",
            status: "in_progress",
            content: [],
          },
        });
        break;
      }

      case "tool_result": {
        const tcId = event.toolCallId ?? this.session!.activeToolCallId ?? "tc_0";
        this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: tcId,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: event.result } }],
          },
        });
        break;
      }

      case "usage_update":
        this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            usage: event.usage,
          },
        });
        break;

      case "approval_request":
        this.handleApprovalRequest(sessionId, event.description, event.tool);
        break;

      case "state_change":
        // Handled internally by Session.handleOutput to resolve prompts
        break;
    }
  }

  private async handleApprovalRequest(
    sessionId: string,
    description: string,
    tool?: string,
  ) {
    if (!this.session) return;

    this.session.pauseParsing();
    try {
      const toolCallId = this.session.activeToolCallId ?? this.session.nextToolCallId();
      const response = await this.conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId,
          title: description,
          kind: "other",
          status: "in_progress",
          content: [],
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "deny", name: "Reject", optionId: "reject" },
        ],
      });

      const approved =
        response.outcome.outcome === "selected" &&
        response.outcome.optionId === "allow";
      this.session.respondToApproval(approved);
    } catch (err) {
      warn(`Permission request failed: ${err}`);
      this.session.respondToApproval(false);
    } finally {
      this.session.resumeParsing();
    }
  }
}
