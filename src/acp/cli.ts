export interface CliArgs {
  agentName?: string;
  verbose: boolean;
  cwd?: string;
  passEnv: string[];
  idleTimeout?: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    verbose: false,
    passEnv: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--verbose") {
      result.verbose = true;
    } else if (arg === "--cwd" && argv[i + 1]) {
      result.cwd = argv[++i];
    } else if (arg === "--pass-env" && argv[i + 1]) {
      result.passEnv.push(argv[++i]!);
    } else if (arg === "--idle-timeout" && argv[i + 1]) {
      result.idleTimeout = parseInt(argv[++i]!, 10);
    } else if (!arg.startsWith("-") && !result.agentName) {
      result.agentName = arg;
    }
  }

  return result;
}
