/**
 * E2E test helper — spawns adapter-acp as a subprocess and
 * communicates via ND-JSON over stdin/stdout (like a real ACP client).
 */
export interface AcpTestClient {
  send(msg: any): void;
  receive(timeoutMs?: number): Promise<any>;
  receiveAll(timeoutMs?: number): Promise<any[]>;
  close(): void;
}

export function spawnAdapter(agentName: string, cwd: string): AcpTestClient {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", agentName, "--cwd", cwd], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let buffer = "";
  const messageQueue: any[] = [];
  let waitingResolve: ((msg: any) => void) | null = null;

  // Background reader
  (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (waitingResolve) {
              const resolve = waitingResolve;
              waitingResolve = null;
              resolve(msg);
            } else {
              messageQueue.push(msg);
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

    receive(timeoutMs = 30_000): Promise<any> {
      if (messageQueue.length > 0) {
        return Promise.resolve(messageQueue.shift()!);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waitingResolve = null;
          reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
        }, timeoutMs);
        waitingResolve = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      });
    },

    async receiveAll(timeoutMs = 5_000): Promise<any[]> {
      const results: any[] = [...messageQueue];
      messageQueue.length = 0;
      try {
        while (true) {
          const msg = await this.receive(timeoutMs);
          results.push(msg);
        }
      } catch {
        // Timeout = done collecting
      }
      return results;
    },

    close() {
      try { proc.stdin.end(); } catch {}
      setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    },
  };
}

/** Send initialize and return the response */
export async function initializeClient(client: AcpTestClient): Promise<any> {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "e2e-test", version: "1.0.0" },
    },
  });
  return client.receive();
}

/** Send session/new and return the response (plus any notifications) */
export async function createSession(client: AcpTestClient, cwd: string): Promise<any> {
  client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd, mcpServers: [] },
  });

  const notifications: any[] = [];
  while (true) {
    const msg = await client.receive(60_000);
    if (msg.id === 2) {
      return { response: msg, notifications };
    }
    notifications.push(msg);
  }
}

/** Send a prompt and collect all updates until the response comes back */
export async function sendPrompt(
  client: AcpTestClient,
  sessionId: string,
  text: string,
  promptId = 3,
): Promise<{ response: any; updates: any[] }> {
  client.send({
    jsonrpc: "2.0",
    id: promptId,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text }],
    },
  });

  const updates: any[] = [];
  while (true) {
    const msg = await client.receive(120_000);
    if (msg.id === promptId) {
      return { response: msg, updates };
    }
    updates.push(msg);
  }
}
