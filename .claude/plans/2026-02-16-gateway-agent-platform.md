# NovoHaven Gateway Agent Platform — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform NovoHaven from a monolithic web app into a gateway-based, plugin-driven AI agent platform with Lark messaging integration, inspired by OpenClaw's architecture.

**Architecture:** HTTP Gateway (Express) acts as the control plane, routing messages from channel plugins (Web UI, Lark) to isolated agent processes (one per session). A plugin system with 4 categories (Channel, Tool, Memory, Provider) ensures the core never changes when adding capabilities. Templates become "Skills" and Recipes become "Workflows" — both searchable via vector embeddings and executable via the workflow engine.

**Tech Stack:** Node.js 22+, TypeScript, Express, better-sqlite3, sqlite-vec, React 18, Tailwind CSS, Lark Open Platform SDK

**Design Doc:** `docs/plans/2026-02-16-gateway-agent-architecture-design.md`

---

## Phase 1: Database Migration (Foundation)

Everything depends on the database. Migrate from sql.js to better-sqlite3 and rename tables.

### Task 1.1: Switch from sql.js to better-sqlite3

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/models/database.ts`

**Step 1: Install better-sqlite3**

```bash
cd server && npm uninstall sql.js && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

**Step 2: Rewrite database.ts**

Replace the entire `database.ts` with better-sqlite3. Keep the exact same exported API (`getOne`, `getAll`, `run`, `initializeDatabase`, `getDatabase`, `saveDatabase`) so all existing code continues to work without changes.

```typescript
// server/src/models/database.ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/novohaven.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db: Database.Database | null = null;

// better-sqlite3 writes to disk automatically — saveDatabase becomes a no-op
export function saveDatabase() {
  // No-op: better-sqlite3 persists to file automatically
}

export function getOne(sql: string, params: any[] = []): any | undefined {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).get(...params);
}

export function getAll(sql: string, params: any[] = []): any[] {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).all(...params);
}

export function run(sql: string, params: any[] = []): any {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).run(...params);
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function initializeDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');    // Better concurrency for multi-process
  db.pragma('foreign_keys = ON');

  // ... keep ALL existing CREATE TABLE IF NOT EXISTS statements exactly as-is ...
  // ... keep ALL existing seed data exactly as-is ...
}
```

Key differences from sql.js:
- `initializeDatabase()` is now synchronous (no `await initSqlJs()`)
- `getOne` uses `.get()` instead of prepare/step/getAsObject
- `getAll` uses `.all()` instead of looping stmt.step()
- `run` uses `.run()` directly
- `saveDatabase()` becomes a no-op (better-sqlite3 auto-persists)
- Add `WAL` journal mode for concurrent read access from agent processes

**Step 3: Remove sql.js type declaration if it exists**

Check for and remove any `declare module 'sql.js'` statements.

**Step 4: Test that the server starts and existing features work**

```bash
cd server && npm run dev
```

Visit `http://localhost:3001/api/health` — should return OK.
Visit `http://localhost:3001/api/recipes` — should return existing recipes.

**Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/models/database.ts
git commit -m "refactor: migrate from sql.js to better-sqlite3

better-sqlite3 is native, faster, auto-persists to disk, and supports
WAL mode for concurrent reads from agent processes."
```

---

### Task 1.2: Rename recipes → skills/workflows, recipe_steps → skill_steps

**Files:**
- Modify: `server/src/models/database.ts` (migration logic)

**Step 1: Add migration function to database.ts**

Add a `runMigrations()` function called after table creation in `initializeDatabase()`. This migration:
- Creates `skills` table from `recipes WHERE is_template = 1`
- Creates `workflows` table from `recipes WHERE is_template = 0`
- Creates `skill_steps` table from `recipe_steps` with added `parent_type` column
- Adds `status` and `tags` columns
- Keeps `recipes` and `recipe_steps` as read-only backups until verified

```typescript
function runMigrations(): void {
  if (!db) return;

  // Check if migration already ran
  const hasSkillsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='skills'"
  ).get();
  if (hasSkillsTable) return;

  db.transaction(() => {
    // Create skills table
    db!.exec(`
      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id),
        status TEXT DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
        tags TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create workflows table
    db!.exec(`
      CREATE TABLE workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id),
        status TEXT DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
        tags TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create skill_steps table
    db!.exec(`
      CREATE TABLE skill_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER NOT NULL,
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
      )
    `);

    // Migrate data: templates → skills
    db!.exec(`
      INSERT INTO skills (id, name, description, created_by, status, created_at)
      SELECT id, name, description, created_by, 'active', created_at
      FROM recipes WHERE is_template = 1
    `);

    // Migrate data: non-templates → workflows
    db!.exec(`
      INSERT INTO workflows (id, name, description, created_by, status, created_at)
      SELECT id, name, description, created_by, 'active', created_at
      FROM recipes WHERE is_template = 0
    `);

    // Migrate recipe_steps → skill_steps
    // Determine parent_type by joining back to recipes
    db!.exec(`
      INSERT INTO skill_steps (id, parent_id, parent_type, step_order, step_name, step_type,
        ai_model, prompt_template, input_config, output_format, model_config, executor_config)
      SELECT rs.id, rs.recipe_id,
        CASE WHEN r.is_template = 1 THEN 'skill' ELSE 'workflow' END,
        rs.step_order, rs.step_name, rs.step_type, rs.ai_model, rs.prompt_template,
        rs.input_config, rs.output_format, rs.model_config,
        COALESCE(rs.executor_config, '{}')
      FROM recipe_steps rs
      JOIN recipes r ON rs.recipe_id = r.id
    `);
  })();
}
```

Call `runMigrations()` at the end of `initializeDatabase()`.

**Step 2: Test migration**

```bash
cd server && npm run dev
```

Verify: `sqlite3 server/data/novohaven.db "SELECT count(*) FROM skills; SELECT count(*) FROM workflows; SELECT count(*) FROM skill_steps;"`

**Step 3: Commit**

```bash
git add server/src/models/database.ts
git commit -m "feat: migrate recipes/templates to skills/workflows tables

Adds migration that splits recipes table into skills (is_template=1)
and workflows (is_template=0). recipe_steps becomes skill_steps with
parent_type discriminator. Old tables preserved as backup."
```

---

### Task 1.3: Create new tables (sessions, session_messages, agent_configs, plugin_configs, skill_drafts)

**Files:**
- Modify: `server/src/models/database.ts`

**Step 1: Add new table creation to initializeDatabase()**

Add these CREATE TABLE IF NOT EXISTS statements after existing table creation:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  thread_id TEXT,
  agent_pid INTEGER,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','idle','closed')),
  agent_config_id INTEGER,
  active_execution_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_results TEXT,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  default_model TEXT NOT NULL,
  system_prompt TEXT,
  allowed_tools TEXT DEFAULT '[]',
  allowed_channels TEXT DEFAULT '[]',
  max_turns_per_session INTEGER DEFAULT 50,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plugin_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_name TEXT UNIQUE NOT NULL,
  plugin_type TEXT NOT NULL CHECK(plugin_type IN ('channel','tool','memory','provider')),
  enabled BOOLEAN DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_skill_id INTEGER,
  skill_type TEXT NOT NULL CHECK(skill_type IN ('skill','workflow')),
  proposed_by_session TEXT,
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT NOT NULL,
  change_summary TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME
);
```

**Step 2: Seed default agent config**

```typescript
// In seed section of initializeDatabase()
const defaultAgent = getOne('SELECT id FROM agent_configs WHERE name = ?', ['Default Agent']);
if (!defaultAgent) {
  run(`INSERT INTO agent_configs (name, description, default_model, system_prompt, allowed_tools, allowed_channels)
    VALUES (?, ?, ?, ?, ?, ?)`,
    ['Default Agent', 'Default agent configuration',
     'claude-sonnet-4-5-20250929',
     'You are a helpful AI assistant with access to skills and workflows. When a user asks you to do something, search for relevant skills first. If a skill exists, use it. If not, help the user directly or propose creating a new skill.',
     '["tool-browser","tool-bash","tool-fileops","tool-skill-manager"]',
     '["channel-web","channel-lark"]']);
}
```

**Step 3: Test**

```bash
cd server && npm run dev
```

Verify tables exist: `sqlite3 server/data/novohaven.db ".tables"`

**Step 4: Commit**

```bash
git add server/src/models/database.ts
git commit -m "feat: add session, agent config, plugin config, and skill draft tables

Foundation tables for gateway architecture: sessions track agent
conversations across channels, agent_configs define per-agent
settings, plugin_configs store plugin configuration, skill_drafts
support agent-proposed skill edits."
```

---

### Task 1.4: Update server types for new naming

**Files:**
- Modify: `server/src/types/index.ts`

**Step 1: Add new types alongside existing ones**

Add `Skill`, `Workflow`, `SkillStep`, `Session`, `SessionMessage`, `AgentConfig`, `PluginConfig`, `SkillDraft` types. Keep existing `Recipe`, `RecipeStep` types as aliases for backward compatibility during migration.

```typescript
// New types
export interface Skill {
  id: number;
  name: string;
  description: string;
  created_by: number;
  status: 'draft' | 'active' | 'archived';
  tags: string; // JSON array
  created_at: string;
  updated_at: string;
}

export interface Workflow {
  id: number;
  name: string;
  description: string;
  created_by: number;
  status: 'draft' | 'active' | 'archived';
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface SkillStep {
  id: number;
  parent_id: number;
  parent_type: 'skill' | 'workflow';
  step_order: number;
  step_name: string;
  step_type: string;
  ai_model: string;
  prompt_template: string;
  input_config: string;
  output_format: string;
  model_config: string;
  executor_config: string;
}

export interface Session {
  id: string;
  channel_type: string;
  channel_id: string;
  user_id: number;
  thread_id: string | null;
  agent_pid: number | null;
  status: 'active' | 'idle' | 'closed';
  agent_config_id: number | null;
  active_execution_id: number | null;
  created_at: string;
  last_active_at: string;
}

export interface SessionMessage {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: string | null;
  tool_results: string | null;
  metadata: string;
  created_at: string;
}

export interface AgentConfig {
  id: number;
  name: string;
  description: string;
  default_model: string;
  system_prompt: string;
  allowed_tools: string; // JSON array
  allowed_channels: string; // JSON array
  max_turns_per_session: number;
  created_at: string;
}

export interface PluginConfig {
  id: number;
  plugin_name: string;
  plugin_type: 'channel' | 'tool' | 'memory' | 'provider';
  enabled: boolean;
  config: string; // JSON
  updated_at: string;
}

export interface SkillDraft {
  id: number;
  original_skill_id: number | null;
  skill_type: 'skill' | 'workflow';
  proposed_by_session: string | null;
  name: string;
  description: string;
  steps: string; // JSON array
  change_summary: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at: string | null;
}

// Backward compatibility aliases
export type Recipe = Skill | Workflow;
export type RecipeStep = SkillStep;
```

**Step 2: Commit**

```bash
git add server/src/types/index.ts
git commit -m "feat: add types for skills, workflows, sessions, agents, plugins

New TypeScript interfaces for the gateway architecture. Includes
backward-compatible aliases for Recipe/RecipeStep."
```

---

## Phase 2: Plugin System Core

Build the plugin interfaces, loader, and registry — the extensibility backbone.

### Task 2.1: Define plugin interfaces

**Files:**
- Create: `server/src/plugins/types.ts`

**Step 1: Write plugin interface definitions**

```typescript
// server/src/plugins/types.ts
import { Request, Router } from 'express';

// ---- Shared Types ----

export interface ChannelMessage {
  channelType: string;
  channelId: string;
  userId: string;          // platform-specific user ID
  threadId?: string;
  content: {
    text: string;
    attachments?: Array<{
      type: 'image' | 'file' | 'audio' | 'video';
      url: string;
      name?: string;
      mimeType?: string;
    }>;
  };
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface AgentResponse {
  text?: string;
  attachments?: Array<{
    type: 'image' | 'file';
    data: Buffer | string;   // Buffer for binary, string for URL
    name?: string;
    mimeType?: string;
  }>;
  metadata?: Record<string, any>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;  // JSON Schema
}

export interface ToolContext {
  sessionId: string;
  userId: number;
  workingDirectory?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  metadata?: Record<string, any>;
}

export interface SkillIndexEntry {
  skillId: number;
  skillType: 'skill' | 'workflow';
  name: string;
  description: string;
  stepSummary: string;
  tags: string[];
}

export interface SearchResult {
  skillId: number;
  skillType: 'skill' | 'workflow';
  name: string;
  description: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  skillType?: 'skill' | 'workflow';
  minScore?: number;
}

export interface MemoryEntry {
  id: number;
  content: string;
  score: number;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
  contextWindow?: number;
}

export interface CompletionRequest {
  model: string;
  systemPrompt?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCallId?: string;
  }>;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface StreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, any> };
  error?: string;
}

// ---- Plugin Manifest ----

export interface PluginManifest {
  name: string;
  version: string;
  type: 'channel' | 'tool' | 'memory' | 'provider';
  displayName: string;
  description: string;
  entry: string;
  config?: Record<string, any>; // JSON Schema for config validation
}

// ---- Base Plugin ----

export interface Plugin {
  manifest: PluginManifest;
  initialize(config: Record<string, any>): Promise<void>;
  shutdown(): Promise<void>;
}

// ---- Channel Plugin ----

export interface ChannelPlugin extends Plugin {
  parseInbound(req: Request): ChannelMessage | null;
  sendOutbound(channelId: string, response: AgentResponse): Promise<void>;
  verifyAuth(req: Request): boolean;
  registerRoutes(router: Router): void;
}

// ---- Tool Plugin ----

export interface ToolPlugin extends Plugin {
  getTools(): ToolDefinition[];
  execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
}

// ---- Memory Plugin ----

export interface MemoryPlugin extends Plugin {
  index(item: SkillIndexEntry): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  storeMemory(sessionId: string, content: string, embedding?: number[]): Promise<void>;
  searchMemory(sessionId: string, query: string, limit?: number): Promise<MemoryEntry[]>;
}

// ---- Provider Plugin ----

export interface ProviderPlugin extends Plugin {
  listModels(): ModelInfo[];
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
  embed?(texts: string[]): Promise<number[][]>;
}
```

**Step 2: Commit**

```bash
git add server/src/plugins/types.ts
git commit -m "feat: define plugin system interfaces

Four plugin types: Channel (messaging adapters), Tool (agent capabilities),
Memory (search/embeddings), Provider (LLM backends). All plugins share
a common manifest and lifecycle (initialize/shutdown)."
```

---

### Task 2.2: Build plugin registry

**Files:**
- Create: `server/src/plugins/registry.ts`

**Step 1: Write the registry**

```typescript
// server/src/plugins/registry.ts
import {
  Plugin, PluginManifest,
  ChannelPlugin, ToolPlugin, MemoryPlugin, ProviderPlugin
} from './types';

class PluginRegistry {
  private channels = new Map<string, ChannelPlugin>();
  private tools = new Map<string, ToolPlugin>();
  private memory = new Map<string, MemoryPlugin>();
  private providers = new Map<string, ProviderPlugin>();
  private manifests = new Map<string, PluginManifest>();

  register(type: string, name: string, plugin: Plugin): void {
    this.manifests.set(name, plugin.manifest);
    switch (type) {
      case 'channel':
        this.channels.set(name, plugin as ChannelPlugin);
        break;
      case 'tool':
        this.tools.set(name, plugin as ToolPlugin);
        break;
      case 'memory':
        this.memory.set(name, plugin as MemoryPlugin);
        break;
      case 'provider':
        this.providers.set(name, plugin as ProviderPlugin);
        break;
      default:
        throw new Error(`Unknown plugin type: ${type}`);
    }
    console.log(`[PluginRegistry] Registered ${type} plugin: ${name}`);
  }

  getChannel(name: string): ChannelPlugin | undefined {
    return this.channels.get(name);
  }

  getTool(name: string): ToolPlugin | undefined {
    return this.tools.get(name);
  }

  getMemory(name: string): MemoryPlugin | undefined {
    return this.memory.get(name);
  }

  getProvider(name: string): ProviderPlugin | undefined {
    return this.providers.get(name);
  }

  getAllChannels(): Map<string, ChannelPlugin> { return this.channels; }
  getAllTools(): Map<string, ToolPlugin> { return this.tools; }
  getAllMemory(): Map<string, MemoryPlugin> { return this.memory; }
  getAllProviders(): Map<string, ProviderPlugin> { return this.providers; }
  getAllManifests(): Map<string, PluginManifest> { return this.manifests; }

  async shutdownAll(): Promise<void> {
    const all: Plugin[] = [
      ...this.channels.values(),
      ...this.tools.values(),
      ...this.memory.values(),
      ...this.providers.values(),
    ];
    await Promise.allSettled(all.map(p => p.shutdown()));
  }
}

// Singleton
export const pluginRegistry = new PluginRegistry();
```

**Step 2: Commit**

```bash
git add server/src/plugins/registry.ts
git commit -m "feat: add plugin registry singleton

Central registry where all loaded plugins are registered by type.
Provides typed getters for each plugin category."
```

---

### Task 2.3: Build plugin loader

**Files:**
- Create: `server/src/plugins/loader.ts`

**Step 1: Write the loader**

```typescript
// server/src/plugins/loader.ts
import fs from 'fs';
import path from 'path';
import { PluginManifest } from './types';
import { pluginRegistry } from './registry';
import { getOne } from '../models/database';

const BUILTIN_DIR = path.join(__dirname, 'builtin');
const COMMUNITY_DIR = path.join(__dirname, 'community');

export async function loadAllPlugins(): Promise<void> {
  console.log('[PluginLoader] Loading plugins...');

  for (const dir of [BUILTIN_DIR, COMMUNITY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = path.join(dir, entry.name);
      try {
        await loadPlugin(pluginPath);
      } catch (err) {
        console.error(`[PluginLoader] Failed to load plugin at ${pluginPath}:`, err);
      }
    }
  }

  console.log('[PluginLoader] All plugins loaded.');
}

async function loadPlugin(pluginPath: string): Promise<void> {
  const manifestPath = path.join(pluginPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`[PluginLoader] No manifest.json in ${pluginPath}, skipping`);
    return;
  }

  const manifest: PluginManifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8')
  );

  // Check if plugin is enabled in DB (default: enabled)
  const dbConfig = getOne(
    'SELECT enabled, config FROM plugin_configs WHERE plugin_name = ?',
    [manifest.name]
  );

  if (dbConfig && !dbConfig.enabled) {
    console.log(`[PluginLoader] Plugin ${manifest.name} is disabled, skipping`);
    return;
  }

  const config = dbConfig ? JSON.parse(dbConfig.config) : {};

  // Load entry point
  const entryPath = path.join(pluginPath, manifest.entry);
  const PluginModule = require(entryPath);
  const PluginClass = PluginModule.default || PluginModule;

  const plugin = new PluginClass(manifest);
  await plugin.initialize(config);

  pluginRegistry.register(manifest.type, manifest.name, plugin);
}
```

**Step 2: Create builtin and community directories**

```bash
mkdir -p server/src/plugins/builtin
mkdir -p server/src/plugins/community
```

Add a `.gitkeep` to community so the directory is tracked but contents are ignored.

**Step 3: Commit**

```bash
git add server/src/plugins/
git commit -m "feat: add plugin loader with manifest-based discovery

Scans builtin/ and community/ directories for plugins. Each plugin
has a manifest.json declaring type, config schema, and entry point.
Respects enabled/disabled state from plugin_configs DB table."
```

---

### Task 2.4: Add /api/plugins route

**Files:**
- Create: `server/src/routes/plugins.ts`
- Modify: `server/src/index.ts` (add route mount)

**Step 1: Write plugins route**

```typescript
// server/src/routes/plugins.ts
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { pluginRegistry } from '../plugins/registry';
import { getAll, getOne, run } from '../models/database';

const router = Router();
router.use(authMiddleware);

// List all plugins with their status
router.get('/', (req, res) => {
  const manifests = pluginRegistry.getAllManifests();
  const dbConfigs = getAll('SELECT * FROM plugin_configs');
  const configMap = new Map(dbConfigs.map((c: any) => [c.plugin_name, c]));

  const plugins = Array.from(manifests.entries()).map(([name, manifest]) => {
    const dbConfig = configMap.get(name);
    return {
      name: manifest.name,
      type: manifest.type,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      enabled: dbConfig ? !!dbConfig.enabled : true,
      config: dbConfig ? JSON.parse(dbConfig.config) : {},
      configSchema: manifest.config || null,
    };
  });

  res.json(plugins);
});

// Update plugin config
router.put('/:name', (req, res) => {
  const { name } = req.params;
  const { enabled, config } = req.body;

  const existing = getOne('SELECT id FROM plugin_configs WHERE plugin_name = ?', [name]);
  if (existing) {
    run('UPDATE plugin_configs SET enabled = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE plugin_name = ?',
      [enabled ? 1 : 0, JSON.stringify(config || {}), name]);
  } else {
    const manifest = pluginRegistry.getAllManifests().get(name);
    if (!manifest) return res.status(404).json({ error: 'Plugin not found' });
    run('INSERT INTO plugin_configs (plugin_name, plugin_type, enabled, config) VALUES (?, ?, ?, ?)',
      [name, manifest.type, enabled ? 1 : 0, JSON.stringify(config || {})]);
  }

  res.json({ success: true });
});

export default router;
```

**Step 2: Mount in index.ts**

Add `import pluginsRouter from './routes/plugins';` and `app.use('/api/plugins', pluginsRouter);`

**Step 3: Test**

```bash
cd server && npm run dev
# GET http://localhost:3001/api/plugins should return []
```

**Step 4: Commit**

```bash
git add server/src/routes/plugins.ts server/src/index.ts
git commit -m "feat: add /api/plugins route for plugin management

Lists all registered plugins with config status. PUT endpoint
for enabling/disabling plugins and updating their config."
```

---

## Phase 3: Built-in Provider Plugins

Extract the existing aiService.ts into separate provider plugins.

### Task 3.1: Create provider-anthropic plugin

**Files:**
- Create: `server/src/plugins/builtin/provider-anthropic/manifest.json`
- Create: `server/src/plugins/builtin/provider-anthropic/index.ts`

**Step 1: Create manifest**

```json
{
  "name": "provider-anthropic",
  "version": "1.0.0",
  "type": "provider",
  "displayName": "Anthropic Claude",
  "description": "Claude models via Anthropic API",
  "entry": "./index.ts",
  "config": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "description": "Anthropic API key", "secret": true }
    },
    "required": ["apiKey"]
  }
}
```

**Step 2: Create provider implementation**

Extract Anthropic-specific logic from `server/src/services/aiService.ts` into this plugin. Implement `ProviderPlugin` interface: `listModels()`, `stream()`, and `embed()` (Anthropic doesn't have embeddings — omit `embed`).

The `stream()` method should use `@anthropic-ai/sdk` and yield `StreamEvent` objects, handling both text and tool_use content blocks.

Reference: Look at existing `aiService.ts` for how Anthropic client is initialized and used. Extract that logic.

**Step 3: Test**

Load the plugin and verify `listModels()` returns Claude models.

**Step 4: Commit**

```bash
git add server/src/plugins/builtin/provider-anthropic/
git commit -m "feat: add provider-anthropic plugin

Extracts Anthropic Claude integration from aiService.ts into a
standalone provider plugin with streaming and tool use support."
```

---

### Task 3.2: Create provider-openai plugin

**Files:**
- Create: `server/src/plugins/builtin/provider-openai/manifest.json`
- Create: `server/src/plugins/builtin/provider-openai/index.ts`

**Step 1: Create manifest and implementation**

Same pattern as provider-anthropic. Extract OpenAI logic from `aiService.ts`. OpenAI supports embeddings, so implement `embed()` using `text-embedding-3-small`.

**Step 2: Commit**

```bash
git add server/src/plugins/builtin/provider-openai/
git commit -m "feat: add provider-openai plugin

Extracts OpenAI integration into a provider plugin with streaming,
tool use, and embeddings support."
```

---

### Task 3.3: Create provider-google plugin

**Files:**
- Create: `server/src/plugins/builtin/provider-google/manifest.json`
- Create: `server/src/plugins/builtin/provider-google/index.ts`

**Step 1: Create manifest and implementation**

Extract Google Generative AI logic from `aiService.ts`. Implement `embed()` using `text-embedding-004`.

**Step 2: Commit**

```bash
git add server/src/plugins/builtin/provider-google/
git commit -m "feat: add provider-google plugin

Extracts Google Gemini integration into a provider plugin with
streaming and embeddings support."
```

---

### Task 3.4: Wire plugin loader into server startup

**Files:**
- Modify: `server/src/index.ts`

**Step 1: Call loadAllPlugins() in start()**

```typescript
import { loadAllPlugins } from './plugins/loader';

async function start() {
  console.log('Initializing database...');
  initializeDatabase();
  console.log('Database initialized successfully');

  console.log('Loading plugins...');
  await loadAllPlugins();
  console.log('Plugins loaded successfully');

  app.listen(PORT, () => { ... });
}
```

**Step 2: Test**

```bash
cd server && npm run dev
```

Should see plugin loading messages in console for all three providers.

**Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: wire plugin loader into server startup

Plugins are loaded after database initialization, before Express
starts listening."
```

---

## Phase 4: Gateway Control Plane

Build the session manager, channel router, and agent supervisor.

### Task 4.1: Build Session Manager

**Files:**
- Create: `server/src/gateway/sessionManager.ts`

**Step 1: Write SessionManager**

Service that maps `(channelType, userId, threadId)` → session. Creates sessions on first contact. Loads/persists to `sessions` and `session_messages` tables.

Key methods:
- `resolveSession(channelType, channelId, userId, threadId?) → Session`
- `getSession(sessionId) → Session`
- `appendMessage(sessionId, message: SessionMessage) → void`
- `getHistory(sessionId, limit?) → SessionMessage[]`
- `closeSession(sessionId) → void`
- `setActiveExecution(sessionId, executionId) → void`

Uses UUID for session IDs (`import { v4 as uuidv4 } from 'uuid'`).

**Step 2: Test**

Write a test: create a session, append messages, retrieve history.

```bash
cd server && npm test -- --testPathPattern=sessionManager
```

**Step 3: Commit**

```bash
git add server/src/gateway/sessionManager.ts server/src/__tests__/sessionManager.test.ts
git commit -m "feat: add SessionManager for agent session lifecycle

Maps channel messages to sessions, persists conversation history.
Supports session resolution, message appending, and history retrieval."
```

---

### Task 4.2: Build Channel Router

**Files:**
- Create: `server/src/gateway/channelRouter.ts`

**Step 1: Write ChannelRouter**

Express middleware/router factory that:
- Iterates registered channel plugins from `pluginRegistry`
- Calls each channel's `registerRoutes()` to mount webhook endpoints under `/channels/<name>/`
- On inbound message: `parseInbound()` → normalize to `ChannelMessage` → pass to agent supervisor

```typescript
// server/src/gateway/channelRouter.ts
import { Router } from 'express';
import { pluginRegistry } from '../plugins/registry';
import { ChannelMessage } from '../plugins/types';

export type MessageHandler = (message: ChannelMessage) => Promise<void>;

export function createChannelRouter(onMessage: MessageHandler): Router {
  const router = Router();

  // Register routes for each channel plugin
  for (const [name, channel] of pluginRegistry.getAllChannels()) {
    const channelRouter = Router();
    channel.registerRoutes(channelRouter);
    router.use(`/${name}`, channelRouter);
    console.log(`[ChannelRouter] Mounted channel: /channels/${name}`);
  }

  return router;
}
```

**Step 2: Mount in index.ts**

```typescript
import { createChannelRouter } from './gateway/channelRouter';

// After plugin loading:
const channelRouter = createChannelRouter(async (message) => {
  // Will be wired to agent supervisor in Task 4.3
  console.log('[Gateway] Received message:', message);
});
app.use('/channels', channelRouter);
```

**Step 3: Commit**

```bash
git add server/src/gateway/channelRouter.ts server/src/index.ts
git commit -m "feat: add channel router for plugin-based message routing

Mounts each registered channel plugin's routes under /channels/<name>.
Normalizes inbound messages to ChannelMessage format."
```

---

### Task 4.3: Build Agent Supervisor

**Files:**
- Create: `server/src/gateway/agentSupervisor.ts`

**Step 1: Write AgentSupervisor**

Manages agent child processes. Key responsibilities:
- Spawn a new agent process per session (using `child_process.fork()`)
- Route messages to the correct agent process via IPC
- Monitor health via heartbeat
- Enforce max concurrent agents limit
- Idle timeout: close agents after N minutes of inactivity
- Restart crashed agents

```typescript
// server/src/gateway/agentSupervisor.ts
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { ChannelMessage, AgentResponse } from '../plugins/types';
import { SessionManager } from './sessionManager';

interface AgentProcess {
  process: ChildProcess;
  sessionId: string;
  lastActive: Date;
}

export type ResponseHandler = (sessionId: string, response: AgentResponse) => Promise<void>;

export class AgentSupervisor {
  private agents = new Map<string, AgentProcess>();
  private maxAgents: number;
  private idleTimeoutMs: number;
  private sessionManager: SessionManager;
  private onResponse: ResponseHandler;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(opts: {
    sessionManager: SessionManager;
    onResponse: ResponseHandler;
    maxAgents?: number;
    idleTimeoutMs?: number;
  }) {
    this.sessionManager = opts.sessionManager;
    this.onResponse = opts.onResponse;
    this.maxAgents = opts.maxAgents || 10;
    this.idleTimeoutMs = opts.idleTimeoutMs || 10 * 60 * 1000; // 10 min
  }

  start(): void {
    // Periodic cleanup of idle agents
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), 60_000);
  }

  async routeMessage(message: ChannelMessage): Promise<void> {
    const session = await this.sessionManager.resolveSession(
      message.channelType, message.channelId,
      message.userId, message.threadId
    );

    let agent = this.agents.get(session.id);
    if (!agent || !agent.process.connected) {
      agent = this.spawnAgent(session.id);
      this.agents.set(session.id, agent);
    }

    agent.lastActive = new Date();
    agent.process.send({ type: 'message', sessionId: session.id, message });
  }

  private spawnAgent(sessionId: string): AgentProcess {
    if (this.agents.size >= this.maxAgents) {
      // Evict oldest idle agent
      this.evictOldest();
    }

    const agentEntry = path.join(__dirname, '../agent/process.ts');
    const child = fork(agentEntry, [], {
      execArgv: ['-r', 'ts-node/register'],
      env: { ...process.env, SESSION_ID: sessionId },
    });

    child.on('message', (msg: any) => {
      if (msg.type === 'response_complete' || msg.type === 'stream_chunk') {
        this.onResponse(msg.sessionId, { text: msg.content });
      }
      // Handle other IPC message types (approval_request, execution_event, etc.)
    });

    child.on('exit', (code) => {
      console.log(`[AgentSupervisor] Agent for session ${sessionId} exited with code ${code}`);
      this.agents.delete(sessionId);
    });

    return { process: child, sessionId, lastActive: new Date() };
  }

  private cleanupIdle(): void {
    const now = Date.now();
    for (const [sessionId, agent] of this.agents) {
      if (now - agent.lastActive.getTime() > this.idleTimeoutMs) {
        console.log(`[AgentSupervisor] Reclaiming idle agent for session ${sessionId}`);
        agent.process.send({ type: 'shutdown' });
        agent.process.kill('SIGTERM');
        this.agents.delete(sessionId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Date.now();
    for (const [id, agent] of this.agents) {
      if (agent.lastActive.getTime() < oldestTime) {
        oldestTime = agent.lastActive.getTime();
        oldest = id;
      }
    }
    if (oldest) {
      const agent = this.agents.get(oldest)!;
      agent.process.send({ type: 'shutdown' });
      agent.process.kill('SIGTERM');
      this.agents.delete(oldest);
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    for (const [, agent] of this.agents) {
      agent.process.send({ type: 'shutdown' });
      agent.process.kill('SIGTERM');
    }
    this.agents.clear();
  }

  getActiveCount(): number { return this.agents.size; }
  getMaxAgents(): number { return this.maxAgents; }
}
```

**Step 2: Commit**

```bash
git add server/src/gateway/agentSupervisor.ts
git commit -m "feat: add AgentSupervisor for process-per-session management

Spawns, routes to, and manages agent child processes. Includes idle
timeout, max concurrency enforcement, and health monitoring."
```

---

### Task 4.4: Add /api/sessions and /api/agents routes

**Files:**
- Create: `server/src/routes/sessions.ts`
- Create: `server/src/routes/agents.ts`
- Modify: `server/src/index.ts`

**Step 1: Write sessions route**

CRUD for viewing active sessions, session messages, session health.

```
GET  /api/sessions          — list active sessions (with channel, user, last_active)
GET  /api/sessions/:id      — get session detail with recent messages
POST /api/sessions/:id/close — close a session
```

**Step 2: Write agents route**

CRUD for agent configurations.

```
GET    /api/agents          — list agent configs
POST   /api/agents          — create agent config
GET    /api/agents/:id      — get agent config
PUT    /api/agents/:id      — update agent config
DELETE /api/agents/:id      — delete agent config
```

**Step 3: Mount both in index.ts**

**Step 4: Commit**

```bash
git add server/src/routes/sessions.ts server/src/routes/agents.ts server/src/index.ts
git commit -m "feat: add /api/sessions and /api/agents routes

Sessions route for monitoring active agent sessions across channels.
Agents route for managing agent configurations (model, system prompt,
allowed tools/channels)."
```

---

## Phase 5: Agent Runtime

Build the agent process, runner loop, prompt builder, and tool executor.

### Task 5.1: Build the agent process entry point

**Files:**
- Create: `server/src/agent/process.ts`

**Step 1: Write agent process**

This is the file `child_process.fork()` spawns. It:
- Listens for IPC messages from the gateway
- Initializes an `AgentRunner` instance
- Routes messages to `AgentRunner.handleTurn()`
- Sends responses back via `process.send()`

```typescript
// server/src/agent/process.ts
import { AgentRunner } from './AgentRunner';

const sessionId = process.env.SESSION_ID!;
const runner = new AgentRunner(sessionId);

process.on('message', async (msg: any) => {
  switch (msg.type) {
    case 'message':
      try {
        await runner.handleTurn(msg.message);
      } catch (err: any) {
        process.send!({ type: 'error', sessionId, error: err.message });
      }
      break;
    case 'approval_response':
      runner.handleApprovalResponse(msg.requestId, msg.approved, msg.data);
      break;
    case 'shutdown':
      await runner.shutdown();
      process.exit(0);
      break;
  }
});

// Heartbeat
setInterval(() => {
  process.send!({ type: 'heartbeat' });
}, 30_000);

console.log(`[Agent] Process started for session ${sessionId}`);
```

**Step 2: Commit**

```bash
git add server/src/agent/process.ts
git commit -m "feat: add agent process entry point

Child process that hosts an AgentRunner instance. Receives messages
via IPC from gateway, dispatches to runner, sends responses back."
```

---

### Task 5.2: Build AgentRunner (core loop)

**Files:**
- Create: `server/src/agent/AgentRunner.ts`

**Step 1: Write AgentRunner**

Implements the 5-step per-turn loop:
1. Load session state
2. Assemble context (via PromptBuilder)
3. Stream LLM response (via provider plugin)
4. Execute tool calls (via ToolExecutor)
5. Persist state

This is the most complex single file. Key considerations:
- Connects to DB via better-sqlite3 (can open the same file from child process thanks to WAL mode)
- Uses provider plugins from the registry (need to pass provider reference or re-initialize in child process)
- Streams responses back via `process.send()`
- Handles the tool call → result → continue loop

The initial implementation can use a single provider (no tool calls yet). Tool execution and streaming get refined in subsequent tasks.

**Step 2: Commit**

```bash
git add server/src/agent/AgentRunner.ts
git commit -m "feat: add AgentRunner with 5-step agentic loop

Core agent loop: resolve session, assemble context, stream LLM,
execute tools, persist state. Provider-agnostic via plugin system."
```

---

### Task 5.3: Build PromptBuilder

**Files:**
- Create: `server/src/agent/PromptBuilder.ts`

**Step 1: Write PromptBuilder**

Evolves `promptParser.ts`. Assembles the full prompt from layered sources:
- Agent personality/instructions (from `agent_configs.system_prompt`)
- Available tools summary (from registered tool plugins)
- Relevant skills (from Skill Search — initially keyword-based, vector search comes in Phase 7)
- Active execution context (if a workflow is running)
- Company standards (if referenced)
- Session history (last N turns from `session_messages`)

Returns `{ systemPrompt: string, messages: Message[] }`.

**Step 2: Commit**

```bash
git add server/src/agent/PromptBuilder.ts
git commit -m "feat: add PromptBuilder for dynamic context assembly

Layers system prompt from agent config, tool definitions, relevant
skills, active execution state, and session history."
```

---

### Task 5.4: Build agent ToolExecutor

**Files:**
- Create: `server/src/agent/ToolExecutor.ts`

**Step 1: Write ToolExecutor**

Bridges between the LLM's tool calls and tool plugins + skill execution.

Aggregates tool definitions from:
- All registered tool plugins (`getTools()`)
- Built-in agent tools: `skill:search`, `skill:execute`, `skill:test`, `skill:edit`, `skill:create`, `skill:validate`, `approval:request`

Routes tool calls to the appropriate handler:
- `skill:*` tools → internal skill management logic
- Everything else → delegate to matching tool plugin's `execute()`

```typescript
getToolDefinitions(): ToolDefinition[] — merges all tool definitions
execute(toolName: string, args: Record<string, any>): Promise<ToolResult>
```

**Step 2: Commit**

```bash
git add server/src/agent/ToolExecutor.ts
git commit -m "feat: add agent ToolExecutor bridging LLM tool calls to plugins

Aggregates tool definitions from all tool plugins plus built-in skill
management tools. Routes execution to appropriate handler."
```

---

## Phase 6: Built-in Tool Plugins

### Task 6.1: Create tool-skill-manager plugin

**Files:**
- Create: `server/src/plugins/builtin/tool-skill-manager/manifest.json`
- Create: `server/src/plugins/builtin/tool-skill-manager/index.ts`

**Step 1: Implement skill management tools**

Tools: `skill:search`, `skill:execute`, `skill:test`, `skill:edit`, `skill:create`, `skill:validate`

- `skill:search` — queries `skills` and `workflows` tables by name/description (keyword search initially, vector search later)
- `skill:execute` — creates a `workflow_execution` and runs it through the workflow engine
- `skill:test` — runs a skill with test inputs, returns output without saving
- `skill:edit` — creates a `skill_drafts` entry with proposed changes
- `skill:create` — creates a new `skill_drafts` entry
- `skill:validate` — checks for missing variables, invalid configs

**Step 2: Commit**

```bash
git add server/src/plugins/builtin/tool-skill-manager/
git commit -m "feat: add tool-skill-manager plugin

Agent-callable tools for searching, executing, testing, editing, and
creating skills. Edits create draft entries requiring human approval."
```

---

### Task 6.2: Create tool-browser plugin

**Files:**
- Create: `server/src/plugins/builtin/tool-browser/manifest.json`
- Create: `server/src/plugins/builtin/tool-browser/index.ts`

**Step 1: Extract from browserService.ts**

Wrap existing `browserService.ts` as a tool plugin with tools:
- `browser:navigate` — open URL, return page content/screenshot
- `browser:interact` — click, type, extract elements
- `browser:screenshot` — take screenshot of current page

**Step 2: Commit**

```bash
git add server/src/plugins/builtin/tool-browser/
git commit -m "feat: add tool-browser plugin

Wraps browser automation as agent-callable tools. Navigate, interact,
and screenshot web pages."
```

---

### Task 6.3: Create tool-bash and tool-fileops plugins

**Files:**
- Create: `server/src/plugins/builtin/tool-bash/manifest.json`
- Create: `server/src/plugins/builtin/tool-bash/index.ts`
- Create: `server/src/plugins/builtin/tool-fileops/manifest.json`
- Create: `server/src/plugins/builtin/tool-fileops/index.ts`

**Step 1: Implement bash tool**

Tool: `bash:execute` — runs a shell command with timeout, returns stdout/stderr.
Security: working directory restrictions, command allowlist/denylist in config.

**Step 2: Implement fileops tool**

Tools: `file:read`, `file:write`, `file:list`
Security: path restrictions in config (only allowed directories).

**Step 3: Commit**

```bash
git add server/src/plugins/builtin/tool-bash/ server/src/plugins/builtin/tool-fileops/
git commit -m "feat: add tool-bash and tool-fileops plugins

Bash execution with timeout and command restrictions. File operations
with path restrictions for security."
```

---

## Phase 7: Memory Plugin + Vector Search

### Task 7.1: Create memory-sqlite-vec plugin

**Files:**
- Create: `server/src/plugins/builtin/memory-sqlite-vec/manifest.json`
- Create: `server/src/plugins/builtin/memory-sqlite-vec/index.ts`

**Step 1: Install sqlite-vec**

```bash
cd server && npm install sqlite-vec
```

**Step 2: Implement MemoryPlugin**

- `index()` — generate embedding via a provider plugin's `embed()`, store in `skill_index` table using sqlite-vec
- `search()` — vector similarity search + BM25 keyword search, combine scores
- `storeMemory()` — store conversation memory for a session
- `searchMemory()` — retrieve relevant past context

Uses the first provider plugin that supports `embed()` (OpenAI or Google).

**Step 3: Build initial index**

Add a function to index all existing skills/workflows on first run.

**Step 4: Commit**

```bash
git add server/src/plugins/builtin/memory-sqlite-vec/
git commit -m "feat: add memory-sqlite-vec plugin for vector search

Indexes skills/workflows as vector embeddings using sqlite-vec.
Hybrid search combining vector similarity and BM25 keyword matching."
```

---

## Phase 8: Channel Plugins

### Task 8.1: Create channel-web plugin

**Files:**
- Create: `server/src/plugins/builtin/channel-web/manifest.json`
- Create: `server/src/plugins/builtin/channel-web/index.ts`

**Step 1: Implement web channel**

Extract and adapt the existing SSE streaming pattern from `executionStream.ts`:

- `registerRoutes()` — mounts `POST /message` (send message to agent) and `GET /stream` (SSE for responses)
- `parseInbound()` — extracts text from JSON body, wraps as ChannelMessage with `channelType: 'web'`
- `sendOutbound()` — writes to SSE stream for the relevant session
- `verifyAuth()` — delegates to existing JWT auth middleware

**Step 2: Commit**

```bash
git add server/src/plugins/builtin/channel-web/
git commit -m "feat: add channel-web plugin

Web UI messaging channel using REST + SSE. Adapts existing SSE
streaming pattern for agent conversations."
```

---

### Task 8.2: Create channel-lark plugin

**Files:**
- Create: `server/src/plugins/builtin/channel-lark/manifest.json`
- Create: `server/src/plugins/builtin/channel-lark/index.ts`

**Step 1: Install Lark SDK**

```bash
cd server && npm install @larksuiteoapi/node-sdk
```

**Step 2: Implement Lark channel**

- `registerRoutes()` — mounts `POST /webhook` for Lark event subscription
- `verifyAuth()` — validates Lark verification token / signature
- `parseInbound()` — handles `im.message.receive_v1` events:
  - Extracts text (strips @mention in groups)
  - Maps Lark `open_id` to channelId
  - Detects group vs DM from `chat_type`
  - Handles URL verification challenge response
- `sendOutbound()` — calls Lark `POST /im/v1/messages`:
  - Formats markdown as Lark rich text
  - Chunks messages >4000 chars
  - Creates interactive cards for approval requests

**Step 3: Commit**

```bash
git add server/src/plugins/builtin/channel-lark/
git commit -m "feat: add channel-lark plugin

Lark bot integration supporting group chats (@mention) and DMs.
Webhook-based inbound with rich text/card outbound formatting."
```

---

## Phase 9: API Route Migration (Skills/Workflows)

### Task 9.1: Create /api/skills route

**Files:**
- Create: `server/src/routes/skills.ts`
- Modify: `server/src/index.ts`

**Step 1: Write skills route**

Port from `routes/recipes.ts` but query `skills` and `skill_steps WHERE parent_type='skill'` tables instead. Same CRUD operations:

```
GET    /api/skills          — list all skills
POST   /api/skills          — create skill
GET    /api/skills/:id      — get skill with steps
PUT    /api/skills/:id      — update skill
DELETE /api/skills/:id      — delete skill
POST   /api/skills/:id/clone — clone skill
```

**Step 2: Mount in index.ts, keep old /api/recipes for backward compat**

**Step 3: Commit**

```bash
git add server/src/routes/skills.ts server/src/index.ts
git commit -m "feat: add /api/skills route for skill management

New route querying skills and skill_steps tables. Old /api/recipes
route preserved for backward compatibility during migration."
```

---

### Task 9.2: Create /api/workflows route

**Files:**
- Create: `server/src/routes/workflows.ts`
- Modify: `server/src/index.ts`

**Step 1: Write workflows route**

Same pattern as skills route but queries `workflows` table and `skill_steps WHERE parent_type='workflow'`.

**Step 2: Commit**

```bash
git add server/src/routes/workflows.ts server/src/index.ts
git commit -m "feat: add /api/workflows route for workflow management"
```

---

### Task 9.3: Create /api/skills/drafts route

**Files:**
- Create: `server/src/routes/skillDrafts.ts`
- Modify: `server/src/index.ts`

**Step 1: Write skill drafts route**

```
GET  /api/skills/drafts           — list pending drafts
GET  /api/skills/drafts/:id       — get draft with diff
POST /api/skills/drafts/:id/approve — approve and apply draft
POST /api/skills/drafts/:id/reject  — reject draft
```

Approve: copies draft data into the `skills` or `workflows` table (update if `original_skill_id` exists, insert if new).

**Step 2: Commit**

```bash
git add server/src/routes/skillDrafts.ts server/src/index.ts
git commit -m "feat: add /api/skills/drafts route for agent-proposed edits

Review, approve, and reject skill drafts proposed by agents.
Approved drafts are applied to the skills/workflows tables."
```

---

## Phase 10: Web UI Updates

### Task 10.1: Rename templates → skills throughout client

**Files:**
- Modify: `client/src/App.tsx` (routes)
- Rename: `client/src/components/TemplateEditor/` → `client/src/components/SkillEditor/`
- Modify: `client/src/services/api.ts` (API calls)
- Modify: `client/src/i18n/translations.ts`

**Step 1: Rename component directory and update imports**

Rename `TemplateEditor/` to `SkillEditor/`. Update all imports in `App.tsx` and within the component.

**Step 2: Update routes in App.tsx**

```
/templates/new    → /skills/new
/templates/:id    → /skills/:id
```

**Step 3: Update API calls in api.ts**

Change `/api/recipes` calls for templates to `/api/skills`.

**Step 4: Update translations**

Replace "Template" with "Skill" in `translations.ts`.

**Step 5: Commit**

```bash
git add client/src/
git commit -m "refactor: rename templates to skills throughout client

Routes, components, API calls, and translations updated from
template terminology to skill terminology."
```

---

### Task 10.2: Rename recipes → workflows throughout client

**Files:**
- Modify: `client/src/App.tsx`
- Rename: `client/src/components/RecipeBuilder/` → `client/src/components/WorkflowBuilder/`
- Rename: `client/src/components/RecipeBuilder/RecipeRunner.tsx` → `WorkflowRunner.tsx`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/i18n/translations.ts`

Same pattern as Task 10.1 but for recipes → workflows.

**Step 1–4:** Same as Task 10.1 but s/recipe/workflow, s/Recipe/Workflow

**Step 5: Commit**

```bash
git add client/src/
git commit -m "refactor: rename recipes to workflows throughout client"
```

---

### Task 10.3: Add AgentChat page (web channel UI)

**Files:**
- Create: `client/src/components/AgentChat/AgentChat.tsx`
- Create: `client/src/components/AgentChat/AgentChatInput.tsx`
- Create: `client/src/components/AgentChat/AgentChatHistory.tsx`
- Modify: `client/src/App.tsx` (add /chat route)

**Step 1: Build AgentChat component**

Similar to ChatExecution but for freeform agent conversations (not tied to a workflow execution). Connects to `POST /channels/web/message` for sending and `GET /channels/web/stream` for SSE responses.

Features:
- Message thread display (user + assistant messages)
- Streaming response rendering
- Session history sidebar (list of past sessions)
- Approval request handling (inline buttons)
- Active workflow execution display (when agent runs a skill)

**Step 2: Add route in App.tsx**

```
/chat → AgentChat
```

**Step 3: Commit**

```bash
git add client/src/components/AgentChat/ client/src/App.tsx
git commit -m "feat: add AgentChat page for web channel agent interaction

Full conversation UI for direct agent chat. Supports streaming,
approval requests, and session history."
```

---

### Task 10.4: Add SessionMonitor page

**Files:**
- Create: `client/src/components/SessionMonitor/SessionMonitor.tsx`
- Create: `client/src/components/SessionMonitor/SessionDetail.tsx`
- Modify: `client/src/App.tsx`

**Step 1: Build SessionMonitor**

Table view of all active sessions:
- Session ID, channel (web/lark), user, status, last active, message count
- Click to expand → SessionDetail showing conversation transcript and tool calls

Uses `GET /api/sessions` and `GET /api/sessions/:id`.

**Step 2: Commit**

```bash
git add client/src/components/SessionMonitor/ client/src/App.tsx
git commit -m "feat: add SessionMonitor page for agent session oversight

Admin dashboard showing active sessions across all channels with
conversation inspection."
```

---

### Task 10.5: Add PluginManager page

**Files:**
- Create: `client/src/components/PluginManager/PluginManager.tsx`
- Create: `client/src/components/PluginManager/PluginConfig.tsx`
- Modify: `client/src/App.tsx`

**Step 1: Build PluginManager**

List all plugins with enable/disable toggles. Click to expand → PluginConfig with auto-generated form from `configSchema`.

Uses `GET /api/plugins` and `PUT /api/plugins/:name`.

**Step 2: Commit**

```bash
git add client/src/components/PluginManager/ client/src/App.tsx
git commit -m "feat: add PluginManager page for plugin configuration

Lists all plugins with enable/disable toggles and auto-generated
config forms from plugin manifest schemas."
```

---

### Task 10.6: Add SkillDraftReview page

**Files:**
- Create: `client/src/components/SkillDraftReview/DraftList.tsx`
- Create: `client/src/components/SkillDraftReview/DraftDiff.tsx`
- Modify: `client/src/App.tsx`

**Step 1: Build DraftList + DraftDiff**

DraftList: table of pending skill drafts with agent's change_summary.
DraftDiff: side-by-side comparison of original skill vs proposed changes. Approve/reject buttons.

Uses `GET /api/skills/drafts` and `POST /api/skills/drafts/:id/approve|reject`.

**Step 2: Commit**

```bash
git add client/src/components/SkillDraftReview/ client/src/App.tsx
git commit -m "feat: add SkillDraftReview page for approving agent edits

Review agent-proposed skill changes with side-by-side diff view.
Approve or reject with one click."
```

---

### Task 10.7: Update Dashboard with agent health

**Files:**
- Modify: `client/src/components/Dashboard/Dashboard.tsx`

**Step 1: Add agent health panel**

Add a section showing:
- Active agent count / max
- Active sessions by channel
- Recent skill executions
- Pending skill drafts count

Uses `GET /api/sessions`, `GET /api/skills/drafts`, `GET /api/plugins`.

**Step 2: Commit**

```bash
git add client/src/components/Dashboard/Dashboard.tsx
git commit -m "feat: add agent health panel to dashboard

Shows active agents, sessions by channel, recent executions, and
pending skill drafts."
```

---

### Task 10.8: Update navigation sidebar

**Files:**
- Modify: `client/src/components/common/Layout.tsx` (or wherever nav lives)

**Step 1: Update navigation links**

Replace old nav items and add new ones:
- Skills (was Templates)
- Workflows (was Recipes)
- Agent Chat (new)
- Executions (unchanged)
- Outputs (unchanged)
- Sessions (new)
- Plugins (new)
- Agent Config (new)
- Skill Drafts (new)
- Standards (unchanged)
- Usage (unchanged)

**Step 2: Commit**

```bash
git add client/src/components/common/
git commit -m "refactor: update navigation for new architecture

Renames and new nav items: Skills, Workflows, Agent Chat, Sessions,
Plugins, Agent Config, Skill Drafts."
```

---

## Phase 11: Integration & Wire-Up

### Task 11.1: Wire gateway end-to-end (channel → agent → channel)

**Files:**
- Modify: `server/src/index.ts`

**Step 1: Connect all gateway components**

In the server's `start()` function, wire:
1. `loadAllPlugins()` — loads all channel, tool, memory, provider plugins
2. `SessionManager` — initialized with DB access
3. `AgentSupervisor` — initialized with SessionManager and response handler
4. `ChannelRouter` — created with `AgentSupervisor.routeMessage` as the message handler
5. Response handler: looks up session → finds channel → calls `channel.sendOutbound()`

This is the full loop: Lark webhook → ChannelRouter → AgentSupervisor → Agent process → IPC response → AgentSupervisor → ChannelRouter → Lark API.

**Step 2: End-to-end test with web channel**

1. Start server
2. Open `/chat` in browser
3. Send a message
4. Verify: message flows through channel-web → gateway → agent process → response streams back to browser

**Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: wire gateway end-to-end message routing

Complete message flow: channel inbound → session resolution → agent
process → response → channel outbound. All components connected."
```

---

### Task 11.2: End-to-end test with Lark

**Step 1: Configure Lark bot**

1. Create a Lark app at `open.larksuite.com`
2. Enable bot capabilities
3. Set webhook URL to your server's `/channels/channel-lark/webhook`
4. Save appId, appSecret, verificationToken in `plugin_configs` table

**Step 2: Test DM flow**

Send a DM to the bot → verify response comes back in Lark.

**Step 3: Test group @mention flow**

Add bot to a group → @mention it → verify response.

**Step 4: Commit any fixes**

```bash
git commit -m "fix: lark integration adjustments from end-to-end testing"
```

---

### Task 11.3: Test skill discovery + execution via agent

**Step 1: Verify existing skills are indexed**

Check that the memory plugin indexed all skills on startup.

**Step 2: Test via web chat**

Send "analyze reviews for [url]" → agent should:
1. Search for relevant skills
2. Find "Product Review Analyzer"
3. Ask for missing inputs
4. Execute the workflow
5. Stream results back

**Step 3: Test skill self-healing**

Create a broken skill (missing variable). Ask agent to use it → agent should detect the error, propose a fix, and ask for approval.

**Step 4: Commit any fixes**

```bash
git commit -m "fix: skill discovery and execution refinements"
```

---

## Summary: Phase Execution Order

| Phase | Description | Dependencies | Est. Tasks |
|---|---|---|---|
| 1 | Database Migration | None | 4 |
| 2 | Plugin System Core | Phase 1 | 4 |
| 3 | Provider Plugins | Phase 2 | 4 |
| 4 | Gateway Control Plane | Phase 1, 2 | 4 |
| 5 | Agent Runtime | Phase 2, 3, 4 | 4 |
| 6 | Tool Plugins | Phase 2, 5 | 3 |
| 7 | Memory + Vector Search | Phase 2, 3 | 1 |
| 8 | Channel Plugins | Phase 2, 4 | 2 |
| 9 | API Route Migration | Phase 1 | 3 |
| 10 | Web UI Updates | Phase 9 | 8 |
| 11 | Integration & Wire-Up | All above | 3 |

**Total: 40 tasks across 11 phases**

Phases 1–3 can be done first (foundation). Phases 4–8 build the gateway + agents. Phase 9–10 update the UI. Phase 11 wires everything together.

Note: Phases 2, 3, and 9 can run **in parallel** since they don't depend on each other (only on Phase 1). Similarly, Phases 6, 7, and 8 can run in parallel.
