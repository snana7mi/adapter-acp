[English](README.md)

# adapter-acp

将原生命令行 AI 代理（Claude Code、Codex）封装为标准 ACP 代理的通用适配器。

## 为什么需要 adapter-acp

Claude Code、Codex 等主流 AI coding agent 不原生支持 ACP 协议。adapter-acp 为它们提供标准的 ACP 接口，使其能够接入任何 ACP 客户端（如 Zed）。

使用用户**已安装的 CLI 和订阅账号**——不需要 API Key。

## 支持的 Agent

| Agent | 集成方式 | 特性 |
|-------|---------|------|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk`（SDK 直连） | 结构化工具调用及 kind 分类、session 恢复/列表/fork、token 用量 + 费用追踪、MCP 服务器传递、Plan 模式 |
| **Codex** | `codex app-server` JSON-RPC（PTY） | Token 用量追踪、工具 kind 分类、Web 搜索事件、commentary/reasoning 阶段区分 |

所有模型、命令、模式均在会话创建时**动态获取**。

## 架构

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
│  (SDK 直连)       (PTY 解析)         │
│     │                │               │
│     ▼                ▼               │
│  claude-agent-sdk  Session+Parser    │
│     │                │               │
└─────┼────────────────┼───────────────┘
      ▼                ▼
  Claude Code        Codex
  (订阅账号)          (订阅账号)
```

## 快速开始

### 通过 npm 安装

```bash
npx adapter-acp claude
npx adapter-acp codex
```

### 从源码

```bash
git clone https://github.com/snana7mi/adapter-acp.git
cd adapter-acp
bun install
bun run src/index.ts claude
```

### 命令行选项

```bash
adapter-acp <agent> [options]

  --cwd <path>       工作目录
  --verbose          开启调试日志（输出到 stderr）
  --pass-env <key>   传递环境变量给 agent（可重复）
```

### 运行测试

```bash
bun test
```

## ACP 协议支持

| 方法 | 说明 |
|------|------|
| `initialize` | 握手，返回 agent 能力 |
| `session/new` | 创建会话，动态发现模型/模式/命令 |
| `session/prompt` | 发送 prompt，接收流式更新 |
| `session/cancel` | 取消当前操作 |
| `session/set_model` | 切换模型（Claude: SDK 实时切换, Codex: 下一轮生效） |
| `session/set_mode` | 切换模式 |
| `session/set_config_option` | 统一配置（模型/模式） |
| `session/update` | 流式更新：文本、思考、工具调用、用量、计划 |
| `session/request_permission` | 权限审批（允许/始终允许/拒绝） |

**仅 Claude Code：**
| 方法 | 说明 |
|------|------|
| `session/list` | 列出已有 session |
| `session/load` | 恢复 session |
| `session/fork` | Fork session |
| `session/close` | 关闭 session |

## 项目结构

```
src/
  index.ts                 # 入口 — 根据 agent 名称路由到 ClaudeAgent 或 CodexAgent
  agents/
    claude-agent.ts        # Claude Code：通过 claude-agent-sdk 直连
    codex-agent.ts         # Codex：通过 Session + CodexParser
    shared.ts              # 共享类型、Pushable、版本检测
    tool-mapping.ts        # SDK 工具名 → ACP ToolKind 映射
  acp/
    cli.ts                 # CLI 参数解析
    session.ts             # PTY session 生命周期（仅 Codex 使用）
  parsers/
    types.ts               # TUIParser 接口、ParsedEvent
    registry.ts            # Parser 注册表（仅 Codex 使用）
    codex.ts               # Codex app-server JSON-RPC 解析器
  utils/
    logger.ts              # stderr 日志
```

## 许可证

[Apache-2.0](LICENSE)
