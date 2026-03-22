import type { TUIParser } from "./types.ts";

const registry: Record<string, () => TUIParser> = {};

export function registerParser(name: string, factory: () => TUIParser) {
  registry[name] = factory;
}

export function getParser(name: string): TUIParser {
  const factory = registry[name];
  if (!factory) {
    const available = Object.keys(registry).join(", ");
    throw new Error(`Unknown agent "${name}". Available: ${available}`);
  }
  return factory();
}

export function listParsers(): string[] {
  return Object.keys(registry);
}

// Only Codex uses the parser path now
import { CodexParser } from "./codex.ts";
registerParser("codex", () => new CodexParser());
