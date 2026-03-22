import { describe, test, expect, mock } from "bun:test";
import { ClaudeAgent } from "../../src/agents/claude-agent.ts";

function createMockConn() {
  const updates: any[] = [];
  return {
    conn: {
      sessionUpdate: mock(async (params: any) => { updates.push(params); }),
      requestPermission: mock(async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      })),
    },
    updates,
  };
}

describe("ClaudeAgent", () => {
  test("initialize returns agent info with capabilities", async () => {
    const { conn } = createMockConn();
    const agent = new ClaudeAgent(conn as any, {
      agentName: "claude", agentVersion: "2.1.0", verbose: false, passEnv: [],
    });
    const resp = await agent.initialize({ protocolVersion: 1 } as any);
    expect(resp.protocolVersion).toBe(1);
    expect(resp.agentInfo?.name).toContain("claude");
    expect(resp.agentCapabilities).toBeDefined();
  });

  test("authenticate returns empty response", async () => {
    const { conn } = createMockConn();
    const agent = new ClaudeAgent(conn as any, {
      agentName: "claude", agentVersion: "2.1.0", verbose: false, passEnv: [],
    });
    const resp = await agent.authenticate({ methodId: "none" } as any);
    expect(resp).toEqual({});
  });

  test("cancel does not throw without session", async () => {
    const { conn } = createMockConn();
    const agent = new ClaudeAgent(conn as any, {
      agentName: "claude", agentVersion: "2.1.0", verbose: false, passEnv: [],
    });
    await agent.cancel({ sessionId: "x" } as any);
  });

  test("destroy does not throw without session", () => {
    const { conn } = createMockConn();
    const agent = new ClaudeAgent(conn as any, {
      agentName: "claude", agentVersion: "2.1.0", verbose: false, passEnv: [],
    });
    agent.destroy();
  });

  test("setSessionMode rejects bypassPermissions at runtime", async () => {
    const { conn } = createMockConn();
    const agent = new ClaudeAgent(conn as any, {
      agentName: "claude", agentVersion: "2.1.0", verbose: false, passEnv: [],
    });
    await expect(
      agent.setSessionMode!({ sessionId: "s1", modeId: "bypassPermissions" } as any)
    ).rejects.toThrow("bypassPermissions");
  });
});
