import { describe, test, expect } from "bun:test";
import { getToolKind } from "../../src/agents/tool-mapping.ts";

describe("getToolKind", () => {
  test("maps Bash to execute", () => expect(getToolKind("Bash")).toBe("execute"));
  test("maps Read to read", () => expect(getToolKind("Read")).toBe("read"));
  test("maps Write to edit", () => expect(getToolKind("Write")).toBe("edit"));
  test("maps Edit to edit", () => expect(getToolKind("Edit")).toBe("edit"));
  test("maps Glob to search", () => expect(getToolKind("Glob")).toBe("search"));
  test("maps Grep to search", () => expect(getToolKind("Grep")).toBe("search"));
  test("maps WebFetch to fetch", () => expect(getToolKind("WebFetch")).toBe("fetch"));
  test("maps WebSearch to fetch", () => expect(getToolKind("WebSearch")).toBe("fetch"));
  test("maps Agent to think", () => expect(getToolKind("Agent")).toBe("think"));
  test("maps Task to think", () => expect(getToolKind("Task")).toBe("think"));
  test("maps TodoWrite to think", () => expect(getToolKind("TodoWrite")).toBe("think"));
  test("maps ExitPlanMode to switch_mode", () => expect(getToolKind("ExitPlanMode")).toBe("switch_mode"));
  test("returns other for unknown tools", () => expect(getToolKind("SomeNewTool")).toBe("other"));
});
