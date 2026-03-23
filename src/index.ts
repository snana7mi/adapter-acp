#!/usr/bin/env node

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { ClaudeAgent } from "./agents/claude-agent.ts";
import { CodexAgent } from "./agents/codex-agent.ts";
import { parseCliArgs } from "./acp/cli.ts";
import { detectAgentVersion, resolveExecutablePath } from "./agents/shared.ts";
import { listParsers } from "./parsers/registry.ts";
import { setVerbose, log } from "./utils/logger.ts";

import "./parsers/registry.ts";

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  setVerbose(args.verbose);

  if (!args.agentName) {
    const available = ["claude", ...listParsers()];
    process.stderr.write(`Usage: adapter-acp <agent> [options]\n`);
    process.stderr.write(`Available agents: ${[...new Set(available)].join(", ")}\n`);
    process.stderr.write(`Options:\n`);
    process.stderr.write(`  --cwd <path>          Default working directory\n`);
    process.stderr.write(`  --verbose             Enable debug logging\n`);
    process.stderr.write(`  --pass-env <key>      Allow specific env var (can repeat)\n`);
    process.exit(1);
  }

  const agentVersion = await detectAgentVersion(args.agentName);
  const executablePath = await resolveExecutablePath(args.agentName);
  log(`adapter-acp started for agent: ${args.agentName}`);

  const stdoutWritable = new WritableStream<Uint8Array>({
    write(chunk) { process.stdout.write(chunk); },
  });
  const stdinReadable = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (err) => controller.error(err));
      process.stdin.resume();
    },
  });
  const stream = ndJsonStream(stdoutWritable, stdinReadable);

  let agent: any = null;

  const connection = new AgentSideConnection(
    (conn) => {
      const agentOptions = {
        agentName: args.agentName!,
        agentVersion,
        verbose: args.verbose,
        passEnv: args.passEnv,
        cwd: args.cwd,
      };

      if (args.agentName === "claude") {
        const claude = new ClaudeAgent(conn as any, agentOptions);
        claude.setExecutablePath(executablePath);
        agent = claude;
      } else {
        agent = new CodexAgent(conn as any, agentOptions);
      }
      return agent as any;
    },
    stream,
  );

  connection.closed.then(() => {
    log("Connection closed, shutting down");
    if (agent) agent.destroy();
    setTimeout(() => process.exit(0), 3500);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
