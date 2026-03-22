import { describe, test, expect, mock } from "bun:test";
import { CodexAgent } from "../../src/agents/codex-agent.ts";
import { registerParser } from "../../src/parsers/registry.ts";
import type {
  TUIParser,
  ProcessIO,
  DiscoveryResult,
  ParsedEvent,
  AgentState,
} from "../../src/parsers/types.ts";

// --- Mock parser ---
function createMockParser(): TUIParser {
  return {
    name: "mock",
    command: "echo",
    spawnArgs(_cwd: string) { return { args: ["mock"] }; },
    async discover(_io: ProcessIO): Promise<DiscoveryResult> {
      return {
        models: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
        commands: [{ name: "/help", description: "Show help" }],
        modes: [
          { id: "code", name: "Code", description: "Code mode" },
          { id: "ask", name: "Ask", description: "Ask mode" },
        ],
      };
    },
    handleOutput(_data: string): ParsedEvent[] { return []; },
    sendPrompt(_io: ProcessIO, _text: string): void {},
    setModel(_io: ProcessIO, _modelId: string): void {},
    setMode(_io: ProcessIO, _modeId: string): void {},
    cancel(_io: ProcessIO): void {},
    respondToApproval(_io: ProcessIO, _approved: boolean): void {},
    currentState(): AgentState { return "idle"; },
    reset(): void {},
  };
}

registerParser("codex-agent-test", () => createMockParser());

// --- Mock SDK connection ---
function createMockConn() {
  const updates: any[] = [];
  return {
    conn: {
      sessionUpdate: mock(async (params: any) => { updates.push(params); }),
      requestPermission: mock(async (_params: any) => ({
        outcome: { outcome: "selected", optionId: "allow" },
      })),
    },
    updates,
  };
}

// Helper: mock Bun.spawn so Session.start() works.
async function withMockSpawn<T>(fn: () => Promise<T>): Promise<T> {
  const origSpawn = Bun.spawn;
  const mockStdin = { write: mock(() => {}) };
  const mockReader = {
    read: mock(async () => ({ done: true, value: undefined })),
  };
  const mockStdout = { getReader: () => mockReader };
  // @ts-ignore
  Bun.spawn = (..._args: any[]) => ({
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: null,
    pid: 12345,
    kill: mock(() => {}),
    exited: new Promise(() => {}),
  });
  try {
    return await fn();
  } finally {
    // @ts-ignore
    Bun.spawn = origSpawn;
  }
}

// Helper: create an agent with a session already established
async function createAgentWithSession() {
  const { conn, updates } = createMockConn();
  const agent = new CodexAgent(conn as any, {
    agentName: "codex-agent-test",
    agentVersion: "1.0.0",
    verbose: false,
    passEnv: [],
  });
  await withMockSpawn(async () =>
    agent.newSession({ cwd: "/tmp", mcpServers: [] } as any)
  );
  updates.length = 0;
  return { agent, conn, updates };
}

describe("CodexAgent", () => {
  test("initialize returns agent info", async () => {
    const { conn } = createMockConn();
    const agent = new CodexAgent(conn as any, {
      agentName: "codex-agent-test",
      agentVersion: "1.0.0",
      verbose: false,
      passEnv: [],
    });

    const response = await agent.initialize({
      protocolVersion: 1,
    } as any);

    expect(response.protocolVersion).toBe(1);
    expect(response.agentInfo?.name).toContain("codex-agent-test");
  });

  test("newSession creates session and returns discovery", async () => {
    const { conn, updates } = createMockConn();
    const agent = new CodexAgent(conn as any, {
      agentName: "codex-agent-test",
      agentVersion: "1.0.0",
      verbose: false,
      passEnv: [],
    });

    const response = await withMockSpawn(async () =>
      agent.newSession({ cwd: "/tmp", mcpServers: [] } as any)
    );

    expect(response.sessionId).toBeDefined();
    expect(response.models?.availableModels).toHaveLength(2);
    expect(response.modes?.availableModes).toHaveLength(2);

    const cmdsUpdate = updates.find(
      (u: any) => u.update?.sessionUpdate === "available_commands_update"
    );
    expect(cmdsUpdate).toBeDefined();
  });

  test("cancel does not throw without session", async () => {
    const { conn } = createMockConn();
    const agent = new CodexAgent(conn as any, {
      agentName: "codex-agent-test",
      agentVersion: "1.0.0",
      verbose: false,
      passEnv: [],
    });
    await agent.cancel({ sessionId: "nonexistent" } as any);
  });

  test("setSessionConfigOption rejects unknown configId", async () => {
    const { agent } = await createAgentWithSession();
    await expect(
      agent.setSessionConfigOption!({ sessionId: "s1", configId: "unknown", value: "foo" } as any)
    ).rejects.toThrow("Unknown config option: unknown");
  });

  test("destroy kills session", async () => {
    const { conn } = createMockConn();
    const agent = new CodexAgent(conn as any, {
      agentName: "codex-agent-test",
      agentVersion: "1.0.0",
      verbose: false,
      passEnv: [],
    });

    await withMockSpawn(async () =>
      agent.newSession({ cwd: "/tmp", mcpServers: [] } as any)
    );

    agent.destroy();
  });
});
