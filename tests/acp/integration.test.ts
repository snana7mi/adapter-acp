import { describe, test, expect } from "bun:test";

const hasClaude = !!Bun.which("claude");

async function sendAndReceive(proc: any, request: any): Promise<any> {
  proc.stdin.write(JSON.stringify(request) + "\n");
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  reader.releaseLock();
  return JSON.parse(text.trim().split("\n")[0]!);
}

describe("E2E: initialize via SDK", () => {
  (hasClaude ? test : test.skip)("returns valid initialize response", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "claude"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const response = await sendAndReceive(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result.protocolVersion).toBe(1);
      expect(response.result.agentInfo.name).toContain("claude");
    } finally {
      proc.kill();
    }
  });
});
