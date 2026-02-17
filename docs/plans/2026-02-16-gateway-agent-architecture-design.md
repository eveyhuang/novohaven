# NovoHaven Gateway Agent Architecture — Design Document

**Date:** 2026-02-16
**Status:** In Progress (Sections 1–8 approved)
**Approach:** B — HTTP Gateway + Event Streaming (adapted from OpenClaw)

---

## Requirements Summary

- **Web UI**: Full dual interface — admin control plane (skill editor, workflow builder, usage dashboard, health monitoring) AND a messaging channel for direct agent interaction
- **Lark**: Bot in group chats + DMs — primary external messaging channel
- **Concurrency**: Process-per-session agent isolation — each user conversation spawns a dedicated agent process
- **LLM**: Agent runtime is provider-agnostic; users select models per skill/step (Claude, Gemini, OpenAI, Manus, etc.)
- **Plugins**: All 4 categories from day one — Channel, Tool, Memory, Provider
- **Skill discovery**: Semantic search (vector + keyword) over skills/workflows to find relevant capabilities per-turn
- **Database**: `better-sqlite3` + `sqlite-vec` for vector search (replaces current `sql.js`)
- **Skill creation**: Agent proposes new skills, human approves before saving
- **Skill maintenance**: Agent can test, diagnose, and propose edits to broken skills/workflows, with human approval
- **Gateway**: Central control plane — core code never changes when adding plugins

### Naming Conventions

| Old Name | New Name | Description |
|---|---|---|
| Template (`is_template=1`) | **Skill** | A reusable, single-purpose capability (e.g., "Product Review Analyzer") |
| Recipe (`is_template=0`) | **Workflow** | A multi-step composed pipeline that may reference skills |

---

## Section 1: System Architecture Overview

```
┌─────────────────────┐    ┌──────────────────────┐
│   Control Interfaces │    │  Messaging Channels   │
│                     │    │                      │
│  React Web UI       │    │  Lark Bot            │
│  (localhost:3000)   │    │  (webhook receiver)  │
│                     │    │  Future: Slack, etc  │
└────────┬────────────┘    └──────────┬───────────┘
         │ REST + SSE                 │ Normalized messages
         ▼                            ▼
┌─────────────────────────────────────────────────┐
│              Gateway Control Plane               │
│              (Express, port 3001)                │
│                                                 │
│  ┌─────────────┐  ┌──────────┐  ┌───────────┐  │
│  │Channel Router│  │  Access  │  │  Session   │  │
│  │             │  │ Control  │  │  Manager   │  │
│  └──────┬──────┘  └────┬─────┘  └─────┬─────┘  │
│         └───────────────┴──────────────┘        │
│                        │                        │
│              ┌─────────▼──────────┐             │
│              │  Agent Supervisor   │             │
│              │  (process spawner)  │             │
│              └─────────┬──────────┘             │
└────────────────────────┼────────────────────────┘
                         │ IPC (child_process)
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Agent Process │ │ Agent Process │ │ Agent Process │
│  (Session A)  │ │  (Session B)  │ │  (Session C)  │
│              │ │              │ │              │
│ Agent Core   │ │ Agent Core   │ │ Agent Core   │
│ Skill Search │ │ Skill Search │ │ Skill Search │
│ Tool Executor│ │ Tool Executor│ │ Tool Executor│
│ Prompt Builder│ │ Prompt Builder│ │ Prompt Builder│
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       ▼                ▼                ▼
┌─────────────────────────────────────────────────┐
│            Plugin System (shared)                │
│                                                 │
│  Channel    Tool       Memory     Provider      │
│  Plugins    Plugins    Plugins    Plugins        │
│  (Lark,     (Browser,  (SQLite,   (Claude,      │
│   Web)       Bash,      Vector)    Gemini,      │
│              FileOps)              OpenAI)       │
└─────────────────────────────────────────────────┘
```

### OpenClaw → NovoHaven Concept Mapping

| OpenClaw Concept | OpenClaw Implementation | NovoHaven Equivalent |
|---|---|---|
| Gateway Server (`ws`, port 18789) | WebSocket server in `src/gateway/server.ts` | **Express server** (port 3001) — current `server/src/index.ts` evolves into the gateway |
| Channel Router | Routes WS frames by source channel | **Channel Router middleware** — normalizes Lark webhooks and Web UI requests into a common `ChannelMessage` format |
| Access Control | DM pairing, allowlists, challenge-response | **Auth middleware** — existing `authMiddleware` + Lark bot verification |
| Session Manager | Maps messages to security-scoped sessions | **Session Manager** — new service mapping `(userId, channelId, threadId)` → agent session |
| PiEmbeddedRunner (`src/agents/piembeddedrunner.ts`) | Agent loop via `@mariozechner/pi-agent-core` | **AgentRunner** — new class implementing the 4-step loop (resolve session → assemble context → stream LLM → execute tools → persist) |
| Plugin Loader (`src/plugins/loader.ts`) | Scans `package.json` for `openclaw.extensions` | **Plugin Loader** — scans `plugins/` directory for manifest files, validates schemas, registers with gateway |
| Memory Search (SQLite + vectors) | `~/.openclaw/memory/<agentId>.sqlite` | **Skill Search** — `better-sqlite3` + `sqlite-vec` over skills and workflows |
| Tool Executor | Built-in + plugin tools | **Tool Executor** — evolves current `executors/registry.ts` pattern |
| Prompt Builder | Layers static files + dynamic context | **Prompt Builder** — evolves `promptParser.ts` + adds skill injection and session history |
| Canvas Server (port 18793) | Separate process for agent-driven UI | **Not needed** — React web UI serves this role |
| `AGENTS.md` / `SOUL.md` | Static personality/instruction files | **System prompt config** — stored in DB per agent configuration, editable from web UI |
| `skills/<skill>/SKILL.md` | Markdown files with task guides | **Skills table** (DB) — structured, executable skills with steps, prompts, model configs |
| Sessions (append-only event logs) | `~/.openclaw/sessions/` files | **Sessions table + session_messages table** in SQLite |
| `agents.mapping` config | Routes channels to isolated agent instances | **Agent config** in DB — which channels, models, tools, system prompts per agent |

---

## Section 2: Gateway Control Plane

The central nervous system. The current `server/src/index.ts` evolves into this.

```
┌──────────────────────────────────────────────────────────────┐
│                   Gateway Control Plane                       │
│                   (Express, port 3001)                        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   Channel Router                        │  │
│  │                                                        │  │
│  │  Inbound:                                              │  │
│  │  POST /channels/lark/webhook  → LarkAdapter.parse()    │  │
│  │  POST /channels/web/message   → WebAdapter.parse()     │  │
│  │  POST /channels/:name/webhook → PluginAdapter.parse()  │  │
│  │                                                        │  │
│  │  All adapters normalize to:                            │  │
│  │  ChannelMessage {                                      │  │
│  │    channelType, channelId, userId, threadId,           │  │
│  │    content: { text, attachments }, metadata            │  │
│  │  }                                                     │  │
│  │                                                        │  │
│  │  Outbound:                                             │  │
│  │  Gateway calls adapter.send(channelId, AgentResponse)  │  │
│  │  Each adapter formats for its platform                 │  │
│  └──────────────┬─────────────────────────────────────────┘  │
│                 │                                            │
│  ┌──────────────▼─────────────────────────────────────────┐  │
│  │              Session Manager                            │  │
│  │                                                        │  │
│  │  Maps (channelType, userId, threadId) → SessionID      │  │
│  │  Creates new sessions on first contact                 │  │
│  │  Stores: session history, state, active agent PID      │  │
│  │                                                        │  │
│  │  Sessions table (new):                                 │  │
│  │  id, channel_type, channel_id, user_id, thread_id,    │  │
│  │  agent_pid, status, created_at, last_active_at         │  │
│  └──────────────┬─────────────────────────────────────────┘  │
│                 │                                            │
│  ┌──────────────▼─────────────────────────────────────────┐  │
│  │              Agent Supervisor                           │  │
│  │                                                        │  │
│  │  Spawns/reuses agent processes per session             │  │
│  │  Communicates via Node child_process IPC               │  │
│  │  Monitors health (heartbeat, restart on crash)         │  │
│  │  Enforces max concurrent agents limit                  │  │
│  │  Idle timeout: reclaims agents after N minutes         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  API Routes (preserved, evolved):                            │
│  /api/skills      ← was /api/recipes (is_template=1)         │
│  /api/workflows   ← was /api/recipes (is_template=0)         │
│  /api/executions  ← unchanged                                │
│  /api/standards   ← unchanged                                │
│  /api/usage       ← unchanged                                │
│  /api/plugins     ← NEW: list/configure plugins              │
│  /api/sessions    ← NEW: list active sessions, health        │
│  /api/agents      ← NEW: agent config, system prompts        │
│                                                              │
│  Channel endpoints:                                          │
│  /channels/lark/webhook   ← Lark event subscription          │
│  /channels/web/message    ← Web UI chat messages              │
│  /channels/:name/webhook  ← Future plugin channels            │
└──────────────────────────────────────────────────────────────┘
```

### Current Code → Gateway Migration Map

| Current File | What It Becomes |
|---|---|
| `server/src/index.ts` | Gateway entry point — adds channel router, session manager, agent supervisor on top of existing Express app |
| `routes/recipes.ts` | Splits into `routes/skills.ts` (is_template=1) and `routes/workflows.ts` (is_template=0) |
| `routes/executions.ts` | Stays, but executions can now be triggered by agent processes (not just web UI) |
| `routes/executionStream.ts` (SSE) | Evolves into the **outbound event pipe** — agent events stream to both web UI (SSE) and Lark (via adapter) |
| `middleware/auth.ts` | Expanded: JWT for web UI (as today) + Lark bot verification + plugin channel auth |
| `services/executionEvents.ts` | Becomes the **gateway event bus** — `ExecutionEventEmitter` already does pub/sub by execution ID, now also routes events to the correct channel adapter |
| `routes/assistant.ts` | Merges into agent capabilities — the AI workflow builder becomes a skill the agent can use |
| `routes/manus.ts`, `routes/browser.ts` | Become **tool plugins** instead of dedicated routes |

### Key New Components

- **`ChannelAdapter` interface** — what OpenClaw calls channel plugins. Each implements: `parseInbound(req) → ChannelMessage`, `sendOutbound(channelId, response)`, `verifyAuth(req) → boolean`
- **`SessionManager` service** — maps inbound messages to sessions, manages lifecycle
- **`AgentSupervisor` service** — spawns/manages child processes, IPC communication, health monitoring

---

## Section 3: Skill Layer (Templates → Skills, Recipes → Workflows)

Skills and workflows are the core content users create in the web UI. They serve a **dual role** unique to NovoHaven (no direct OpenClaw equivalent):

### Role 1: Searchable Knowledge (like OpenClaw's `skills/<skill>/SKILL.md`)

Each skill/workflow gets **indexed** (name, description, step summaries, tags) into the vector store via `sqlite-vec`. When a Lark user says "analyze these product reviews," the agent's **Skill Search** finds "Product Review Analyzer" and knows it exists, what it does, and what inputs it needs.

### Role 2: Executable Workflows (NovoHaven-specific)

Unlike OpenClaw skills (which are just prompt instructions), NovoHaven skills are **multi-step executable workflows** with specific models, prompts, and executor configs per step. When the agent decides to use "Product Review Analyzer," it **spawns a workflow execution** through the existing workflow engine and executor registry.

```
┌─────────────────────────────────────────────────────────┐
│                    Skill Layer                           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Skill Registry (DB)                 │   │
│  │                                                 │   │
│  │  skills table + skill_steps table               │   │
│  │  (evolved from recipes + recipe_steps)          │   │
│  │                                                 │   │
│  │  status: draft | active | archived              │   │
│  │  Each skill/workflow = an agent "Skill"          │   │
│  └──────────┬──────────────────┬───────────────────┘   │
│             │                  │                        │
│       ┌─────▼──────┐   ┌──────▼────────┐              │
│       │ Skill Index │   │ Skill Executor │              │
│       │ (vectors)   │   │ (workflow eng) │              │
│       └─────┬──────┘   └──────┬────────┘              │
│             │                  │                        │
│        Searched by         Invoked by                   │
│        Agent Core          Agent Core                   │
└─────────────────────────────────────────────────────────┘
```

### Agent Conversation Flow (Skill Discovery → Execution)

```
User (Lark): "Can you analyze the reviews for this product? [url]"
        │
        ▼
  1. Skill Search (semantic match)
     → finds "Product Review Analyzer" (score: 0.92)
     → returns: name, description, required inputs, steps summary
        │
        ▼
  2. Agent decides (LLM reasoning)
     → "I'll use this skill. I have the URL, need to ask which platform."
        │
        ▼
  3. Agent responds to user in Lark
     → "I found a review analyzer skill. Which platform? Amazon/Wayfair/Other?"
        │
  User: "Wayfair"
        │
        ▼
  4. Spawn workflow execution
     → Creates workflow_execution with input_data: {url, platform: "wayfair"}
     → Workflow engine runs steps via executor registry
        │
        ▼
  5. Stream results back to Lark
     → Step outputs stream through gateway → Lark channel adapter → user
```

### Agent Self-Healing: Test, Diagnose, and Fix Skills

When an agent encounters a broken skill or workflow:

```
Agent uses a skill → execution fails or produces bad output
        │
        ▼
Agent diagnoses the issue
  (wrong prompt, bad config, missing variable, model error, etc.)
        │
        ▼
Agent proposes a fix to the user:
  "Step 2's prompt references {{brand_voice}} but this workflow doesn't
   collect that input. I can:
     A) Add it as a required input
     B) Replace with a default value"
        │
        ▼
User approves option → Agent saves the fix → Re-runs the workflow
```

The agent has access to:
- **`skill:test`** tool — run a skill with test inputs and inspect output
- **`skill:edit`** tool — propose modifications (creates a draft version)
- **`skill:validate`** tool — check for missing variables, invalid configs, broken step references

All edits create **draft versions** that require human approval before becoming active.

---

## Section 4: Agent Runtime

The heart of the system — what happens inside each spawned agent process. Maps to OpenClaw's `PiEmbeddedRunner` + `@mariozechner/pi-agent-core`.

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Process (one per session)            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    AgentRunner                         │  │
│  │              (the agentic loop, runs per-turn)        │  │
│  │                                                       │  │
│  │  ┌─────────┐   ┌──────────┐   ┌─────────┐           │  │
│  │  │ 1.Resolve│──▶│2.Assemble│──▶│3.Stream │──┐        │  │
│  │  │ Session  │   │ Context  │   │ LLM     │  │        │  │
│  │  └─────────┘   └──────────┘   └─────────┘  │        │  │
│  │                                     ┌───────▼──────┐ │  │
│  │  ┌──────────┐                       │ 4. Execute   │ │  │
│  │  │5.Persist │◀──────────────────────│ Tool Calls   │ │  │
│  │  │ State    │                       └──────────────┘ │  │
│  │  └──────────┘                                        │  │
│  └───────────┬───────────────────────────────────────────┘  │
│              │ uses                                          │
│  ┌───────────▼───────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  ┌──────────────┐ ┌────────────┐ ┌────────────────┐  │  │
│  │  │ Skill Search  │ │  Prompt    │ │ Tool Executor  │  │  │
│  │  │ (vector+BM25) │ │  Builder   │ │ (registry)     │  │  │
│  │  └──────────────┘ └────────────┘ └────────────────┘  │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│              │                                              │
│              │ IPC (process.send / process.on)               │
│              ▼                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Gateway IPC Bridge                                    │  │
│  │  Receives: { type: 'message', content, sessionId }     │  │
│  │  Sends:    { type: 'response', content, sessionId }    │  │
│  │            { type: 'approval_request', ... }           │  │
│  │            { type: 'stream_chunk', ... }               │  │
│  │            { type: 'heartbeat' }                       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### The 5-Step Agent Loop (per turn)

Maps to OpenClaw's PiEmbeddedRunner: resolve session → assemble context → stream model → execute tools → persist state.

```typescript
// server/src/agent/AgentRunner.ts

class AgentRunner {
  async handleTurn(message: ChannelMessage): Promise<void> {

    // Step 1: Resolve Session
    const session = await this.sessionStore.load(message.sessionId);

    // Step 2: Assemble Context
    const context = await this.promptBuilder.build({
      session,
      message,
      skills: await this.skillSearch.find(message.content.text, { limit: 3 }),
      activeExecution: session.activeExecutionId
        ? await this.executionStore.load(session.activeExecutionId)
        : null,
    });

    // Step 3: Stream LLM response (with tool calls)
    const stream = await this.provider.stream({
      model: this.agentConfig.defaultModel,
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: this.toolExecutor.getToolDefinitions(),
    });

    // Step 4: Process stream — execute tool calls as they arrive
    for await (const event of stream) {
      if (event.type === 'text') {
        this.ipc.send({ type: 'stream_chunk', content: event.text });
      }
      if (event.type === 'tool_call') {
        const result = await this.toolExecutor.execute(event.tool, event.args);
        stream.feedToolResult(event.id, result);
      }
    }

    // Step 5: Persist state
    await this.sessionStore.appendTurn(message.sessionId, {
      userMessage: message,
      assistantResponse: stream.getFullResponse(),
      toolCalls: stream.getToolCalls(),
    });
  }
}
```

### OpenClaw Mapping for Agent Runtime

| OpenClaw Component | OpenClaw Implementation | NovoHaven Equivalent |
|---|---|---|
| `PiEmbeddedRunner.runTurn()` | Single method orchestrating the full loop | `AgentRunner.handleTurn()` — same pattern |
| Session resolution | Maps to main/dm/group security scopes | `SessionStore.load()` — loads from `sessions` + `session_messages` tables |
| Context assembly via `buildPrompt()` | Layers AGENTS.md + SOUL.md + TOOLS.md + skills + memory | `PromptBuilder.build()` — layers system config + skill search results + session history + active execution state |
| `pi-agent-core` streaming | RPC-style with streaming responses | Native Anthropic/OpenAI SDK streaming — existing `aiService.ts` already does this |
| Tool interception | Intercepts tool_use blocks mid-stream | `ToolExecutor.execute()` — evolves existing `executors/registry.ts` into agent-callable tools |
| State persistence | Append-only event logs to disk | `SessionStore.appendTurn()` — writes to `session_messages` table |

### Prompt Builder

Evolves current `promptParser.ts`. Composes the full prompt from layered sources:

```
System Prompt (assembled per-turn):
├── Agent personality/instructions (from DB agent config — replaces AGENTS.md/SOUL.md)
├── Available tools summary (auto-generated from registered tools)
├── Relevant skills (injected from Skill Search, 0-3 per turn)
│   └── For each skill: name, description, required inputs, step summary
├── Active execution context (if a workflow is running)
│   └── Current step, completed outputs, pending actions
└── Company standards (if referenced by active skill)

Messages:
├── Session history (last N turns, compacted if exceeding context limit)
└── Current user message
```

**Key difference from OpenClaw**: OpenClaw injects skill markdown files as-is. NovoHaven's prompt builder generates a **structured skill summary** from the DB schema, so the agent understands both what the skill does AND how to invoke it (required inputs, step types, expected outputs).

### Tool Executor

Evolves current `executors/registry.ts`. Tools serve a **dual purpose**:

**1. Agent-callable tools** (new) — the LLM calls these during conversation:

| Tool Name | Description | Maps to Current |
|---|---|---|
| `skill:search` | Find relevant skills by description | New (Skill Search) |
| `skill:execute` | Run a skill/workflow with given inputs | Evolves `workflowEngine.ts` |
| `skill:test` | Test a skill with sample inputs | New |
| `skill:edit` | Propose edits to a skill (creates draft) | New |
| `skill:create` | Propose a new skill (creates draft) | Evolves `workflowAssistant.ts` |
| `skill:validate` | Check skill for errors | New |
| `browser:navigate` | Open URL, take screenshot | Evolves `browserService.ts` |
| `browser:interact` | Click, type, extract content | Evolves `browserService.ts` |
| `bash:execute` | Run shell commands | New |
| `file:read` | Read file contents | New |
| `file:write` | Write/edit files | New |
| `approval:request` | Ask user for approval | New (sends via IPC → gateway → channel) |

**2. Step executors** (existing, preserved) — run inside workflow executions:

Existing `AIExecutor`, `ScrapingExecutor`, `ManusExecutor`, `ScriptExecutor`, `HttpExecutor`, `TransformExecutor` remain unchanged. They're invoked by the workflow engine when the agent triggers `skill:execute`.

```
Agent Tool Call: skill:execute("Product Review Analyzer", {url, platform})
        │
        ▼
  WorkflowEngine.start(skillId, inputs)
        │
        ▼
  Step 1: ScrapingExecutor  →  scrape reviews
  Step 2: AIExecutor        →  analyze with Claude
  Step 3: TransformExecutor →  format output
        │
        ▼
  Results stream back to agent → agent summarizes for user
```

### IPC Protocol (Agent ↔ Gateway)

Communication between gateway and agent processes uses Node.js `child_process` IPC:

```typescript
// Gateway → Agent (inbound)
type GatewayToAgent =
  | { type: 'message'; sessionId: string; message: ChannelMessage }
  | { type: 'approval_response'; requestId: string; approved: boolean; data?: any }
  | { type: 'shutdown' }

// Agent → Gateway (outbound)
type AgentToGateway =
  | { type: 'stream_chunk'; sessionId: string; content: string }
  | { type: 'response_complete'; sessionId: string; fullResponse: string }
  | { type: 'approval_request'; sessionId: string; requestId: string; prompt: string; options: string[] }
  | { type: 'execution_event'; sessionId: string; event: ExecutionChatMessage }  // reuses existing type
  | { type: 'heartbeat' }
  | { type: 'error'; sessionId: string; error: string }
```

The `execution_event` type reuses the existing `ExecutionChatMessage` from `executionEvents.ts` — so all current SSE event types (step-start, progress, agent-message, step-output, action-required, etc.) flow through the same path.

---

## Section 5: Plugin System

The key extensibility layer — ensures core code never changes when adding capabilities. Adapted from OpenClaw's discovery-based plugin loading.

```
┌─────────────────────────────────────────────────────────────┐
│                      Core System                             │
│                                                             │
│  ┌─────────────┐    ┌──────────────────────────────────┐   │
│  │  Registry    │◀───│  Plugin Loader                    │   │
│  │  (in-memory) │    │  server/src/plugins/loader.ts     │   │
│  └──────┬──────┘    └──────────────┬───────────────────┘   │
│         │                          │                        │
│         │           ┌──────────────▼───────────────────┐   │
│         │           │  Plugin Discovery                 │   │
│         │           │                                   │   │
│         │           │  1. Scan plugins/ directory        │   │
│         │           │  2. Read manifest.json per plugin  │   │
│         │           │  3. Validate against type schema   │   │
│         │           │  4. Load entry point               │   │
│         │           │  5. Register with Registry         │   │
│         │           └───────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Four Plugin Types                       │   │
│  │                                                     │   │
│  │  ┌───────────┐ ┌──────────┐ ┌────────┐ ┌────────┐  │   │
│  │  │  Channel   │ │   Tool   │ │ Memory │ │Provider│  │   │
│  │  │  Plugins   │ │  Plugins │ │Plugins │ │Plugins │  │   │
│  │  └─────┬─────┘ └────┬─────┘ └───┬────┘ └───┬────┘  │   │
│  │        │             │           │          │       │   │
│  │        ▼             ▼           ▼          ▼       │   │
│  │  Channel Router  Tool Executor  Skill    Agent      │   │
│  │                                 Search   Runner     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Plugin Directory Structure

```
server/
  src/
    plugins/
      loader.ts          ← scans and loads all plugins
      types.ts           ← plugin interfaces
      builtin/           ← built-in plugins (ship with core)
        channel-web/
          manifest.json
          index.ts
        channel-lark/
          manifest.json
          index.ts
        tool-browser/
          manifest.json
          index.ts
        tool-bash/
          manifest.json
          index.ts
        tool-fileops/
          manifest.json
          index.ts
        tool-skill-manager/
          manifest.json
          index.ts
        memory-sqlite-vec/
          manifest.json
          index.ts
        provider-anthropic/
          manifest.json
          index.ts
        provider-openai/
          manifest.json
          index.ts
        provider-google/
          manifest.json
          index.ts
      community/          ← user-installed plugins (gitignored)
        channel-slack/
          manifest.json
          index.ts
```

### Plugin Manifest (`manifest.json`)

Every plugin declares what it is and what it needs:

```json
{
  "name": "channel-lark",
  "version": "1.0.0",
  "type": "channel",
  "displayName": "Lark Messaging",
  "description": "Lark bot integration for group chats and DMs",
  "entry": "./index.ts",
  "config": {
    "type": "object",
    "properties": {
      "appId":     { "type": "string", "description": "Lark app ID" },
      "appSecret": { "type": "string", "description": "Lark app secret", "secret": true },
      "verificationToken": { "type": "string", "secret": true }
    },
    "required": ["appId", "appSecret", "verificationToken"]
  }
}
```

The `config` schema (JSON Schema) drives both **validation at load time** and **auto-generated config forms in the web UI** — same pattern as current `getConfigSchema()` for executor config panels.

### Four Plugin Interfaces

```typescript
// server/src/plugins/types.ts

// ---- Base ----
interface PluginManifest {
  name: string;
  version: string;
  type: 'channel' | 'tool' | 'memory' | 'provider';
  displayName: string;
  description: string;
  entry: string;
  config: JSONSchema;
}

interface Plugin {
  manifest: PluginManifest;
  initialize(config: Record<string, any>): Promise<void>;
  shutdown(): Promise<void>;
}

// ---- Channel Plugin ----
// OpenClaw: Channel Adapters (iMessage, WhatsApp, Telegram, etc.)
// Built-in: channel-web, channel-lark
interface ChannelPlugin extends Plugin {
  type: 'channel';
  parseInbound(req: Express.Request): ChannelMessage | null;
  sendOutbound(channelId: string, response: AgentResponse): Promise<void>;
  verifyAuth(req: Express.Request): boolean;
  registerRoutes(router: Express.Router): void;
}

// ---- Tool Plugin ----
// OpenClaw: Tool Plugins + built-in Bash/Browser/FileOps/Cron
// Built-in: tool-browser, tool-bash, tool-fileops, tool-skill-manager
interface ToolPlugin extends Plugin {
  type: 'tool';
  getTools(): ToolDefinition[];
  execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
}

// ---- Memory Plugin ----
// OpenClaw: Memory Plugins (memory-core with SQLite + vectors)
// Built-in: memory-sqlite-vec
interface MemoryPlugin extends Plugin {
  type: 'memory';
  index(item: SkillIndexEntry): Promise<void>;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
  storeMemory(sessionId: string, content: string, embedding: number[]): Promise<void>;
  searchMemory(sessionId: string, query: string, limit: number): Promise<MemoryEntry[]>;
}

// ---- Provider Plugin ----
// OpenClaw: Provider Plugins (custom models)
// Built-in: provider-anthropic, provider-openai, provider-google
interface ProviderPlugin extends Plugin {
  type: 'provider';
  listModels(): ModelInfo[];
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
  embed?(texts: string[]): Promise<number[][]>;
}
```

### OpenClaw Mapping for Plugin System

| OpenClaw Concept | OpenClaw Implementation | NovoHaven Equivalent |
|---|---|---|
| Plugin Loader (`src/plugins/loader.ts`) | Scans `package.json` for `openclaw.extensions` | `server/src/plugins/loader.ts` — scans `plugins/builtin/` and `plugins/community/` for `manifest.json` |
| TypeBox Schema validation | Validates config against TypeBox schemas | JSON Schema validation against `manifest.config` |
| Entry Point (`dist/index.js`) | Plugin's compiled JS entry | `index.ts` entry — compiled at load time or pre-built |
| Channel Plugins (msteams, matrix) | Implement channel adapter interface | `ChannelPlugin` interface |
| Tool Plugins (custom tools) | Register tools with Tool Executor | `ToolPlugin` interface |
| Memory Plugins (memory-core) | SQLite + vector embeddings | `MemoryPlugin` interface |
| Provider Plugins (custom models) | Alternative LLM backends | `ProviderPlugin` interface |
| Plugin Discovery (scan workspace) | Reads package.json → openclaw.extensions | Reads `manifest.json` in each plugin directory |
| Hot-loading | Detects new plugins at runtime | Load at startup; later: watch `plugins/` for hot-reload |

### Current Code → Plugin Migration

| Current Code | Becomes Plugin |
|---|---|
| `services/aiService.ts` (Anthropic client) | `provider-anthropic/index.ts` |
| `services/aiService.ts` (OpenAI client) | `provider-openai/index.ts` |
| `services/aiService.ts` (Google client) | `provider-google/index.ts` |
| `services/browserService.ts` | `tool-browser/index.ts` |
| `routes/manus.ts` + `services/manusService.ts` | `provider-manus/index.ts` |
| `executors/ScrapingExecutor.ts` | Stays as step executor, but uses `tool-browser` plugin internally |
| `services/executionEvents.ts` + SSE routes | `channel-web/index.ts` |
| Future Lark integration | `channel-lark/index.ts` |

### Plugin Loader

```typescript
// server/src/plugins/loader.ts

class PluginLoader {
  private registry: PluginRegistry;

  async loadAll(): Promise<void> {
    const builtinDir = path.join(__dirname, 'builtin');
    const communityDir = path.join(__dirname, 'community');

    for (const dir of [builtinDir, communityDir]) {
      const pluginDirs = fs.readdirSync(dir);
      for (const pluginName of pluginDirs) {
        await this.loadPlugin(path.join(dir, pluginName));
      }
    }
  }

  private async loadPlugin(pluginPath: string): Promise<void> {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginPath, 'manifest.json'), 'utf-8')
    );
    this.validateManifest(manifest);

    const config = await this.loadPluginConfig(manifest.name);

    const PluginClass = require(path.join(pluginPath, manifest.entry)).default;
    const plugin = new PluginClass(manifest);
    await plugin.initialize(config);

    this.registry.register(manifest.type, manifest.name, plugin);
  }
}
```

### Plugin Config Storage

Plugin configurations stored in a new `plugin_configs` table — configurable from web UI:

```sql
CREATE TABLE plugin_configs (
  id INTEGER PRIMARY KEY,
  plugin_name TEXT UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',  -- JSON matching manifest.config schema
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

The web UI renders config forms automatically from `manifest.config` JSON Schema — same pattern as current executor `getConfigSchema()`.

## Section 6: Database Migration

Moving from sql.js (in-memory, synchronous) to better-sqlite3 (native, file-based) with sqlite-vec for vector search.

### Current → New Table Mapping

```
RENAMED TABLES:
  recipes (is_template=1)     →  skills
  recipes (is_template=0)     →  workflows
  recipe_steps                →  skill_steps  (serves both skills and workflows)

PRESERVED TABLES (minor updates):
  users                       →  users (add role column)
  company_standards           →  company_standards (unchanged)
  workflow_executions          →  workflow_executions (add session_id FK)
  step_executions              →  step_executions (unchanged)
  api_usage                   →  api_usage (unchanged)
  manus_outputs               →  manus_outputs (unchanged)

NEW TABLES:
  sessions                    ←  agent session tracking
  session_messages             ←  conversation history per session
  skill_index                  ←  vector embeddings for skill search
  plugin_configs               ←  plugin configuration storage
  agent_configs                ←  per-agent settings (model, personality, tools)
  skill_drafts                 ←  agent-proposed edits awaiting approval
```

### New Table Schemas

```sql
-- Renamed from recipes, filtered to is_template=1
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
  tags TEXT DEFAULT '[]',           -- JSON array for search filtering
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Renamed from recipes, filtered to is_template=0
CREATE TABLE workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
  tags TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Renamed from recipe_steps, references either skills or workflows
CREATE TABLE skill_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL,       -- references skills.id or workflows.id
  parent_type TEXT NOT NULL CHECK(parent_type IN ('skill','workflow')),
  step_order INTEGER NOT NULL,
  step_name TEXT,
  step_type TEXT DEFAULT 'ai',
  ai_model TEXT,
  prompt_template TEXT,
  input_config TEXT DEFAULT '{}',
  output_format TEXT DEFAULT 'text',
  model_config TEXT DEFAULT '{}',
  executor_config TEXT DEFAULT '{}',
  UNIQUE(parent_id, parent_type, step_order)
);

-- Agent session tracking (OpenClaw: session files in ~/.openclaw/sessions/)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- UUID
  channel_type TEXT NOT NULL,       -- 'web', 'lark', plugin name
  channel_id TEXT NOT NULL,         -- platform-specific channel identifier
  user_id INTEGER REFERENCES users(id),
  thread_id TEXT,                   -- for threaded conversations (Lark groups)
  agent_pid INTEGER,                -- PID of assigned agent process
  status TEXT DEFAULT 'active' CHECK(status IN ('active','idle','closed')),
  agent_config_id INTEGER REFERENCES agent_configs(id),
  active_execution_id INTEGER REFERENCES workflow_executions(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Conversation history (OpenClaw: append-only event logs)
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,                  -- JSON array of tool calls made
  tool_results TEXT,                -- JSON array of tool results
  metadata TEXT DEFAULT '{}',       -- channel-specific metadata
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Vector index for skill/workflow search (OpenClaw: memory sqlite + vectors)
CREATE TABLE skill_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER,                 -- references skills.id or workflows.id
  skill_type TEXT NOT NULL CHECK(skill_type IN ('skill','workflow')),
  name TEXT NOT NULL,
  description TEXT,
  step_summary TEXT,                -- generated text summary of all steps
  tags TEXT DEFAULT '[]',
  embedding BLOB,                   -- sqlite-vec vector (float32 array)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Plugin configurations (OpenClaw: openclaw.json config file)
CREATE TABLE plugin_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_name TEXT UNIQUE NOT NULL,
  plugin_type TEXT NOT NULL CHECK(plugin_type IN ('channel','tool','memory','provider')),
  enabled BOOLEAN DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent configurations (OpenClaw: agents.mapping in config)
CREATE TABLE agent_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  default_model TEXT NOT NULL,      -- e.g. 'claude-sonnet-4-5-20250929'
  system_prompt TEXT,               -- personality/instructions
  allowed_tools TEXT DEFAULT '[]',  -- JSON array of tool plugin names
  allowed_channels TEXT DEFAULT '[]', -- JSON array of channel plugin names
  max_turns_per_session INTEGER DEFAULT 50,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent-proposed skill edits awaiting approval
CREATE TABLE skill_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_skill_id INTEGER,        -- null if brand new skill
  skill_type TEXT NOT NULL CHECK(skill_type IN ('skill','workflow')),
  proposed_by_session TEXT REFERENCES sessions(id),
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT NOT NULL,              -- JSON array of full step definitions
  change_summary TEXT,              -- agent's explanation of what changed and why
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME
);
```

### Migration Strategy

```
Phase 1: Switch database driver
  sql.js (synchronous, in-memory) → better-sqlite3 (native, file-based)
  - Update server/src/models/database.ts
  - Helper functions (getOne, getAll, run) stay the same API
  - Point at existing novohaven.db file

Phase 2: Rename tables + add columns
  - recipes WHERE is_template=1 → skills
  - recipes WHERE is_template=0 → workflows
  - recipe_steps → skill_steps (add parent_type column)
  - Add status, tags columns to skills/workflows
  - Add session_id to workflow_executions

Phase 3: Create new tables
  - sessions, session_messages, skill_index, plugin_configs,
    agent_configs, skill_drafts

Phase 4: Build vector index
  - Install sqlite-vec extension
  - Generate embeddings for all existing skills/workflows
  - Populate skill_index table

Phase 5: Seed defaults
  - Default agent_config (Claude Sonnet, all tools enabled)
  - Default plugin_configs for built-in plugins
```

---

## Section 7: Web UI Updates

The React frontend evolves from a recipe/template manager into a **full agent control plane + messaging interface**.

### Route Changes

```
RENAMED:
  /templates/new      →  /skills/new
  /templates/:id      →  /skills/:id
  /recipes/new        →  /workflows/new
  /recipes/:id        →  /workflows/:id
  /recipes/:id/run    →  /workflows/:id/run

PRESERVED:
  /                   →  / (Dashboard — updated with agent health)
  /executions         →  /executions
  /executions/:id     →  /executions/:id
  /outputs            →  /outputs
  /standards          →  /standards
  /usage              →  /usage

NEW:
  /chat               →  AgentChat (web channel — direct agent conversation)
  /sessions           →  SessionMonitor (active sessions across all channels)
  /plugins            →  PluginManager (configure/enable/disable plugins)
  /agents             →  AgentConfigs (manage agent personalities/models/tools)
  /skills/drafts      →  SkillDraftReview (approve/reject agent-proposed skills)
```

### Component Changes

```
RENAMED:
  TemplateEditor/     →  SkillEditor/
  RecipeBuilder/      →  WorkflowBuilder/
  RecipeRunner/       →  WorkflowRunner/

PRESERVED (minor updates):
  ChatExecution/      →  ChatExecution/ (unchanged — still handles workflow execution chat)
  WorkflowBuilder/    →  AIWorkflowBuilder/ (rename references only)
  Dashboard/          →  Dashboard/ (add agent health panel)
  CompanyStandards/   →  CompanyStandards/
  OutputsGallery/     →  OutputsGallery/

NEW COMPONENTS:
  AgentChat/          ←  Web channel messaging interface
    AgentChat.tsx         Full conversation UI (freeform agent chat)
    AgentChatInput.tsx    Message input with file attachments
    AgentChatHistory.tsx  Session history sidebar

  SessionMonitor/     ←  Admin view of all active agent sessions
    SessionMonitor.tsx    Table of active sessions across Lark + Web
    SessionDetail.tsx     Inspect a session's conversation + tool calls

  PluginManager/      ←  Plugin configuration UI
    PluginManager.tsx     List all plugins, enable/disable toggle
    PluginConfig.tsx      Auto-generated config form from manifest.config schema

  AgentConfigs/       ←  Agent personality/model management
    AgentConfigList.tsx   List agent configurations
    AgentConfigEditor.tsx Edit system prompt, model, allowed tools/channels

  SkillDraftReview/   ←  Review agent-proposed skills
    DraftList.tsx         Pending drafts with agent's change summary
    DraftDiff.tsx         Side-by-side diff of original vs proposed changes
```

### OpenClaw UI Mapping

| OpenClaw Concept | OpenClaw Implementation | NovoHaven Equivalent |
|---|---|---|
| Desktop app (macOS menu bar) | Native Electron app | **Web UI** — React SPA serves as the control interface |
| CLI interface | Terminal commands | **Not needed** — web UI covers all admin functions |
| Canvas (port 18793) | Agent-driven HTML interface | **AgentChat component** — web channel for direct agent interaction |
| Session inspector | CLI `sessions list/history` | **SessionMonitor** — web-based session monitoring dashboard |
| Config file (`openclaw.json`) | JSON5 config on disk | **DB-backed config** — agent_configs + plugin_configs tables, edited via web UI |

---

## Section 8: Lark Channel Adapter

The first external messaging channel. Implemented as a built-in channel plugin.

### Lark Bot Architecture

```
Lark Platform
    │
    │  HTTP webhook (POST)
    ▼
┌─────────────────────────────┐
│  channel-lark plugin         │
│                             │
│  POST /channels/lark/webhook │
│      │                      │
│      ▼                      │
│  1. Verify signature         │  ← Lark sends verification token
│  2. Handle challenge         │  ← Lark URL verification handshake
│  3. Parse event type         │
│      │                      │
│      ├─ im.message.receive   │  ← User sent a message
│      │   → parseInbound()    │
│      │   → ChannelMessage    │
│      │                      │
│      ├─ p2p.chat.create      │  ← User started a DM
│      │   → create session    │
│      │                      │
│      └─ im.chat.member@bot   │  ← Bot added to group
│          → register group    │
│                             │
│  sendOutbound():             │
│  Lark API POST /im/v1/messages
│  - Formats markdown/rich text│
│  - Chunks long messages      │
│  - Uploads images/files      │
└─────────────────────────────┘
```

### Message Flow: Lark → Agent → Lark

```
1. User @mentions bot in Lark group (or sends DM)
2. Lark sends webhook POST to /channels/lark/webhook
3. LarkAdapter.verifyAuth() — checks verification token
4. LarkAdapter.parseInbound() — extracts:
   - channelType: 'lark'
   - channelId: chat_id (group) or user_id (DM)
   - userId: sender's Lark open_id → mapped to NovoHaven user
   - threadId: message thread (if threaded reply)
   - content: { text: stripped @mention text, attachments: [...] }
5. Gateway SessionManager resolves/creates session
6. Gateway AgentSupervisor routes to agent process
7. Agent processes turn, streams response chunks via IPC
8. Gateway receives chunks → LarkAdapter.sendOutbound()
9. LarkAdapter formats for Lark API:
   - Markdown → Lark rich text format
   - Long messages → chunked into multiple messages
   - Images → uploaded to Lark then linked
   - Approval requests → Lark interactive cards with buttons
10. User sees response in Lark
```

### Lark-Specific Features

| Feature | Implementation |
|---|---|
| @mention detection | Strip `@BotName` prefix from group messages |
| Thread support | Use Lark's `root_id` for threaded replies → maps to `threadId` in session |
| Interactive cards | Approval requests rendered as Lark message cards with action buttons |
| File sharing | User sends files → downloaded, passed to agent as attachments |
| User mapping | Lark `open_id` → `users` table mapping (auto-create or manual link) |
| Rate limiting | Queue outbound messages to respect Lark API rate limits |

### OpenClaw Channel Adapter Mapping

| OpenClaw Concept | OpenClaw (e.g., WhatsApp adapter) | NovoHaven Lark Adapter |
|---|---|---|
| Authentication | QR pairing (WhatsApp) | Lark app credentials (appId, appSecret, verificationToken) |
| Inbound parsing | Extract text, media, thread context | Parse Lark webhook events → ChannelMessage |
| Access control | DM pairing flow, allowlists | Lark user → NovoHaven user mapping + role check |
| Outbound formatting | Platform markdown, message chunking | Lark rich text, card messages, chunking |
| Group handling | Mention requirement in groups | @mention detection, group chat registration |
