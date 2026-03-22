import { describe, test, expect } from "bun:test";
import { parseCliArgs } from "../../src/acp/cli.ts";

describe("parseCliArgs", () => {
  test("parses agent name", () => {
    const args = parseCliArgs(["claude"]);
    expect(args.agentName).toBe("claude");
  });

  test("parses --verbose flag", () => {
    const args = parseCliArgs(["claude", "--verbose"]);
    expect(args.verbose).toBe(true);
  });

  test("parses --cwd option", () => {
    const args = parseCliArgs(["claude", "--cwd", "/workspace"]);
    expect(args.cwd).toBe("/workspace");
  });

  test("parses multiple --pass-env options", () => {
    const args = parseCliArgs(["claude", "--pass-env", "API_KEY", "--pass-env", "TOKEN"]);
    expect(args.passEnv).toEqual(["API_KEY", "TOKEN"]);
  });

  test("parses --idle-timeout option", () => {
    const args = parseCliArgs(["claude", "--idle-timeout", "30000"]);
    expect(args.idleTimeout).toBe(30000);
  });

  test("returns undefined agentName when missing", () => {
    const args = parseCliArgs(["--verbose"]);
    expect(args.agentName).toBeUndefined();
  });

  test("defaults verbose to false", () => {
    const args = parseCliArgs(["claude"]);
    expect(args.verbose).toBe(false);
  });
});
