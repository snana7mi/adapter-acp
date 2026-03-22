#!/usr/bin/env bun
/**
 * Manual E2E test script — tests the full adapter pipeline against real CLI agents.
 * Run: bun run tests/e2e/manual-test.ts claude
 * Run: bun run tests/e2e/manual-test.ts codex
 */

import { spawnAdapter, initializeClient, createSession, sendPrompt, type AcpTestClient } from "./helpers.ts";

const agent = process.argv[2];
if (!agent) {
  console.error("Usage: bun run tests/e2e/manual-test.ts <claude|codex>");
  process.exit(1);
}

let client: AcpTestClient | null = null;
let passed = 0;
let failed = 0;

function ok(name: string) {
  passed++;
  console.log(`  ✅ ${name}`);
}

function fail(name: string, err: any) {
  failed++;
  console.error(`  ❌ ${name}: ${err}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

try {
  console.log(`\n🔧 Testing adapter-acp with: ${agent}\n`);

  // --- Test 1: Initialize ---
  console.log("📋 Phase 1: Initialize");
  client = spawnAdapter(agent, "/tmp");
  const initResp = await initializeClient(client);

  assert(initResp.result?.protocolVersion === 1, `protocolVersion should be 1, got ${initResp.result?.protocolVersion}`);
  assert(initResp.result?.agentInfo?.name?.includes(agent), `agentInfo.name should contain '${agent}'`);
  assert(initResp.result?.agentCapabilities !== undefined, "agentCapabilities should exist");
  ok(`initialize: protocolVersion=1, agent=${initResp.result.agentInfo.name}`);

  // --- Test 2: Session/New ---
  console.log("\n📋 Phase 2: Session/New + Discovery");
  const { response: sessionResp, notifications } = await createSession(client, "/tmp");

  assert(sessionResp.result?.sessionId, "sessionId should be defined");
  ok(`sessionId: ${sessionResp.result.sessionId}`);

  // Models
  const models = sessionResp.result.models?.availableModels ?? [];
  assert(models.length > 0, "should have at least 1 model");
  ok(`models discovered: ${models.length} (${models.map((m: any) => m.modelId).join(", ")})`);

  // Modes
  const modes = sessionResp.result.modes?.availableModes ?? [];
  assert(modes.length > 0, "should have at least 1 mode");
  ok(`modes discovered: ${modes.length} (${modes.map((m: any) => m.id || m.name).join(", ")})`);

  // Available commands (slash commands)
  const cmdsNotif = notifications.find(
    (n: any) => n.params?.update?.sessionUpdate === "available_commands_update"
  );
  if (cmdsNotif) {
    const commands = cmdsNotif.params.update.availableCommands ?? [];
    ok(`slash commands discovered: ${commands.length}`);
    for (const cmd of commands) {
      console.log(`    📎 ${cmd.name}: ${cmd.description ?? "(no description)"}`);
    }
  } else {
    fail("slash commands", "no available_commands_update notification received");
  }

  // Config options
  const configOptions = sessionResp.result.configOptions ?? [];
  if (configOptions.length > 0) {
    ok(`config options: ${configOptions.length}`);
    for (const opt of configOptions) {
      console.log(`    ⚙️  ${opt.id}: ${opt.currentValue} (${opt.options?.length ?? 0} options)`);
    }
  } else {
    console.log("  ℹ️  no configOptions returned (OK if empty)");
  }

  // --- Test 3: Simple prompt ---
  console.log("\n📋 Phase 3: Prompt");
  const sessionId = sessionResp.result.sessionId;

  const { response: promptResp, updates } = await sendPrompt(
    client,
    sessionId,
    "What is 2+2? Reply with just the number.",
  );

  assert(promptResp.result?.stopReason === "end_turn", `stopReason should be 'end_turn', got '${promptResp.result?.stopReason}'`);
  ok(`prompt completed: stopReason=${promptResp.result.stopReason}`);

  // Check streaming updates
  const messageChunks = updates.filter(
    (u: any) => u.params?.update?.sessionUpdate === "agent_message_chunk"
  );
  const thoughtChunks = updates.filter(
    (u: any) => u.params?.update?.sessionUpdate === "agent_thought_chunk"
  );
  const toolCalls = updates.filter(
    (u: any) => u.params?.update?.sessionUpdate === "tool_call"
  );

  ok(`received ${messageChunks.length} message chunks, ${thoughtChunks.length} thought chunks, ${toolCalls.length} tool calls`);

  // Extract full response text
  const fullText = messageChunks
    .map((u: any) => u.params?.update?.content?.text ?? "")
    .join("");
  console.log(`    💬 Response: "${fullText.trim().slice(0, 200)}${fullText.length > 200 ? "..." : ""}"`);

  // --- Test 4: Cancel ---
  console.log("\n📋 Phase 4: Cancel");
  client.send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
  await Bun.sleep(500);
  ok("cancel sent without crash");

  // --- Test 5: Slash command prompt ---
  console.log("\n📋 Phase 5: Slash command via prompt");
  // Test /help or similar built-in slash command
  const slashCmd = agent === "claude" ? "/help" : "/help";

  const { response: slashResp, updates: slashUpdates } = await sendPrompt(
    client,
    sessionId,
    slashCmd,
    4,
  );

  if (slashResp.result) {
    ok(`slash command '${slashCmd}' completed: stopReason=${slashResp.result.stopReason}`);
    const slashMsgs = slashUpdates.filter(
      (u: any) => u.params?.update?.sessionUpdate === "agent_message_chunk"
    );
    const slashText = slashMsgs
      .map((u: any) => u.params?.update?.content?.text ?? "")
      .join("");
    console.log(`    💬 Response: "${slashText.trim().slice(0, 300)}${slashText.length > 300 ? "..." : ""}"`);
  } else if (slashResp.error) {
    fail(`slash command '${slashCmd}'`, slashResp.error.message);
  }

  // --- Test 6: Set model ---
  console.log("\n📋 Phase 6: Set model");
  if (models.length > 1) {
    const targetModel = models[1].modelId;
    client.send({
      jsonrpc: "2.0",
      id: 10,
      method: "session/set_config_option",
      params: { sessionId, configId: "model", value: targetModel },
    });

    // Collect response and any config_option_update notifications
    const allMsgs: any[] = [];
    while (true) {
      const msg = await client.receive(10_000);
      allMsgs.push(msg);
      if (msg.id === 10) break;
    }

    const setModelResp = allMsgs.find((m: any) => m.id === 10);
    if (setModelResp?.result) {
      ok(`set model to '${targetModel}'`);
      const updatedOpt = setModelResp.result.configOptions?.find((o: any) => o.id === "model");
      if (updatedOpt) {
        console.log(`    ⚙️  model config now: ${updatedOpt.currentValue}`);
      }
    } else {
      fail("set model", setModelResp?.error?.message ?? "no response");
    }
  } else {
    console.log("  ℹ️  only 1 model available, skipping set_model test");
  }

  // --- Test 7: Set mode ---
  console.log("\n📋 Phase 7: Set mode");
  if (modes.length > 1) {
    const targetMode = modes[1].id || modes[1].name;
    client.send({
      jsonrpc: "2.0",
      id: 11,
      method: "session/set_config_option",
      params: { sessionId, configId: "mode", value: targetMode },
    });

    const allMsgs: any[] = [];
    while (true) {
      const msg = await client.receive(10_000);
      allMsgs.push(msg);
      if (msg.id === 11) break;
    }

    const setModeResp = allMsgs.find((m: any) => m.id === 11);
    if (setModeResp?.result) {
      ok(`set mode to '${targetMode}'`);
    } else {
      fail("set mode", setModeResp?.error?.message ?? "no response");
    }
  } else {
    console.log("  ℹ️  only 1 mode available, skipping set_mode test");
  }

} catch (err: any) {
  fail("FATAL", err.message);
  console.error(err.stack);
} finally {
  if (client) client.close();
  await Bun.sleep(1000);

  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}
