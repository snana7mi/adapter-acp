/**
 * E2E tests for dynamic discovery.
 * Requires real `codex` and `claude` CLI installed.
 * Run with: bun test tests/e2e/dynamic-discovery.test.ts
 */
import { describe, test, expect } from "bun:test";

const TIMEOUT = 90_000;

interface E2EHelper {
  send(msg: any): void;
  waitFor(predicate: (msg: any) => boolean, timeoutMs?: number): Promise<any>;
  allMessages(): any[];
  kill(): void;
}

function startAgent(agent: string): E2EHelper {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", agent], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const messages: any[] = [];
  const waiters: { predicate: (msg: any) => boolean; resolve: (msg: any) => void }[] = [];
  let buffer = "";

  // Continuously read stdout in background
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            messages.push(msg);
            // Check waiters
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].predicate(msg)) {
                waiters[i].resolve(msg);
                waiters.splice(i, 1);
              }
            }
          } catch {}
        }
      }
    } catch {}
  })();

  return {
    send(msg: any) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    },
    waitFor(predicate: (msg: any) => boolean, timeoutMs = 45000): Promise<any> {
      // Check already received messages
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`waitFor timeout after ${timeoutMs}ms. Messages received: ${messages.length}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
    allMessages() {
      return messages;
    },
    kill() {
      proc.kill();
    },
  };
}

describe("E2E: Codex dynamic discovery", () => {
  test("session/new returns dynamically discovered models and commands", async () => {
    const agent = startAgent("codex");

    try {
      // Initialize
      agent.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "test", version: "1.0" } } });
      const initResp = await agent.waitFor((m) => m.id === 1);
      expect(initResp.result.agentInfo.name).toContain("codex");

      // Session new
      agent.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
      const sessionResp = await agent.waitFor((m) => m.id === 2);

      expect(sessionResp.result.sessionId).toBeTruthy();

      // Models: dynamically discovered, not hardcoded
      const models = sessionResp.result.models.availableModels;
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].modelId).toBeTruthy();
      expect(models[0].name).toBeTruthy();
      expect(models.some((m: any) => m.modelId === "o3")).toBe(false); // old hardcoded value
      expect(models.some((m: any) => m.modelId === "o4-mini")).toBe(false); // old hardcoded value

      // Commands: available_commands_update notification
      const cmdsUpdate = await agent.waitFor(
        (m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "available_commands_update"
      );
      const commands = cmdsUpdate.params.update.availableCommands;
      expect(commands.length).toBeGreaterThan(0);

      // Modes: dynamically discovered
      const modes = sessionResp.result.modes.availableModes;
      expect(modes.length).toBeGreaterThan(0);
    } finally {
      agent.kill();
    }
  }, TIMEOUT);
});

describe("E2E: Claude Code dynamic discovery", () => {
  test("session/new returns dynamically discovered models and commands", async () => {
    const agent = startAgent("claude");

    try {
      // Initialize
      agent.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "test", version: "1.0" } } });
      const initResp = await agent.waitFor((m) => m.id === 1);
      expect(initResp.result.agentInfo.name).toContain("claude");

      // Session new
      agent.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
      const sessionResp = await agent.waitFor((m) => m.id === 2);

      expect(sessionResp.result.sessionId).toBeTruthy();

      // Models: dynamically discovered
      const models = sessionResp.result.models.availableModels;
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].modelId).toBeTruthy();
      expect(models[0].name).toBeTruthy();
      // Not the old hardcoded IDs
      expect(models.some((m: any) => m.modelId === "claude-sonnet-4-20250514")).toBe(false);

      // ConfigOptions
      // Commands: dynamically discovered
      const cmdsUpdate = await agent.waitFor(
        (m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "available_commands_update"
      );
      const commands = cmdsUpdate.params.update.availableCommands;
      expect(commands.length).toBeGreaterThan(5);
    } finally {
      agent.kill();
    }
  }, TIMEOUT);
});
