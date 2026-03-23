import { buildConfigOptions, type ModelInfo, type ModeInfo } from "../parsers/types.ts";
import { log } from "../utils/logger.ts";

export interface AgentOptions {
  agentName: string;
  agentVersion: string;
  verbose: boolean;
  passEnv: string[];
  cwd?: string;
}

export interface AgentClient {
  sessionUpdate(params: { sessionId: string; update: any }): Promise<void>;
  requestPermission(params: {
    sessionId: string;
    toolCall: any;
    options: Array<{ kind: string; name: string; optionId: string }>;
  }): Promise<{ outcome: { outcome: string; optionId?: string } }>;
}

export async function detectAgentVersion(agentName: string): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(agentName, ["--version"]);
    const version = stdout.trim().split("\n")[0] || "unknown";
    log(`Detected agent version: ${version}`);
    return version;
  } catch (err: any) {
    if (err.stderr) {
      process.stderr.write(`Error: '${agentName}' not found or returned error.\n${err.stderr}\n`);
    } else {
      process.stderr.write(`Error: '${agentName}' command not found. Is it installed?\n`);
    }
    process.exit(1);
  }
}

export { buildConfigOptions, type ModelInfo, type ModeInfo };

export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private _ended = false;

  push(value: T) {
    if (this._ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  end() {
    this._ended = true;
    if (this.waiting) {
      this.waiting({ value: undefined as any, done: true });
      this.waiting = null;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false as const });
        }
        if (this._ended) {
          return Promise.resolve({ value: undefined as any, done: true as const });
        }
        return new Promise(resolve => { this.waiting = resolve; });
      },
    };
  }
}
