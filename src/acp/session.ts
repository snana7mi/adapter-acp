import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import type {
  TUIParser,
  ParsedEvent,
  ProcessIO,
  DiscoveryResult,
} from "../parsers/types.ts";
import { log, warn } from "../utils/logger.ts";

export interface SessionOptions {
  cwd: string;
  passEnv?: string[];
}

export class Session {
  readonly id: string;
  readonly parser: TUIParser;
  private proc: ChildProcess | null = null;
  private io: ProcessIO | null = null;
  private options: SessionOptions;
  private eventHandler: ((event: ParsedEvent) => void) | null = null;
  private promptResolve: ((stopReason: string) => void) | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private _toolCallCounter = 0;
  private _activeToolCallId: string | null = null;
  private _paused = false;
  private _pauseBuffer: string[] = [];

  constructor(parser: TUIParser, options: SessionOptions) {
    this.id = randomUUID();
    this.parser = parser;
    this.options = options;
  }

  get activeToolCallId(): string | null {
    return this._activeToolCallId;
  }

  isPrompting(): boolean {
    return this.promptResolve !== null;
  }

  pauseParsing() {
    this._paused = true;
  }

  resumeParsing() {
    this._paused = false;
    for (const chunk of this._pauseBuffer) {
      this.handleOutput(chunk);
    }
    this._pauseBuffer = [];
  }

  nextToolCallId(): string {
    this._toolCallCounter++;
    this._activeToolCallId = `tc_${this._toolCallCounter}`;
    return this._activeToolCallId;
  }

  onEvent(handler: (event: ParsedEvent) => void) {
    this.eventHandler = handler;
  }

  getIO(): ProcessIO | null {
    return this.io;
  }

  async start(): Promise<void> {
    const { cwd } = this.options;
    const spawnInfo = this.parser.spawnArgs(cwd);

    this.proc = spawn(this.parser.command, spawnInfo.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnInfo.env ? { ...process.env, ...spawnInfo.env } : undefined,
    });

    // Build ProcessIO wrapper
    let dataCallback: ((data: string) => void) | null = null;
    let closeCallback: ((code: number) => void) | null = null;

    const proc = this.proc;
    this.io = {
      write(data: string) {
        proc.stdin!.write(data);
      },
      onData(cb: (data: string) => void) {
        dataCallback = cb;
      },
      onClose(cb: (code: number) => void) {
        closeCallback = cb;
      },
    };

    // Read stdout
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (dataCallback) dataCallback(chunk.toString());
    });

    // Handle process exit
    proc.on("close", (code: number | null) => {
      warn(`Agent process exited with code ${code}`);
      if (closeCallback) closeCallback(code ?? 1);
      this.resolvePrompt("end_turn");
    });
  }

  async discover(): Promise<DiscoveryResult> {
    if (!this.io) throw new Error("Session not started");
    const result = await this.parser.discover(this.io);

    // After discovery, re-register onData to route to handleOutput
    this.io.onData((data: string) => this.handleOutput(data));

    return result;
  }

  async prompt(text: string): Promise<string> {
    if (!this.io) throw new Error("Session not started");

    this.parser.reset();
    this._toolCallCounter = 0;
    this._activeToolCallId = null;

    return new Promise<string>((resolve) => {
      this.promptResolve = resolve;

      this.hardTimer = setTimeout(() => {
        this.resolvePrompt("end_turn");
      }, 300_000);

      this.parser.sendPrompt(this.io!, text);
    });
  }

  cancel() {
    if (!this.io) return;
    this.parser.cancel(this.io);
    setTimeout(() => {
      this.resolvePrompt("cancelled");
    }, 5000);
  }

  setModel(modelId: string) {
    if (!this.io) return;
    this.parser.setModel(this.io, modelId);
  }

  setMode(modeId: string) {
    if (!this.io) return;
    this.parser.setMode(this.io, modeId);
  }

  respondToApproval(approved: boolean) {
    if (!this.io) return;
    this.parser.respondToApproval(this.io, approved);
  }

  destroy() {
    this.clearTimers();
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // Already dead
      }
    }
  }

  private handleOutput(data: string) {
    if (this._paused) {
      this._pauseBuffer.push(data);
      return;
    }

    const events = this.parser.handleOutput(data);
    for (const event of events) {
      this.eventHandler?.(event);

      if (event.type === "state_change" && event.state === "idle") {
        this.resolvePrompt("end_turn");
        return;
      }
    }
  }

  private resolvePrompt(stopReason: string) {
    this.clearTimers();
    if (this.promptResolve) {
      const resolve = this.promptResolve;
      this.promptResolve = null;
      resolve(stopReason);
    }
  }

  private clearTimers() {
    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
  }
}
