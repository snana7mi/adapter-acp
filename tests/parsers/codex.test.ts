import { describe, test, expect, beforeEach } from "bun:test";
import { CodexParser } from "../../src/parsers/codex.ts";
import type { ParsedEvent, ProcessIO } from "../../src/parsers/types.ts";
import { readFileSync } from "fs";
import { join } from "path";

const FIXTURES = join(import.meta.dir, "../fixtures/codex");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

/** Create a mock ProcessIO that records writes and lets us push data */
function mockIO(): ProcessIO & { written: string[]; pushData: (data: string) => void } {
  let dataCallback: ((data: string) => void) | null = null;
  let closeCallback: ((code: number) => void) | null = null;
  const written: string[] = [];

  return {
    written,
    write(data: string) {
      written.push(data);
      // Auto-resolve pending RPCs by parsing the request and sending a response
    },
    onData(cb: (data: string) => void) {
      dataCallback = cb;
    },
    onClose(cb: (code: number) => void) {
      closeCallback = cb;
    },
    pushData(data: string) {
      dataCallback?.(data);
    },
  };
}

/**
 * Create a mock IO that auto-responds to RPC requests with fixture data.
 * responseMap: method -> result object
 */
function autoRespondIO(responseMap: Record<string, any>): ProcessIO & { written: string[]; pushData: (data: string) => void } {
  let dataCallback: ((data: string) => void) | null = null;
  const written: string[] = [];

  return {
    written,
    write(data: string) {
      written.push(data);
      // Parse the request and auto-respond
      try {
        const req = JSON.parse(data.trim());
        if (req.id != null && req.method) {
          const result = responseMap[req.method] ?? {};
          const response = JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n";
          // Defer to next microtask so the pending map is populated first
          queueMicrotask(() => dataCallback?.(response));
        }
      } catch {
        // ignore
      }
    },
    onData(cb: (data: string) => void) {
      dataCallback = cb;
    },
    onClose(_cb: (code: number) => void) {},
    pushData(data: string) {
      dataCallback?.(data);
    },
  };
}

describe("CodexParser", () => {
  let parser: CodexParser;

  beforeEach(() => {
    parser = new CodexParser();
  });

  test("starts in idle state", () => {
    expect(parser.currentState()).toBe("idle");
  });

  describe("spawnArgs", () => {
    test("returns app-server arg", () => {
      const result = parser.spawnArgs("/tmp");
      expect(result.args).toEqual(["app-server"]);
    });
  });

  describe("discover", () => {
    test("sends initialize, model/list, skills/list, collaborationMode/list and returns DiscoveryResult", async () => {
      const modelData = JSON.parse(loadFixture("model-list-response.json"));
      const skillsData = JSON.parse(loadFixture("skills-list-response.json"));
      const modesData = JSON.parse(loadFixture("modes-list-response.json"));

      const responseMap: Record<string, any> = {
        "initialize": { serverInfo: { name: "codex-app-server", version: "0.116.0" } },
        "model/list": modelData,
        "skills/list": skillsData,
        "collaborationMode/list": modesData,
      };

      const io = autoRespondIO(responseMap);

      // discover() registers its own onData, and the auto-respond IO
      // feeds responses through that handler. But we also need to
      // feed responses through handleOutput to resolve pending RPCs.
      // The auto-respond IO sends data to the onData callback, but
      // discover() has its own. We need the parser.pending map to be
      // resolved. Let's wire it up properly.

      // Actually, discover() uses sendRpc which populates parser.pending,
      // and the auto-respond IO sends the response JSON to the onData callback
      // that discover() registered. But discover()'s onData handler just
      // collects lines — it doesn't resolve pending RPCs!
      //
      // We need the IO to also feed data through parser.handleOutput.
      // Let's create a smarter IO that does both.

      let discoverDataCb: ((data: string) => void) | null = null;
      const written: string[] = [];

      const smartIO: ProcessIO = {
        write(data: string) {
          written.push(data);
          try {
            const req = JSON.parse(data.trim());
            if (req.id != null && req.method) {
              const result = responseMap[req.method] ?? {};
              const response = JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n";
              queueMicrotask(() => {
                // Feed to both discover's onData handler AND parser.handleOutput
                discoverDataCb?.(response);
                parser.handleOutput(response);
              });
            }
          } catch {
            // ignore
          }
        },
        onData(cb: (data: string) => void) {
          discoverDataCb = cb;
        },
        onClose(_cb: (code: number) => void) {},
      };

      const result = await parser.discover(smartIO);

      // Verify RPC methods sent
      const methods = written.map((w) => JSON.parse(w.trim()).method);
      expect(methods).toContain("initialize");
      expect(methods).toContain("model/list");
      expect(methods).toContain("skills/list");
      expect(methods).toContain("collaborationMode/list");

      // Verify models
      expect(result.models.length).toBe(7);
      expect(result.models[0].modelId).toBe("gpt-5.4");
      expect(result.models[0].name).toBe("gpt-5.4");
      expect(result.models[0].description).toBe("Latest frontier agentic coding model.");

      // Verify commands (skills)
      expect(result.commands.length).toBeGreaterThan(0);
      expect(result.commands.some((c) => c.name === "gh-address-comments")).toBe(true);

      // Verify modes
      expect(result.modes.length).toBe(2);
      expect(result.modes[0].id).toBe("plan");
      expect(result.modes[0].name).toBe("Plan");
      expect(result.modes[1].id).toBe("default");
      expect(result.modes[1].name).toBe("Default");
    });
  });

  describe("handleOutput", () => {
    test("parses turn-events.jsonl fixture into correct events", () => {
      const fixture = loadFixture("turn-events.jsonl");
      const allEvents: ParsedEvent[] = [];

      // Feed the entire fixture as if it arrived in one chunk
      // Add trailing newline since fixture file doesn't end with one
      const events = parser.handleOutput(fixture + "\n");
      allEvents.push(...events);

      // Should have turn/started -> thinking state change
      expect(allEvents.some((e) => e.type === "state_change" && e.state === "thinking")).toBe(true);

      // Should have agentMessage/delta -> text events
      const textEvents = allEvents.filter((e) => e.type === "text");
      expect(textEvents.length).toBe(2);
      expect(textEvents[0].type === "text" && textEvents[0].text).toBe("hello");
      expect(textEvents[1].type === "text" && textEvents[1].text).toBe(" world");

      // Should have responding state
      expect(allEvents.some((e) => e.type === "state_change" && e.state === "responding")).toBe(true);

      // Should end with idle
      expect(allEvents.some((e) => e.type === "state_change" && e.state === "idle")).toBe(true);
      expect(parser.currentState()).toBe("idle");
    });

    test("handles item/started with reasoning type", () => {
      const line = JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "reasoning", id: "rs_123", summary: [], content: [] },
          threadId: "t1",
          turnId: "turn1",
        },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events).toContainEqual({ type: "state_change", state: "thinking" });
      expect(parser.currentState()).toBe("thinking");
    });

    test("handles item/started with agentMessage type", () => {
      const line = JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "agentMessage", id: "msg_123", text: "", phase: "final_answer" },
          threadId: "t1",
          turnId: "turn1",
        },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events).toContainEqual({ type: "state_change", state: "responding" });
    });

    test("handles item/started with commandExecution type", () => {
      const line = JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "commandExecution", id: "cmd_123", command: "ls /tmp" },
          threadId: "t1",
          turnId: "turn1",
        },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events.some((e) => e.type === "tool_call" && e.name === "ls /tmp")).toBe(true);
      expect(parser.currentState()).toBe("tool_calling");
    });

    test("handles item/started with fileChange type", () => {
      const line = JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "fileChange", id: "fc_123" },
          threadId: "t1",
          turnId: "turn1",
        },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events.some((e) => e.type === "tool_call" && e.name === "fileChange")).toBe(true);
    });

    test("handles item/completed with commandExecution type", () => {
      const line = JSON.stringify({
        method: "item/completed",
        params: {
          item: { type: "commandExecution", id: "cmd_123", command: "ls /tmp", aggregatedOutput: "file1\nfile2", text: "exit code 0" },
          threadId: "t1",
          turnId: "turn1",
        },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events.some((e) => e.type === "tool_result" && e.name === "ls /tmp" && e.result === "file1\nfile2")).toBe(true);
    });

    test("handles item/agentMessage/delta", () => {
      const line = JSON.stringify({
        method: "item/agentMessage/delta",
        params: { delta: "hello", threadId: "t1", turnId: "turn1", itemId: "msg_1" },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events.some((e) => e.type === "text" && e.text === "hello")).toBe(true);
      expect(events.some((e) => e.type === "state_change" && e.state === "responding")).toBe(true);
    });

    test("handles turn/started -> thinking when idle", () => {
      const line = JSON.stringify({
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "turn1", items: [], status: "inProgress" } },
      }) + "\n";

      const events = parser.handleOutput(line);
      expect(events).toContainEqual({ type: "state_change", state: "thinking" });
      expect(parser.currentState()).toBe("thinking");
    });

    test("turn/started does not emit thinking if not idle", () => {
      // First put in responding state
      parser.handleOutput(JSON.stringify({
        method: "item/agentMessage/delta",
        params: { delta: "x", threadId: "t1", turnId: "turn1", itemId: "msg_1" },
      }) + "\n");
      expect(parser.currentState()).toBe("responding");

      const events = parser.handleOutput(JSON.stringify({
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "turn2" } },
      }) + "\n");

      // Should NOT emit thinking since we're not idle
      expect(events.some((e) => e.type === "state_change" && e.state === "thinking")).toBe(false);
    });

    test("handles turn/completed -> idle", () => {
      // Put in thinking state first
      parser.handleOutput(JSON.stringify({
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "turn1" } },
      }) + "\n");

      const events = parser.handleOutput(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn1", status: "completed" } },
      }) + "\n");

      expect(events).toContainEqual({ type: "state_change", state: "idle" });
      expect(parser.currentState()).toBe("idle");
    });

    test("resolves pending RPC responses", () => {
      let resolved = false;
      parser.pending.set(42, {
        resolve: () => { resolved = true; },
        reject: () => {},
      });

      parser.handleOutput(JSON.stringify({ jsonrpc: "2.0", id: 42, result: { ok: true } }) + "\n");
      expect(resolved).toBe(true);
      expect(parser.pending.has(42)).toBe(false);
    });

    test("rejects pending RPC errors", () => {
      let rejected = false;
      parser.pending.set(99, {
        resolve: () => {},
        reject: () => { rejected = true; },
      });

      parser.handleOutput(JSON.stringify({ jsonrpc: "2.0", id: 99, error: { message: "fail" } }) + "\n");
      expect(rejected).toBe(true);
    });

    test("handles partial lines (buffering)", () => {
      // Send partial JSON
      const events1 = parser.handleOutput('{"method":"turn/compl');
      expect(events1.length).toBe(0);

      // Complete the line
      const events2 = parser.handleOutput('eted","params":{"threadId":"t1","turn":{"id":"t1","status":"completed"}}}\n');
      expect(events2).toContainEqual({ type: "state_change", state: "idle" });
    });

    test("invalid JSON produces raw event", () => {
      const events = parser.handleOutput("not json\n");
      expect(events).toEqual([{ type: "raw", text: "not json" }]);
    });
  });

  describe("sendPrompt", () => {
    test("first call sends thread/start, second sends only turn/start", () => {
      const io = mockIO();

      parser.sendPrompt(io, "hello");

      // First call should send thread/start
      expect(io.written.length).toBe(1);
      const threadReq = JSON.parse(io.written[0].trim());
      expect(threadReq.method).toBe("thread/start");

      // Simulate thread/start response which triggers turn/start
      const threadResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: threadReq.id,
        result: { thread: { id: "thread-abc-123" } },
      }) + "\n";
      parser.handleOutput(threadResponse);

      // Should now have sent turn/start
      expect(io.written.length).toBe(2);
      const turnReq = JSON.parse(io.written[1].trim());
      expect(turnReq.method).toBe("turn/start");
      expect(turnReq.params.threadId).toBe("thread-abc-123");
      expect(turnReq.params.input).toEqual([{ type: "text", text: "hello" }]);

      // Second call should only send turn/start (no thread/start)
      parser.sendPrompt(io, "world");
      expect(io.written.length).toBe(3);
      const turnReq2 = JSON.parse(io.written[2].trim());
      expect(turnReq2.method).toBe("turn/start");
      expect(turnReq2.params.threadId).toBe("thread-abc-123");
      expect(turnReq2.params.input).toEqual([{ type: "text", text: "world" }]);
    });

    test("includes pending model in turn/start", () => {
      const io = mockIO();

      parser.setModel(io, "gpt-5.4-mini");
      parser.sendPrompt(io, "hello");

      // Resolve thread/start
      const threadReq = JSON.parse(io.written[0].trim());
      parser.handleOutput(JSON.stringify({
        jsonrpc: "2.0",
        id: threadReq.id,
        result: { thread: { id: "t1" } },
      }) + "\n");

      const turnReq = JSON.parse(io.written[1].trim());
      expect(turnReq.params.model).toBe("gpt-5.4-mini");

      // Pending model should be consumed
      parser.sendPrompt(io, "again");
      const turnReq2 = JSON.parse(io.written[2].trim());
      expect(turnReq2.params.model).toBeUndefined();
    });
  });

  describe("cancel", () => {
    test("sends turn/interrupt with threadId", () => {
      const io = mockIO();

      // Set up threadId via sendPrompt
      parser.sendPrompt(io, "hello");
      const threadReq = JSON.parse(io.written[0].trim());
      parser.handleOutput(JSON.stringify({
        jsonrpc: "2.0",
        id: threadReq.id,
        result: { thread: { id: "thread-xyz" } },
      }) + "\n");

      parser.cancel(io);

      const cancelReq = JSON.parse(io.written[io.written.length - 1].trim());
      expect(cancelReq.method).toBe("turn/interrupt");
      expect(cancelReq.params.threadId).toBe("thread-xyz");
    });

    test("does nothing without threadId", () => {
      const io = mockIO();
      parser.cancel(io);
      expect(io.written.length).toBe(0);
    });
  });

  describe("setModel", () => {
    test("stores pending model for next turn/start", () => {
      const io = mockIO();
      parser.setModel(io, "gpt-5.4");
      // No writes — just stores internally
      expect(io.written.length).toBe(0);
    });
  });

  describe("reset", () => {
    test("resets all internal state", () => {
      const io = mockIO();
      // Set up some state
      parser.handleOutput(JSON.stringify({
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "turn1" } },
      }) + "\n");
      expect(parser.currentState()).toBe("thinking");

      parser.reset();
      expect(parser.currentState()).toBe("idle");
      expect(parser.pending.size).toBe(0);
    });
  });
});
