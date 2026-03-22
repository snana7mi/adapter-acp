import { describe, test, expect, afterEach } from "bun:test";
import {
  spawnAdapter,
  initializeClient,
  createSession,
  sendPrompt,
  type AcpTestClient,
} from "./helpers.ts";

// Test both agents if available
const agents = ["claude", "codex"].filter((a) => !!Bun.which(a));

let client: AcpTestClient | null = null;

afterEach(() => {
  if (client) {
    client.close();
    client = null;
  }
});

for (const agent of agents) {
  describe(`E2E: ${agent}`, () => {

    test("initialize returns valid response", async () => {
      client = spawnAdapter(agent, "/tmp");
      const response = await initializeClient(client);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result.protocolVersion).toBe(1);
      expect(response.result.agentInfo.name).toContain(agent);
      expect(response.result.agentCapabilities).toBeDefined();
    });

    test("initialize → session/new returns session with models and modes", async () => {
      client = spawnAdapter(agent, "/tmp");
      await initializeClient(client);

      const { response, notifications } = await createSession(client, "/tmp");

      expect(response.result.sessionId).toBeDefined();
      expect(response.result.models.availableModels.length).toBeGreaterThan(0);
      expect(response.result.modes.availableModes.length).toBeGreaterThan(0);

      const cmdsNotif = notifications.find(
        (n: any) => n.params?.update?.sessionUpdate === "available_commands_update"
      );
      expect(cmdsNotif).toBeDefined();
    });

    test("full flow: initialize → session/new → prompt → response", async () => {
      client = spawnAdapter(agent, "/tmp");
      await initializeClient(client);
      const { response: sessionResp } = await createSession(client, "/tmp");
      const sessionId = sessionResp.result.sessionId;

      const { response, updates } = await sendPrompt(
        client,
        sessionId,
        "Reply with exactly: hello e2e",
      );

      expect(response.result.stopReason).toBe("end_turn");

      const messageChunks = updates.filter(
        (u: any) => u.params?.update?.sessionUpdate === "agent_message_chunk"
      );
      expect(messageChunks.length).toBeGreaterThan(0);
    });

    test("session/cancel does not crash", async () => {
      client = spawnAdapter(agent, "/tmp");
      await initializeClient(client);
      const { response: sessionResp } = await createSession(client, "/tmp");
      const sessionId = sessionResp.result.sessionId;

      client.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });

      await Bun.sleep(1000);
    });

  });
}

if (agents.length === 0) {
  test.skip("no CLI agents (claude/codex) found — skipping E2E", () => {});
}
