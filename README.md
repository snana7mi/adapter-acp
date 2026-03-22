# adapter-acp

[中文](README_CN.md)

Universal ACP (Agent Client Protocol) adapter that bridges native CLI coding agents into standard ACP agents.

## Why

Mainstream AI coding agents like Claude Code and Codex do not natively support the ACP protocol. **adapter-acp** bridges this gap, so any ACP-compatible client (such as Zed) can use them as coding agents.

Uses the user's **existing CLI installation and subscription account** — no API keys needed.

## Supported Agents

| Agent | Integration | Features |
|---|---|---|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` (direct SDK) | Structured tool calls with proper kind classification, session resume/list/fork, token usage + cost tracking, MCP server propagation, plan mode |
| **Codex** | `codex app-server` JSON-RPC (PTY) | Token usage tracking, tool kind classification, web search events, commentary/reasoning phases |

All models, commands, and modes are **dynamically discovered** at session creation.

## Architecture

```
ACP Client (stdin/stdout, JSON-RPC 2.0 over ND-JSON)
    │
    ▼
┌──────────────────────────────────────┐
│           adapter-acp                │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  @agentclientprotocol/sdk     │  │
│  │  (AgentSideConnection)        │  │
│  └──────────┬─────────────────────┘  │
│             │                        │
│     ┌───────┴────────┐               │
│     ▼                ▼               │
│  ClaudeAgent      CodexAgent         │
│  (SDK direct)     (PTY parser)       │
│     │                │               │
│     ▼                ▼               │
│  claude-agent-sdk  Session+Parser    │
│     │                │               │
└─────┼────────────────┼───────────────┘
      ▼                ▼
  Claude Code        Codex
  (subscription)     (subscription)
```

## Quick Start

### Install from npm

```bash
npx adapter-acp claude
npx adapter-acp codex
```

### From source

```bash
git clone https://github.com/snana7mi/adapter-acp.git
cd adapter-acp
bun install
bun run src/index.ts claude
```

### Options

```bash
adapter-acp <agent> [options]

  --cwd <path>       Working directory
  --verbose          Enable debug logging (to stderr)
  --pass-env <key>   Pass environment variable to agent (repeatable)
```

### Run Tests

```bash
bun test
```

## ACP Protocol Support

| Method | Description |
|---|---|
| `initialize` | Handshake, returns agent capabilities |
| `session/new` | Create session with dynamic discovery |
| `session/prompt` | Send prompt, receive streaming updates |
| `session/cancel` | Cancel current operation |
| `session/set_model` | Switch model (Claude: live via SDK, Codex: next turn) |
| `session/set_mode` | Switch mode |
| `session/set_config_option` | Unified config (model/mode) |
| `session/update` | Streaming: text, thoughts, tool calls, usage, plans |
| `session/request_permission` | Permission flow (allow/always/reject) |

**Claude Code only:**
| Method | Description |
|---|---|
| `session/list` | List existing sessions |
| `session/load` | Resume a session |
| `session/fork` | Fork a session |
| `session/close` | Close a session |

## Project Structure

```
src/
  index.ts                 # Entry point — routes to ClaudeAgent or CodexAgent
  agents/
    claude-agent.ts        # Claude Code via claude-agent-sdk
    codex-agent.ts         # Codex via Session + CodexParser
    shared.ts              # Shared types, Pushable, version detection
    tool-mapping.ts        # SDK tool name → ACP ToolKind mapping
  acp/
    cli.ts                 # CLI argument parsing
    session.ts             # PTY session lifecycle (Codex only)
  parsers/
    types.ts               # TUIParser interface, ParsedEvent
    registry.ts            # Parser registry (Codex only)
    codex.ts               # Codex app-server JSON-RPC parser
  utils/
    logger.ts              # stderr logger
```

## License

Apache-2.0
