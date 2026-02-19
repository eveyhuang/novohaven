# NovoHaven Developer Guidelines

> A reference for team members and code reviewers.
> **Stack**: React 18 + TypeScript + Tailwind | Node.js + Express + TypeScript | SQLite (better-sqlite3)

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Project Structure](#2-project-structure)
3. [System Architecture](#3-system-architecture)
4. [Plugin System](#4-plugin-system)
5. [Agent Runtime](#5-agent-runtime)
6. [Naming Conventions](#6-naming-conventions)
7. [TypeScript Guidelines](#7-typescript-guidelines)
8. [Backend (Server)](#8-backend-server)
9. [Frontend (Client)](#9-frontend-client)
10. [Styling (Tailwind)](#10-styling-tailwind)
11. [API Contract](#11-api-contract)
12. [Error Handling](#12-error-handling)
13. [Database](#13-database)
14. [Testing](#14-testing)
15. [i18n (Internationalization)](#15-i18n-internationalization)
16. [Environment & Secrets](#16-environment--secrets)
17. [Git & Code Review](#17-git--code-review)
18. [Common Pitfalls](#18-common-pitfalls)

---

## 1. Quick Start

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# 1. Clone & enter the repo
git clone <repo-url> && cd novohaven-app

# 2. Environment variables
cp .env.example .env
# Edit .env — add your own API keys (see Section 16)

# 3. Install & run server
cd server && npm install && npm run dev
# → http://localhost:3001

# 4. Install & run client (separate terminal)
cd client && npm install && npm start
# → http://localhost:3000
```

### Demo Login

The MVP uses mock auth. Any password works with `demo@novohaven.com`.

### Useful Commands

| Command | Location | Purpose |
|---------|----------|---------|
| `npm run dev` | `server/` | Start server with hot-reload (ts-node-dev) |
| `npm start` | `client/` | Start React dev server (CRA) |
| `npm run build` | `server/` | Compile TypeScript → `dist/` |
| `npm run build` | `client/` | Production build → `build/` |
| `npm test` | `server/` | Run Jest tests |
| `npm test` | `client/` | Run CRA tests |

---

## 2. Project Structure

```
novohaven-app/
├── client/                              # React 18 + TypeScript frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── AgentChat/               # Web channel chat interface (SSE streaming)
│   │   │   ├── SessionMonitor/          # Active session monitoring dashboard
│   │   │   ├── PluginManager/           # Plugin configuration UI
│   │   │   ├── SkillDraftReview/        # Approve/reject agent-proposed skills
│   │   │   ├── Dashboard/              # Landing page with agent health panel
│   │   │   ├── TemplateEditor/          # Skill editor (single-task)
│   │   │   ├── RecipeBuilder/           # Workflow editor + runner
│   │   │   ├── ChatExecution/           # Workflow execution chat UI
│   │   │   ├── WorkflowExecution/       # Execution list + detail views
│   │   │   ├── WorkflowBuilder/         # AI-powered workflow generator
│   │   │   ├── CompanyStandards/        # Brand standards CRUD
│   │   │   ├── OutputsGallery/          # Output browser
│   │   │   └── common/                  # Reusable UI primitives (Button, Card, Modal, Input…)
│   │   ├── context/                     # React Context providers (Auth, Language, Notification)
│   │   ├── hooks/                       # Custom hooks (useTranslatedText)
│   │   ├── i18n/                        # Translation dictionaries (en/zh)
│   │   ├── services/                    # API client (fetch-based), translation service
│   │   ├── types/                       # Shared TypeScript types
│   │   ├── App.tsx                      # Root component + route definitions
│   │   └── index.tsx                    # React entry point
│   ├── tailwind.config.js
│   └── tsconfig.json
│
├── server/                              # Node.js + Express backend
│   ├── src/
│   │   ├── gateway/                     # Gateway Control Plane
│   │   │   ├── sessionManager.ts        # Session lifecycle + message history
│   │   │   ├── channelRouter.ts         # Routes channel plugins to agent supervisor
│   │   │   └── agentSupervisor.ts       # Spawns/manages agent child processes
│   │   ├── agent/                       # Agent Runtime (per-session process)
│   │   │   ├── process.ts               # Child process entry point (IPC bridge)
│   │   │   ├── AgentRunner.ts           # 5-step agentic loop
│   │   │   ├── PromptBuilder.ts         # Multi-layer context assembly
│   │   │   └── ToolExecutor.ts          # Tool call dispatch to plugins
│   │   ├── plugins/                     # Plugin System
│   │   │   ├── types.ts                 # Plugin interfaces (4 types)
│   │   │   ├── registry.ts              # Plugin registry singleton
│   │   │   ├── loader.ts                # Manifest-based plugin discovery
│   │   │   ├── builtin/                 # Built-in plugins (ship with core)
│   │   │   │   ├── channel-web/         # Web UI channel (REST + SSE)
│   │   │   │   ├── channel-lark/        # Lark bot channel (webhooks)
│   │   │   │   ├── provider-anthropic/  # Claude models
│   │   │   │   ├── provider-openai/     # GPT models
│   │   │   │   ├── provider-google/     # Gemini models
│   │   │   │   ├── tool-skill-manager/  # Skill CRUD tools for agents
│   │   │   │   ├── tool-browser/        # Browser automation
│   │   │   │   ├── tool-bash/           # Shell execution
│   │   │   │   ├── tool-fileops/        # File read/write
│   │   │   │   └── memory-sqlite-vec/   # Vector search (sqlite-vec)
│   │   │   └── community/              # User-installed plugins (gitignored)
│   │   ├── routes/                      # Express routers
│   │   ├── services/                    # Business logic (aiService, workflowEngine, …)
│   │   ├── executors/                   # Step executor plugin system (workflow steps)
│   │   │   ├── StepExecutor.ts          # Interface + types
│   │   │   ├── registry.ts             # Executor registry (Map-based)
│   │   │   ├── AIExecutor.ts
│   │   │   ├── ScrapingExecutor.ts
│   │   │   ├── ScriptExecutor.ts
│   │   │   ├── HttpExecutor.ts
│   │   │   └── TransformExecutor.ts
│   │   ├── models/
│   │   │   └── database.ts             # Schema, migrations, seeds (better-sqlite3)
│   │   ├── middleware/                  # Auth middleware
│   │   ├── types/
│   │   │   └── index.ts                # Server-side type definitions
│   │   ├── __tests__/                   # Jest tests
│   │   └── index.ts                     # Express entry point + gateway wiring
│   ├── data/                            # SQLite database file
│   ├── jest.config.js
│   └── tsconfig.json
│
├── docs/plans/                          # Architecture design documents
├── .env.example                         # Environment variable template
├── .gitignore
└── README.md
```

### Organizing Principles

- **Feature-based folders on the frontend** — each UI feature gets its own directory under `components/` with an `index.ts` barrel export.
- **Layer-based folders on the backend** — separated into `gateway/`, `agent/`, `plugins/`, `routes/`, `services/`, `executors/`, `models/`, `types/`.
- **Plugin-per-directory** — each plugin lives in its own directory under `plugins/builtin/` or `plugins/community/` with a `manifest.json` and entry point.
- **One barrel export per feature folder** — `index.ts` re-exports the main component(s).
- **Types are centralized** — a single `types/index.ts` per side (client + server). Don't scatter interfaces across files. Plugin types live in `plugins/types.ts`.

---

## 3. System Architecture

### High-Level Data Flow

```
User (Web UI or Lark)
  │
  ▼
Channel Plugin (channel-web or channel-lark)
  │ parseInbound() → ChannelMessage
  ▼
Gateway Control Plane (Express, port 3001)
  ├─ Channel Router → routes to message handler
  ├─ Session Manager → resolves/creates session
  └─ Agent Supervisor → spawns/reuses agent child process
       │
       │ IPC (child_process.fork)
       ▼
Agent Process (isolated, one per session)
  ├─ AgentRunner (5-step loop)
  ├─ PromptBuilder (multi-layer context assembly)
  ├─ ToolExecutor (dispatch to tool plugins)
  └─ Provider Plugin (stream LLM response)
       │
       │ IPC response back to gateway
       ▼
Agent Supervisor → Channel Plugin.sendOutbound()
  │
  ▼
User sees response
```

### Gateway Control Plane

The gateway is the central nervous system. The Express server (`server/src/index.ts`) acts as the control plane with three core components:

| Component | File | Purpose |
|-----------|------|---------|
| **Session Manager** | `gateway/sessionManager.ts` | Maps `(channelType, userId, threadId)` → session. Creates sessions on first contact. Persists messages. |
| **Channel Router** | `gateway/channelRouter.ts` | Mounts each channel plugin's routes under `/channels/<name>/`. Routes inbound messages to agent supervisor. |
| **Agent Supervisor** | `gateway/agentSupervisor.ts` | Spawns agent child processes per session. Routes IPC messages. Enforces max concurrency (default 10). Idle timeout (10 min). |

### Server Startup Sequence

```typescript
// server/src/index.ts — simplified
async function start() {
  initializeDatabase();          // 1. Schema + migrations + seeds
  await loadAllPlugins();        // 2. Discover and initialize all plugins
  const sessionManager = new SessionManager();
  const supervisor = new AgentSupervisor({ sessionManager, onResponse });
  const channelRouter = createChannelRouter(supervisor.routeMessage);
  app.use('/channels', channelRouter);
  supervisor.start();            // 3. Start idle agent cleanup timer
  app.listen(PORT);
}
```

### IPC Protocol (Agent ↔ Gateway)

```typescript
// Gateway → Agent
type GatewayToAgent =
  | { type: 'message'; sessionId: string; message: ChannelMessage }
  | { type: 'approval_response'; requestId: string; approved: boolean; data?: any }
  | { type: 'shutdown' }

// Agent → Gateway
type AgentToGateway =
  | { type: 'stream_chunk'; sessionId: string; content: string }
  | { type: 'response_complete'; sessionId: string; content: string }
  | { type: 'approval_request'; sessionId: string; requestId: string; prompt: string }
  | { type: 'heartbeat' }
  | { type: 'error'; sessionId: string; error: string }
```

### Skills and Workflows

**Skills** (formerly Templates) and **Workflows** (formerly Recipes) serve a dual role:

1. **Searchable Knowledge** — indexed by name/description/tags so the agent can discover them per-turn
2. **Executable Pipelines** — multi-step workflows run through the workflow engine with specific models, prompts, and executor configs per step

When a user asks "analyze reviews for this product," the agent:
1. Searches for relevant skills → finds "Product Review Analyzer"
2. Asks user for any missing inputs
3. Spawns a workflow execution through the engine
4. Streams results back to the user

### Agent Self-Healing

When a skill fails, the agent can diagnose and propose fixes:
- `skill:test` — run with test inputs and inspect output
- `skill:validate` — check for missing variables, bad configs
- `skill:edit` — propose modifications (creates a **draft** requiring human approval)

All agent-proposed changes go through the `skill_drafts` table and require explicit approval via the Skill Draft Review UI.

---

## 4. Plugin System

The plugin system ensures the core never changes when adding capabilities. All plugins follow the same lifecycle: `manifest.json` → `loader.ts` discovers → `initialize(config)` → `registry.ts` registers.

### Four Plugin Types

| Type | Interface | How Used | Built-in Plugins |
|------|-----------|----------|------------------|
| **Channel** | `ChannelPlugin` | Mounted by ChannelRouter, parse/send platform messages | `channel-web`, `channel-lark` |
| **Tool** | `ToolPlugin` | Called by agent ToolExecutor during LLM tool calls | `tool-skill-manager`, `tool-browser`, `tool-bash`, `tool-fileops` |
| **Memory** | `MemoryPlugin` | Called by PromptBuilder for skill search, by ToolExecutor for memory | `memory-sqlite-vec` |
| **Provider** | `ProviderPlugin` | Called by AgentRunner to stream LLM completions | `provider-anthropic`, `provider-openai`, `provider-google` |

### Plugin Directory Layout

```
server/src/plugins/
  types.ts                    # All plugin interfaces
  registry.ts                 # Singleton registry
  loader.ts                   # Discovery + loading
  builtin/
    <plugin-name>/
      manifest.json           # Declares type, config schema, entry point
      index.ts                # Implementation (default export = class)
  community/                  # User plugins (gitignored)
```

### Creating a New Plugin

**1. Create directory and manifest:**

```json
// server/src/plugins/builtin/tool-my-thing/manifest.json
{
  "name": "tool-my-thing",
  "version": "1.0.0",
  "type": "tool",
  "displayName": "My Thing",
  "description": "What it does",
  "entry": "./index.ts",
  "config": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "description": "API key", "secret": true }
    },
    "required": ["apiKey"]
  }
}
```

The `config` property uses JSON Schema and drives both validation at load time and auto-generated config forms in the Plugin Manager UI.

**2. Implement the interface:**

```typescript
// server/src/plugins/builtin/tool-my-thing/index.ts
import { ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult } from '../../types';

export default class MyThingPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private apiKey: string = '';

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.apiKey = config.apiKey || process.env.MY_THING_API_KEY || '';
  }

  async shutdown(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'my-thing:action',
      description: 'Performs the action',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'The input' }
        },
        required: ['input']
      }
    }];
  }

  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    // Implementation
    return { success: true, output: 'Done' };
  }
}
```

**3. Plugin config in DB** (optional — auto-discovered from manifest):

Plugin configs can be managed via `PUT /api/plugins/:name` or the Plugin Manager UI. The `plugin_configs` table stores enable/disable state and config JSON.

### Channel Plugin Specifics

Channel plugins implement `registerRoutes(router)` to mount webhook/message endpoints. They're wired to the agent supervisor via `setMessageHandler()`:

```typescript
export default class MyChannelPlugin implements ChannelPlugin {
  private messageHandler?: (msg: ChannelMessage) => Promise<void>;

  registerRoutes(router: Router): void {
    router.post('/webhook', (req, res) => {
      const message = this.parseInbound(req);
      if (message && this.messageHandler) {
        this.messageHandler(message);
      }
      res.status(200).json({ ok: true });
    });
  }

  setMessageHandler(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  parseInbound(req: Request): ChannelMessage | null {
    return {
      channelType: 'my-channel',
      channelId: req.body.chatId,
      userId: req.body.userId,
      content: { text: req.body.text },
      timestamp: new Date()
    };
  }

  async sendOutbound(channelId: string, response: AgentResponse): Promise<void> {
    // Send response back to the platform
  }
}
```

### Provider Plugin Specifics

Provider plugins implement `stream()` as an async generator yielding `StreamEvent` objects:

```typescript
async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
  // Call LLM API with streaming
  for await (const chunk of apiStream) {
    if (chunk.type === 'text') {
      yield { type: 'text', text: chunk.text };
    }
    if (chunk.type === 'tool_use') {
      yield { type: 'tool_call', toolCall: { id: chunk.id, name: chunk.name, args: chunk.args } };
    }
  }
  yield { type: 'done' };
}
```

---

## 5. Agent Runtime

### Agent Process Lifecycle

1. **AgentSupervisor** spawns a child process via `child_process.fork('agent/process.ts')`
2. **process.ts** creates an `AgentRunner` instance and listens for IPC messages
3. On each user message, `AgentRunner.handleTurn()` runs the 5-step loop
4. Responses stream back to the gateway via `process.send()`
5. After idle timeout (10 min), the supervisor sends `{ type: 'shutdown' }` and kills the process

### AgentRunner Loop (per turn)

```typescript
class AgentRunner {
  async handleTurn(message: ChannelMessage): Promise<void> {
    // 1. Resolve session — load from sessions + session_messages tables
    // 2. Assemble context — PromptBuilder layers 6 sources
    // 3. Stream LLM — call provider plugin with tools
    // 4. Execute tool calls — dispatch via ToolExecutor
    //    (loop: if LLM returns tool_call, execute and feed result back, up to 10 rounds)
    // 5. Persist state — append messages to session_messages
  }
}
```

### PromptBuilder — 6-Layer Context Assembly

The system prompt is assembled per-turn from:

1. **Agent personality** — from `agent_configs.system_prompt` in DB
2. **Available tools** — auto-generated from registered tool plugins
3. **Relevant skills** — found via skill search (keyword-based, vector search planned)
4. **Active execution context** — if a workflow is currently running
5. **Company standards** — if referenced by an active skill
6. **Session history** — last N messages from `session_messages` table

### ToolExecutor

Routes LLM tool calls to the appropriate handler:
- `skill:*` tools → delegated to `tool-skill-manager` plugin
- `approval:request` → handled internally (sends IPC to gateway)
- Everything else → matched against registered tool plugin names

### Adding New Agent Tools

1. Create a new tool plugin (see Section 4)
2. Register it in `plugins/builtin/` with a manifest
3. The ToolExecutor automatically aggregates tools from all registered plugins
4. The PromptBuilder includes tool definitions in the system prompt

---

## 6. Naming Conventions

### Terminology

| Old Term | New Term | Usage |
|----------|----------|-------|
| Template (`is_template=1`) | **Skill** | A reusable, single-purpose AI capability |
| Recipe (`is_template=0`) | **Workflow** | A multi-step composed pipeline |
| Recipe Step | **Skill Step** | A step within a skill or workflow |

### Files

| What | Pattern | Example |
|------|---------|---------|
| React component | `PascalCase.tsx` | `AgentChat.tsx`, `SessionMonitor.tsx` |
| Custom hook | `camelCase.ts` | `useTranslatedText.ts` |
| Service / utility | `camelCase.ts` | `api.ts`, `translationService.ts` |
| Gateway module | `camelCase.ts` | `sessionManager.ts`, `channelRouter.ts` |
| Agent module | `PascalCase.ts` | `AgentRunner.ts`, `PromptBuilder.ts` |
| Plugin entry | `index.ts` | `plugins/builtin/channel-web/index.ts` |
| Plugin manifest | `manifest.json` | `plugins/builtin/channel-web/manifest.json` |
| Executor class | `PascalCase.ts` | `AIExecutor.ts`, `HttpExecutor.ts` |
| Route file | `camelCase.ts` | `skills.ts`, `sessions.ts` |
| Context provider | `PascalCase.tsx` | `AuthContext.tsx`, `LanguageContext.tsx` |
| Test file | `*.test.ts` | `registry.test.ts` |
| Type barrel | `index.ts` | `types/index.ts` |

### Code Identifiers

| Context | Style | Example |
|---------|-------|---------|
| Variables, functions, parameters | `camelCase` | `sessionId`, `loadSkills()`, `isLoading` |
| React components | `PascalCase` | `AgentChat`, `PluginManager` |
| Interfaces, types | `PascalCase` | `Skill`, `ChannelMessage`, `ProviderPlugin` |
| Constants | `UPPER_SNAKE_CASE` | `AI_MODELS`, `COLUMN_MAPPINGS` |
| Database columns | `snake_case` | `session_id`, `step_order`, `created_at` |
| Plugin names | `kebab-case` | `channel-web`, `provider-anthropic`, `tool-bash` |
| Tool names | `namespace:action` | `skill:search`, `browser:navigate`, `bash:execute` |
| CSS classes | Tailwind utilities | `bg-primary-600`, `text-secondary-900` |
| Boolean vars/props | `is`/`has`/`can` prefix | `isLoading`, `hasError`, `canEdit` |
| Callbacks (props) | `on` prefix | `onChange`, `onClose`, `onDelete` |

### Type Naming Suffixes

| Suffix | When to use | Example |
|--------|-------------|---------|
| `Config` | Configuration objects | `AIServiceConfig`, `HttpConfig` |
| `Request` | Incoming API payloads | `CompletionRequest`, `CreateSkillRequest` |
| `Response` | Outgoing API payloads | `AgentResponse`, `ScrapingResponse` |
| `Result` | Operation return values | `ToolResult`, `SearchResult` |
| `Entry` | Items for indexing/storage | `SkillIndexEntry`, `MemoryEntry` |
| `Event` | Stream/IPC events | `StreamEvent`, `ExecutionChatMessage` |
| `Definition` | Schema/spec objects | `ToolDefinition` |
| `WithSteps`, `WithDetails` | Extended join types | `SkillWithSteps`, `WorkflowExecutionWithDetails` |
| `Plugin` | Plugin interface implementations | `ChannelPlugin`, `ToolPlugin` |
| `Manifest` | Plugin manifest type | `PluginManifest` |

---

## 7. TypeScript Guidelines

### Compiler Settings (both sides)

- **Strict mode is ON** — do not disable it.
- **Target**: ES2020 — safe to use `?.`, `??`, `Promise.allSettled`, etc.
- Client uses `"jsx": "react-jsx"` (no `import React` needed).
- Client `baseUrl` is `src` — import as `services/api`, not `../../services/api`.

### Do's

```typescript
// Prefer string union types over enums
type SessionStatus = 'active' | 'idle' | 'closed';
type PluginType = 'channel' | 'tool' | 'memory' | 'provider';

// Extend interfaces for joined/enriched models
interface SkillWithSteps extends Skill {
  steps: SkillStep[];
}

// Use Omit/Pick for request types derived from models
type CreateSkillPayload = Omit<Skill, 'id' | 'created_at' | 'updated_at'>;

// Type route handler params explicitly
router.get('/:id', (req: Request, res: Response) => { ... });

// Use AsyncIterable for streaming
async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> { ... }
```

### Don'ts

```typescript
// Don't use `any` without justification — prefer `unknown` or a specific type
const data: any = response.body;          // BAD
const data: Record<string, unknown> = ... // BETTER

// Don't use enums (we use string unions project-wide)
enum Status { Pending, Running }          // BAD — not used in this project

// Don't create parallel type definitions — reuse from types/index.ts
// Plugin types go in plugins/types.ts, not scattered across plugin files
```

### JSON-Stored Fields

Several DB columns store serialized JSON (`input_config`, `model_config`, `executor_config`, `config`, `tool_calls`, `tool_results`, `tags`, `steps`). The type system marks these as `string` in the DB model but they should be parsed to their typed shape when used:

```typescript
// DB layer — string
interface PluginConfig {
  config: string;  // JSON string
}

// Usage — parse and type-check
const config: Record<string, any> = JSON.parse(pluginConfig.config || '{}');
```

---

## 8. Backend (Server)

### Entry Point (`server/src/index.ts`)

Initialization sequence:

1. Load environment variables from `.env`
2. Set up Express with CORS, JSON body parser, request logger
3. Mount API routes (`/api/*`)
4. Initialize database (synchronous — better-sqlite3)
5. Load all plugins (async — discovers and initializes)
6. Initialize gateway components (SessionManager, AgentSupervisor, ChannelRouter)
7. Mount channel routes (`/channels/*`)
8. Start listening on PORT

### Routes

**Pattern**: Thin route handlers that delegate to services.

```typescript
router.post('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Skill name is required' });
      return;
    }
    const result = run(
      'INSERT INTO skills (name, description, created_by) VALUES (?, ?, ?)',
      [name, description, (req as any).user.id]
    );
    res.status(201).json({ id: result.lastInsertRowid, name, description });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

**Rules**:
- All routes require `authMiddleware` (MVP: demo user).
- Validate required fields at the top — return `400` early.
- Wrap in `try/catch` — return `500` for unexpected errors.
- Use correct HTTP status codes (see [Section 12](#12-error-handling)).
- Don't put business logic in route handlers — call services.

### Route Groups

| Group | Prefix | Purpose |
|-------|--------|---------|
| Skills | `/api/skills` | CRUD for skills (formerly templates) |
| Workflows | `/api/workflows` | CRUD for workflows (formerly recipes) |
| Skill Drafts | `/api/skillDrafts` | Review agent-proposed changes |
| Sessions | `/api/sessions` | Monitor active agent sessions |
| Agents | `/api/agents` | Manage agent configurations |
| Plugins | `/api/plugins` | List and configure plugins |
| Executions | `/api/executions` | Workflow execution lifecycle |
| Standards | `/api/standards` | Company brand standards |
| AI | `/api/ai` | AI model listing, provider status |
| Outputs | `/api/outputs` | Browse execution outputs |
| Usage | `/api/usage` | API usage tracking |
| Recipes | `/api/recipes` | Legacy (backward compat) |

### Channel Routes

| Channel | Prefix | Endpoints |
|---------|--------|-----------|
| Web | `/channels/channel-web` | `POST /message`, `GET /stream` (SSE) |
| Lark | `/channels/channel-lark` | `POST /webhook` |

### Services

**Pattern**: Pure functions or modules that return result objects, never throw for expected failures.

```typescript
// Return shape for service operations
{ success: true, content: "...", model: "gpt-4o", usage: { ... } }
{ success: false, content: "", error: "API key not configured" }
```

**Key services**:

| Service | Purpose |
|---------|---------|
| `aiService.ts` | Multi-provider AI abstraction (legacy — providers now also available as plugins) |
| `workflowEngine.ts` | Workflow orchestration with human-in-the-loop |
| `promptParser.ts` | Variable extraction + prompt compilation |
| `workflowAssistant.ts` | AI-powered workflow generation from chat |
| `brightDataService.ts` | E-commerce review scraping |
| `csvParserService.ts` | CSV parsing + export |
| `usageTrackingService.ts` | API usage logging + billing |

**Rules**:
- Services should be stateless — don't store mutable state at module scope (exception: lazy-initialized API clients).
- Log with context: `console.error('[ServiceName] Description:', error.message)`.
- Use result objects, not exceptions, for expected failures.

### Step Executor System (Workflow Steps)

The executor system handles individual steps within workflow executions. This is separate from the agent's tool system.

**To add a new step executor:**

1. Create `server/src/executors/MyExecutor.ts` implementing `StepExecutor`:

```typescript
import { StepExecutor, StepExecutorContext, StepExecutorResult, ExecutorConfigSchema } from './StepExecutor';

export class MyExecutor implements StepExecutor {
  type = 'my_type';
  displayName = 'My Executor';
  icon = '🔧';
  description = 'Does something useful';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    return { success: true, content: 'result' };
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        { name: 'option', label: 'Option', type: 'text', required: true }
      ]
    };
  }
}
```

2. Register in `server/src/executors/registry.ts`:

```typescript
import { MyExecutor } from './MyExecutor';
registerExecutor(new MyExecutor());
```

3. Add the step type to the `StepType` union in both `server/src/types/index.ts` and `client/src/types/index.ts`.

---

## 9. Frontend (Client)

### React Patterns

- **Functional components only** — no class components.
- **Hooks for all state and effects** — `useState`, `useEffect`, `useContext`, `useMemo`, `useRef`.
- **No external state management** — use React Context for shared state, local `useState` for component state.

### Component Structure

```typescript
// components/FeatureName/FeatureName.tsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Button, Card } from '../common';
import { api } from '../../services/api';
import { Skill } from '../../types';

interface FeatureNameProps {
  // explicit props interface — always define it
}

export const FeatureName: React.FC<FeatureNameProps> = ({ ... }) => {
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await api.getSkills();
      // ...
    } catch (error) {
      console.error('Failed to load:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* JSX */}
    </div>
  );
};
```

### Routing

Routes are defined in `App.tsx` using React Router v6:

```
/                   → Dashboard (with agent health panel)
/chat               → AgentChat (web channel agent conversation)
/skills/new         → SkillEditor (create)
/skills/:id         → SkillEditor (edit)
/workflows/new      → WorkflowBuilder (create)
/workflows/:id      → WorkflowBuilder (edit)
/workflows/:id/run  → WorkflowRunner
/executions         → ExecutionList
/executions/:id     → ExecutionDetail
/sessions           → SessionMonitor
/plugins            → PluginManager
/drafts             → SkillDraftReview
/outputs            → OutputsGallery
/standards          → CompanyStandards
/usage              → UsageDashboard
```

### Context Usage

Three contexts are available app-wide:

```typescript
const { user, isAuthenticated, login, logout } = useAuth();
const { language, setLanguage, t } = useLanguage();
const { addNotification, trackExecution } = useNotifications();
```

### API Calls

Use the singleton `api` client from `services/api.ts`:

```typescript
import { api } from '../services/api';

// All methods are typed and return parsed JSON
const skills = await api.getSkills();
const skill = await api.getSkill(id);
await api.createSkill({ name, description, steps });
```

**Don't** use `fetch` directly — always go through the `api` client for auth headers and consistent error handling.

### Key UI Components

| Component | Purpose |
|-----------|---------|
| `AgentChat` | Web channel messaging — SSE streaming, session history sidebar |
| `SessionMonitor` | Admin view of active sessions across all channels |
| `PluginManager` | Plugin enable/disable toggles, auto-generated config forms |
| `SkillDraftReview` | Review agent-proposed skill edits with diff view |
| `ChatExecution` | Workflow execution chat UI with message types |
| `Dashboard` | Landing page with agent health panel |

### Common Components Reference

| Component | Location | Props | Purpose |
|-----------|----------|-------|---------|
| `Button` | `common/Button.tsx` | `variant`, `size`, `isLoading` | Primary action button |
| `Card` | `common/Card.tsx` | `hoverable`, `onClick` | Container with optional header/body/footer |
| `Input` | `common/Input.tsx` | `label`, `error`, `helperText` | Form input, also exports `TextArea`, `Select` |
| `Modal` | `common/Modal.tsx` | `isOpen`, `onClose`, `title`, `size` | Dialog overlay |
| `ExecutorConfigFields` | `common/ExecutorConfigFields.tsx` | `stepType`, `executors`, `executorConfig` | Dynamic form for executor config |
| `DynamicInput` | `common/DynamicInput.tsx` | field config object | Type-aware input renderer |

---

## 10. Styling (Tailwind)

### Theme

Custom color scales are defined in `tailwind.config.js`:

- **`primary-*`** — Sky blue (`#0ea5e9` at 500). Use for actions, links, active states.
- **`secondary-*`** — Slate gray (`#64748b` at 500). Use for text, borders, backgrounds.

Fonts:
- **Sans**: Inter, system-ui, sans-serif
- **Mono**: JetBrains Mono, monospace

### Usage Rules

1. **Use Tailwind utilities** — no external CSS files, no CSS modules, no styled-components.

2. **Use the `primary-*` / `secondary-*` scales** — don't hardcode hex colors.

```html
<!-- Good -->
<button className="bg-primary-600 hover:bg-primary-700 text-white">

<!-- Bad — hardcoded color -->
<button className="bg-[#0284c7] text-white">
```

3. **Responsive grid pattern** — mobile-first, use breakpoints:

```html
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
```

4. **Spacing** — use Tailwind's spacing scale consistently. `space-y-4` for vertical spacing between children, `p-6` for padding, `gap-4` for grid/flex gaps.

5. **States**: `hover:`, `focus:`, `disabled:` prefixes.

6. **Custom utilities** are defined in `src/index.css` under `@layer`.

---

## 11. API Contract

### Base URL

```
http://localhost:3001/api       (REST API)
http://localhost:3001/channels  (Channel webhooks/streams)
```

### Response Shapes

**Success** (single item):
```json
{ "id": 1, "name": "My Skill", "description": "..." }
```

**Success** (collection):
```json
[{ "id": 1, ... }, { "id": 2, ... }]
```

**Error**:
```json
{ "error": "Human-readable error message" }
```

### Status Codes

| Code | Meaning | When |
|------|---------|------|
| `200` | OK | Successful GET/PUT |
| `201` | Created | Successful POST (create) |
| `400` | Bad Request | Missing/invalid input |
| `401` | Unauthorized | No/invalid auth token |
| `404` | Not Found | Resource doesn't exist |
| `500` | Server Error | Unhandled exception |

### SSE Stream Format (Web Channel)

The web channel streams agent responses via Server-Sent Events:

```
GET /channels/channel-web/stream?sessionId=<uuid>

event: message
data: {"type":"stream_chunk","content":"Hello"}

event: message
data: {"type":"response_complete","content":"Hello, how can I help?"}
```

---

## 12. Error Handling

### Backend — Three Layers

**1. Service layer** — return result objects, don't throw:

```typescript
return {
  success: false,
  content: '',
  model,
  error: error.message || 'API call failed'
};
```

**2. Route layer** — validate input, try/catch, return HTTP errors:

```typescript
router.post('/', (req, res) => {
  try {
    if (!req.body.name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    const result = service.doWork(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

**3. Global error handler** — catches anything that slips through:

```typescript
app.use((err: Error, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});
```

### Plugin Error Handling

Plugin `initialize()` failures are caught by the loader and logged, but don't prevent other plugins from loading:

```typescript
try {
  await loadPlugin(pluginPath);
} catch (err) {
  console.error(`[PluginLoader] Failed to load plugin at ${pluginPath}:`, err);
  // Other plugins continue loading
}
```

### Agent Process Error Handling

Agent child processes catch errors per-turn and report via IPC:

```typescript
try {
  await runner.handleTurn(msg.message);
} catch (err: any) {
  process.send!({ type: 'error', sessionId, error: err.message });
}
```

The AgentSupervisor restarts crashed agents automatically when the next message arrives.

### Frontend

```typescript
try {
  const data = await api.someMethod();
} catch (error) {
  console.error('Context for the error:', error);
  addNotification({ type: 'error', message: 'User-friendly message' });
}
```

---

## 13. Database

### Engine

- **better-sqlite3** — native SQLite binding, file-based, auto-persists.
- **WAL mode** — enabled for concurrent reads from agent child processes.
- **Synchronous API** — no `async/await` needed for queries.
- **File persistence** — saves to `server/data/novohaven.db`.

### Schema at a Glance

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `users` | User accounts | `id`, `email`, `password_hash` |
| `skills` | Reusable AI capabilities | `id`, `name`, `status`, `tags`, `created_by` |
| `workflows` | Multi-step pipelines | `id`, `name`, `status`, `tags`, `created_by` |
| `skill_steps` | Steps within skills/workflows | `parent_id`, `parent_type`, `step_order`, `prompt_template`, `executor_config` |
| `sessions` | Agent conversation sessions | `id` (UUID), `channel_type`, `channel_id`, `user_id`, `agent_pid`, `status` |
| `session_messages` | Conversation history | `session_id`, `role`, `content`, `tool_calls`, `tool_results` |
| `agent_configs` | Per-agent settings | `name`, `default_model`, `system_prompt`, `allowed_tools`, `allowed_channels` |
| `plugin_configs` | Plugin config + enable/disable | `plugin_name`, `plugin_type`, `enabled`, `config` |
| `skill_drafts` | Agent-proposed edits | `original_skill_id`, `skill_type`, `steps`, `change_summary`, `status` |
| `workflow_executions` | Running/completed workflows | `recipe_id`, `status`, `input_data` |
| `step_executions` | Individual step results | `execution_id`, `status`, `output_data` |
| `company_standards` | Brand voice/guidelines | `user_id`, `standard_type`, `content` |
| `api_usage` | API call tracking | `service`, `request_count`, `records_fetched` |
| `recipes` | Legacy (preserved) | `id`, `name`, `is_template`, `created_by` |
| `recipe_steps` | Legacy (preserved) | `recipe_id`, `step_order`, `step_type` |

### Query Pattern

Use the helper functions exported from `database.ts`:

```typescript
import { getOne, getAll, run } from '../models/database';

// Synchronous — no await needed
const skill = getOne('SELECT * FROM skills WHERE id = ?', [id]);
const steps = getAll('SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ?', [id, 'skill']);
run('INSERT INTO skills (name, description) VALUES (?, ?)', [name, description]);
```

### Column Naming

Database columns use `snake_case` consistently: `session_id`, `step_order`, `created_at`, `parent_type`.

### Migrations

Schema changes are applied in `initializeDatabase()` using `CREATE TABLE IF NOT EXISTS` and a `runMigrations()` function that checks for existing tables before migrating. There is no separate migration framework — changes are applied on startup.

---

## 14. Testing

### Server

- **Framework**: Jest + ts-jest
- **Location**: `server/src/__tests__/`
- **Pattern**: `__tests__/**/*.test.ts`
- **Run**: `cd server && npm test`

### Client

- **Framework**: Jest via react-scripts (CRA default)
- **Run**: `cd client && npm test`

### What to Test

- **Gateway**: Test SessionManager session resolution, message persistence.
- **Agent**: Test PromptBuilder context assembly, ToolExecutor routing.
- **Plugins**: Test `initialize()`, tool execution, provider streaming.
- **Services**: Unit test business logic, mock external API calls.
- **Executors**: Test `validateConfig()` and `execute()` with mock contexts.
- **Route handlers**: Integration test request/response cycles.
- **Components**: Test user interactions and rendered output (React Testing Library).

---

## 15. i18n (Internationalization)

### Supported Languages

- **English** (`en`) — default
- **Chinese** (`zh`)

### Architecture

1. **Static UI strings** — translation dictionary in `client/src/i18n/translations.ts`:

```typescript
const { t } = useLanguage();
<h1>{t('dashboardTitle')}</h1>
```

2. **Dynamic content** (skill names, descriptions) — translated at runtime via MyMemory API with caching:

```typescript
const translatedName = useTranslatedText(skill.name, 'en');
```

3. **Language toggle** — in sidebar (Layout.tsx), persisted to localStorage.

### Adding a New Translation Key

1. Add the key + English value to `translations.en` in `translations.ts`.
2. Add the key + Chinese value to `translations.zh`.
3. Use via `t('yourNewKey')` in components.

---

## 16. Environment & Secrets

### Required Variables

```bash
# Server
PORT=3001
CLIENT_URL=http://localhost:3000
DATABASE_PATH=./data/novohaven.db

# AI Providers (add the ones you use)
OPENAI_API_KEY=sk-your-key-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
GOOGLE_API_KEY=AIza-your-key-here

# Client
REACT_APP_API_URL=http://localhost:3001/api
```

### Plugin Configuration

Provider API keys can also be configured per-plugin via:
- The Plugin Manager UI (`/plugins`)
- The `plugin_configs` DB table
- The `PUT /api/plugins/:name` endpoint

### Rules

- **Never commit real API keys.** The `.env` file is gitignored.
- **`.env.example` must only contain placeholder values** (e.g., `sk-your-key-here`), never real keys.
- Client-side env vars must be prefixed with `REACT_APP_` (CRA requirement).
- The app works without any AI keys using the Mock provider.
- Plugin configs with `"secret": true` in the manifest schema are masked in the UI.

---

## 17. Git & Code Review

### Branch Strategy

- `main` — stable branch.
- Feature branches: `feature/<short-description>`
- Bug fixes: `fix/<short-description>`

### Commit Messages

Write concise commits describing the *why*:

```
feat: add channel-lark plugin for Lark bot integration
fix: agent supervisor not restarting crashed agents
refactor: migrate recipes/templates to skills/workflows tables
```

### Code Review Checklist

- [ ] **Naming** follows conventions (Section 6) — skills not templates, workflows not recipes
- [ ] **Types** are explicit — no untyped `any` without justification
- [ ] **Error handling** follows the result-object pattern (services) or try/catch (routes)
- [ ] **No hardcoded colors** — uses `primary-*` / `secondary-*`
- [ ] **No scattered types** — new interfaces go in `types/index.ts` or `plugins/types.ts`
- [ ] **No business logic in routes** — delegated to services
- [ ] **Barrel exports** updated if a new component/feature folder is added
- [ ] **i18n keys** added for any new user-facing strings
- [ ] **No secrets** in committed files
- [ ] **Database changes** have migration guards in `initializeDatabase()`
- [ ] **New plugins** follow the manifest + interface pattern
- [ ] **New tools** include proper `ToolDefinition` with JSON Schema parameters

---

## 18. Common Pitfalls

### better-sqlite3 is Synchronous

All database operations block the event loop. Queries are fast for current scale, but don't run expensive aggregations in hot paths.

```typescript
// This is synchronous — no await needed
const skill = getOne('SELECT * FROM skills WHERE id = ?', [id]);
```

### WAL Mode and Concurrent Access

better-sqlite3 with WAL mode supports concurrent reads from multiple processes (gateway + agent child processes), but **writes are serialized**. Agent processes can read freely but write operations should be kept lightweight.

### JSON Columns Need Parsing

Database stores JSON as strings. Always parse when reading, stringify when writing:

```typescript
// Reading
const config = JSON.parse(step.executor_config || '{}');
const tags: string[] = JSON.parse(skill.tags || '[]');

// Writing
run('INSERT INTO skills (name, tags) VALUES (?, ?)', [name, JSON.stringify(tags)]);
```

### snake_case ↔ camelCase Boundary

Database uses `snake_case`, JavaScript uses `camelCase`. The boundary is at the query/route layer. The codebase uses snake_case in interfaces that map directly to DB rows:

```typescript
// This is correct — interface mirrors DB columns
interface Skill {
  created_by: number;   // snake_case because it maps to DB
  parent_type: string;
}
```

### Plugin Names Must Match Manifest

The plugin name in `manifest.json` must match the directory name. The loader uses the manifest name for registry registration and DB config lookup.

### Agent Process Isolation

Agent processes run in separate Node.js child processes. They cannot access in-memory state from the gateway process. All shared data goes through the SQLite database (WAL mode enables concurrent reads).

### Auth Is Mock (MVP)

The `authMiddleware` always resolves to the demo user. Don't build features that depend on multi-user isolation until real auth is implemented.

### Client-Side Env Vars Are Public

Anything prefixed `REACT_APP_` is bundled into the client build and visible to users. Never put secrets there.

### Step Output References

`{{step_N_output}}` uses 1-based indexing matching `step_order`, not 0-based array indexing.

### Channel Message Normalization

All channel plugins must normalize platform-specific messages to the `ChannelMessage` type. Don't add channel-specific fields to the core types — use the `metadata` field for platform-specific data.

---

*Last updated: February 2026*
