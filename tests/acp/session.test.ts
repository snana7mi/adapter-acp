import { describe, test, expect } from "bun:test";
import { Session } from "../../src/acp/session.ts";
import type {
  TUIParser,
  ParsedEvent,
  AgentState,
  ProcessIO,
  DiscoveryResult,
} from "../../src/parsers/types.ts";

/** A mock ProcessIO that lets tests push data and inspect writes. */
function createMockIO() {
  let dataCallback: ((data: string) => void) | null = null;
  let closeCallback: ((code: number) => void) | null = null;
  const written: string[] = [];

  const io: ProcessIO = {
    write(data: string) {
      written.push(data);
    },
    onData(cb: (data: string) => void) {
      dataCallback = cb;
    },
    onClose(cb: (code: number) => void) {
      closeCallback = cb;
    },
  };

  return {
    io,
    written,
    pushData(data: string) {
      dataCallback?.(data);
    },
    pushClose(code: number) {
      closeCallback?.(code);
    },
  };
}

function createMockParser(overrides: Partial<TUIParser> = {}): TUIParser {
  let state: AgentState = "idle";
  return {
    name: "mock",
    command: "echo",
    spawnArgs(_cwd: string) {
      return { args: ["hello"] };
    },
    async discover(_io: ProcessIO): Promise<DiscoveryResult> {
      return {
        models: [{ modelId: "m1", name: "Model 1" }],
        commands: [{ name: "help", description: "Help" }],
        modes: [{ id: "code", name: "Code" }],
      };
    },
    handleOutput(data: string): ParsedEvent[] {
      if (data.includes("thinking")) {
        state = "thinking";
        return [{ type: "state_change", state: "thinking" }];
      }
      if (data.includes("done")) {
        state = "idle";
        return [{ type: "state_change", state: "idle" }];
      }
      if (data.includes("approve")) {
        state = "awaiting_approval";
        return [{ type: "approval_request", description: "test action" }];
      }
      return [{ type: "text", text: data }];
    },
    sendPrompt(io: ProcessIO, text: string) {
      io.write(text + "\n");
    },
    setModel(_io: ProcessIO, _modelId: string) {},
    setMode(_io: ProcessIO, _modeId: string) {},
    cancel(io: ProcessIO) {
      io.write("\x03");
    },
    respondToApproval(io: ProcessIO, approved: boolean) {
      io.write(approved ? "y\n" : "n\n");
    },
    currentState() {
      return state;
    },
    reset() {
      state = "idle";
    },
    ...overrides,
  };
}

/**
 * Helper: create a Session with a mock IO injected (bypassing Bun.spawn).
 * We do this by calling the constructor then patching internal state.
 */
function createTestSession(
  parserOverrides: Partial<TUIParser> = {},
) {
  const parser = createMockParser(parserOverrides);
  const session = new Session(parser, { cwd: "/tmp" });
  const mock = createMockIO();

  // Patch internals to inject mock IO without spawning a real process
  (session as any).io = mock.io;
  (session as any).proc = { kill: () => { (session as any)._killed = true; } };

  // Wire onData to session's handleOutput (simulating what start() does)
  mock.io.onData((data: string) => (session as any).handleOutput(data));

  return { session, mock, parser };
}

describe("Session", () => {
  test("generates incrementing toolCallIds", () => {
    const session = new Session(createMockParser(), { cwd: "/tmp" });
    expect(session.nextToolCallId()).toBe("tc_1");
    expect(session.nextToolCallId()).toBe("tc_2");
    expect(session.activeToolCallId).toBe("tc_2");
  });

  test("unique session ids", () => {
    const s1 = new Session(createMockParser(), { cwd: "/tmp" });
    const s2 = new Session(createMockParser(), { cwd: "/tmp" });
    expect(s1.id).not.toBe(s2.id);
  });

  test("discover delegates to parser and returns result", async () => {
    const { session } = createTestSession();
    const result = await session.discover();
    expect(result.models).toHaveLength(1);
    expect(result.models[0].modelId).toBe("m1");
    expect(result.commands).toHaveLength(1);
    expect(result.modes).toHaveLength(1);
  });

  test("prompt resolves on state_change idle", async () => {
    const { session, mock } = createTestSession();

    const events: ParsedEvent[] = [];
    session.onEvent((e) => events.push(e));

    const promptPromise = session.prompt("hello");

    // Verify prompt was sent
    expect(mock.written).toContain("hello\n");

    // Simulate agent output
    mock.pushData("thinking about it");
    mock.pushData("done");

    const stopReason = await promptPromise;
    expect(stopReason).toBe("end_turn");
    expect(events.some((e) => e.type === "state_change" && e.state === "thinking")).toBe(true);
    expect(events.some((e) => e.type === "state_change" && e.state === "idle")).toBe(true);
  });

  test("cancel delegates to parser", () => {
    const { session, mock } = createTestSession();

    session.cancel();
    expect(mock.written).toContain("\x03");
  });

  test("setModel delegates to parser", () => {
    let calledWith: string | null = null;
    const { session } = createTestSession({
      setModel(_io: ProcessIO, modelId: string) {
        calledWith = modelId;
      },
    });

    session.setModel("gpt-4");
    expect(calledWith).toBe("gpt-4");
  });

  test("destroy kills process", () => {
    const { session } = createTestSession();
    session.destroy();
    expect((session as any)._killed).toBe(true);
  });

  test("isPrompting returns true during prompt", async () => {
    const { session, mock } = createTestSession();

    expect(session.isPrompting()).toBe(false);

    const promptPromise = session.prompt("test");
    expect(session.isPrompting()).toBe(true);

    mock.pushData("done");
    await promptPromise;

    expect(session.isPrompting()).toBe(false);
  });

  test("pauseParsing buffers data, resumeParsing flushes", async () => {
    const { session, mock } = createTestSession();

    const events: ParsedEvent[] = [];
    session.onEvent((e) => events.push(e));

    const promptPromise = session.prompt("test");

    // Pause and push data — should be buffered, not processed
    session.pauseParsing();
    mock.pushData("thinking now");
    expect(events).toHaveLength(0);

    // Resume — buffered data should flush and produce events
    session.resumeParsing();
    expect(events.some((e) => e.type === "state_change" && e.state === "thinking")).toBe(true);

    // Now complete the prompt
    mock.pushData("done");
    const stopReason = await promptPromise;
    expect(stopReason).toBe("end_turn");
  });

  test("getIO returns null before start, ProcessIO after injection", () => {
    const parser = createMockParser();
    const session = new Session(parser, { cwd: "/tmp" });
    expect(session.getIO()).toBeNull();

    // After injecting IO
    const { session: s2 } = createTestSession();
    expect(s2.getIO()).not.toBeNull();
  });

  test("respondToApproval delegates to parser", () => {
    const { session, mock } = createTestSession();
    session.respondToApproval(true);
    expect(mock.written).toContain("y\n");

    session.respondToApproval(false);
    expect(mock.written).toContain("n\n");
  });
});
