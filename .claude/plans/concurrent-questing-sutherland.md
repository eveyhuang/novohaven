# Plan: Extensible Step Executors + AI Workflow Assistant

## Context

Two pain points with the current template/workflow system:

1. **Manual workflow creation is too hard**: Users must break complex tasks into concrete steps, write full prompts, and configure each template manually. This is time-consuming and quality depends on prompt engineering skills. We want AI to help create workflows from natural language descriptions.

2. **Step types are rigid**: `step_type` is locked to `'ai' | 'scraping'`, and scraping is hardcoded to BrightData. Adding any new non-LLM step (Playwright, Python scripts, HTTP APIs, data transforms) requires DB schema changes, new interfaces, new UI, and new execution logic in the workflow engine. Many useful tasks don't need LLMs at all.

### How this plan solves each pain point

**Pain Point 1 → Phase 3 (AI Workflow Assistant)**: Users describe goals in natural language (Chinese or English) through a chat interface. AI analyzes the task, breaks it into logical steps, selects the right step type for each (LLM vs script vs HTTP vs browser), writes prompts/scripts/configs, and generates a complete workflow. Users review, refine through conversation, edit individual steps, and save. This eliminates the need for manual task breakdown and prompt engineering.

**Pain Point 2 → Phase 1+2 (Executor Plugin System)**: The hardcoded `if/else` dispatch in workflowEngine.ts is replaced with a plugin registry. Each step type (AI, scraping, script, HTTP, transform, browser) implements a common `StepExecutor` interface and registers itself. To add a new non-LLM step type: implement the interface, register it, done. No DB schema changes, no workflow engine changes, no UI changes (the UI renders config forms dynamically from each executor's schema). The AI assistant in Phase 3 also benefits — it knows about all registered executors and can generate workflows that use any mix of them.

### Alternatives considered and rejected

- **Simple switch statement instead of plugin registry**: For 5-6 step types, a switch in workflowEngine + manual UI panels would be faster to build. Rejected because: adding each new type still requires touching 3 files (engine + service + UI), and the dynamic config schema is needed for Phase 3 (the AI assistant needs to know what each executor accepts).
- **"Generate" button in existing RecipeBuilder instead of chat interface**: One-shot generation without iterative refinement. Rejected because: complex workflows (like the market research example with 12 steps) need back-and-forth refinement, and a chat interface naturally supports that.

---

## Phase 1: Step Executor Plugin System (Foundation)

**Goal**: Replace the hardcoded if/else step dispatch with a plugin registry so new step types can be added by implementing an interface — no schema or engine changes needed.

### 1a. DB Migration (additive only)

Add one column to `recipe_steps` in [database.ts](server/src/models/database.ts):
```sql
ALTER TABLE recipe_steps ADD COLUMN executor_config TEXT;
```
This is a general-purpose JSON field for executor-specific config. Existing `api_config` kept for backwards compat — executors fall back to it when `executor_config` is null.

### 1b. Type Changes

**[server/src/types/index.ts](server/src/types/index.ts:31)**:
- Widen `StepType` from `'ai' | 'scraping'` to `'ai' | 'scraping' | 'script' | 'browser' | 'http' | 'transform' | string`
- Add `ExecutorConfig` interface (generic JSON blob with `executor`, `runtime`, `script`, `timeout`, etc.)

**[client/src/types/index.ts](client/src/types/index.ts)**: Mirror `StepType` change.

### 1c. Executor Plugin Architecture

Create `server/src/executors/` directory:

| File | Purpose |
|------|---------|
| `StepExecutor.ts` | Interface: `validateConfig()`, `execute()`, `getConfigSchema()` |
| `AIExecutor.ts` | Extract existing AI logic from [workflowEngine.ts:243-346](server/src/services/workflowEngine.ts#L243-L346) |
| `ScrapingExecutor.ts` | Extract existing scraping logic from [workflowEngine.ts](server/src/services/workflowEngine.ts) `executeScrapingStep()` |
| `ScriptExecutor.ts` | Run Python/Node scripts via child process, I/O via stdin/stdout JSON |
| `HttpExecutor.ts` | Make HTTP requests with `{{variable}}` substitution in URL/headers/body |
| `TransformExecutor.ts` | Data transforms: CSV↔JSON, field mapping, filtering |
| `registry.ts` | `registerExecutor()`, `getExecutor(stepType)`, `getAllExecutors()` |

Each executor implements:
```typescript
interface StepExecutor {
  type: string;             // matches step_type
  displayName: string;
  icon: string;
  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] };
  execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult>;
  getConfigSchema(): ExecutorConfigSchema;  // drives dynamic UI forms
}
```

### 1d. Refactor Workflow Engine

Replace the if/else dispatch at [workflowEngine.ts:229-241](server/src/services/workflowEngine.ts#L229-L241):

```typescript
// Before:
if (step.step_type === 'scraping') {
  return executeScrapingStep(...);
}
// AI default...

// After:
const executor = getExecutor(step.step_type || 'ai') || getExecutor('ai')!;
const result = await executor.execute(step, context);
```

Everything else unchanged: state tracking, pause-for-review, approve/reject/retry.

### 1e. New API Endpoint

`GET /api/executors` — returns available step types with their config schemas. Register in [server/src/index.ts](server/src/index.ts).

### 1f. Migration Strategy

**Zero data migration needed**:
- Existing `step_type='ai'` → matches `AIExecutor`
- Existing `step_type='scraping'` → matches `ScrapingExecutor`
- `executor_config` defaults to NULL; executors fall back to `model_config`/`api_config`

---

## Phase 2: Script + HTTP + Transform Executors

**Goal**: Implement the three most immediately useful new step types.

### 2a. ScriptExecutor
- Runs Python/Node scripts in child process
- User inputs + previous step outputs serialized as JSON to stdin
- stdout captured as step output
- Configurable timeout, runtime selection (`python3`, `node`)

### 2b. HttpExecutor
- HTTP requests with configurable method, URL, headers, body
- Supports `{{variable}}` substitution in all fields via existing `compilePrompt()`
- Useful for: Google Trends API, custom APIs, webhooks

### 2c. TransformExecutor
- Data transforms: CSV→JSON, JSON→CSV, field mapping, filtering
- Pure JS, no external dependencies
- Config: `transform_type`, `mapping`, `filter_expression`

### 2d. UI Updates

**[TemplateEditor.tsx](client/src/components/TemplateEditor/TemplateEditor.tsx)**:
- Replace hardcoded AI/scraping toggle with dynamic step type selector
- Fetch available executors from `GET /api/executors`
- Render executor-specific config form using `getConfigSchema()` data
- For script steps: show code editor (Monaco/CodeMirror)
- For HTTP steps: show method/URL/headers/body fields
- For transform steps: show transform type and mapping config

**[RecipeBuilder.tsx](client/src/components/RecipeBuilder/RecipeBuilder.tsx)**:
- Show executor icon + type label on each step card

**[ExecutionView.tsx](client/src/components/WorkflowExecution/ExecutionView.tsx)**:
- Show executor-specific metadata in step output (HTTP status, script exit code, etc.)

---

## Phase 3: AI Workflow Assistant

**Goal**: Users describe their goal in natural language (Chinese or English), and an AI breaks it down into a full workflow with the right mix of step types.

### 3a. Server-Side Service

Create `server/src/services/workflowAssistant.ts`:
- Takes conversation messages + generates structured workflow JSON
- System prompt dynamically includes available executors (from registry) and AI models (from `AI_MODELS`)
- Instructs the AI to: pick the right step type per task, write complete prompts/scripts, identify required inputs, chain step outputs, respond in the user's language
- Uses existing `callAIByModel()` from [aiService.ts](server/src/services/aiService.ts) — model preference: Claude Sonnet > GPT-4o > Gemini Pro

**Output format**:
```typescript
interface AssistantResponse {
  message: string;              // conversational response
  workflow?: GeneratedWorkflow; // structured recipe (when ready)
  suggestions?: string[];       // refinement ideas
}

interface GeneratedWorkflow {
  name: string;
  description: string;
  steps: GeneratedStep[];       // each with step_type, prompts/scripts, configs
  requiredInputs: { name: string; type: string; description: string }[];
}
```

### 3b. API Routes

Create `server/src/routes/assistant.ts`:
- `POST /api/assistant/generate` — stateless: client sends full message history, gets response + optional workflow
- `POST /api/assistant/save` — saves a `GeneratedWorkflow` as a recipe with steps

### 3c. Frontend: AI Workflow Builder

New component `client/src/components/WorkflowBuilder/AIWorkflowBuilder.tsx`:

```
+-------------------------------------------+
| LEFT: Chat panel     | RIGHT: Workflow     |
|                      | preview             |
| User describes goal  | Step 1: [browser]   |
| in natural language  | Step 2: [transform] |
| (CN or EN)           | Step 3: [ai]        |
|                      | Step 4: [script]    |
| AI responds with     |                     |
| plan + generates     | [Edit] [Reorder]    |
| workflow             | [Save as Recipe]    |
| User refines...      | [Save as Template]  |
+-------------------------------------------+
```

**Flow**:
1. User types goal → `POST /api/assistant/generate`
2. AI responds conversationally + shows workflow preview
3. User refines ("add a data cleaning step", "make step 3 use Claude instead")
4. User clicks individual steps to edit inline
5. "Save" → `POST /api/assistant/save` → redirects to RecipeRunner

### 3d. Dashboard Entry Point

Add "Build with AI" button/card to [Dashboard.tsx](client/src/components/Dashboard/Dashboard.tsx).

### 3e. New Route

Add `/workflows/ai-builder` to `App.tsx`.

### 3f. i18n

Add translation keys for AI builder UI to [translations.ts](client/src/i18n/translations.ts). The AI assistant itself handles language automatically (instructed to respond in user's language).

---

## Phase 4: Browser Automation Executor (Future)

Implement `BrowserExecutor.ts` with Playwright or Chrome DevTools MCP integration. This is the most complex executor and can be deferred — the AI assistant can still generate browser step placeholders that users fill in manually, or these steps can use the ScriptExecutor with Playwright scripts.

---

## Key Design Decisions

1. **Executor registry pattern**: New step types = implement interface + register. No schema/engine changes.
2. **Dynamic UI from config schemas**: Each executor declares its form fields. Frontend renders dynamically. Adding an executor automatically gives it a config UI.
3. **Backwards compatible**: Zero data migration. Existing workflows work unchanged.
4. **Human-in-the-loop preserved**: All executors produce output → `awaiting_review`. Approve/reject/retry unchanged.
5. **Variable system unchanged**: `{{variable}}` and `{{step_N_output}}` work across all executor types.
6. **Stateless assistant API**: Client manages conversation history. Simple to implement, easy to resume.

---

## Critical Files to Modify

| File | Changes |
|------|---------|
| [server/src/types/index.ts](server/src/types/index.ts) | Widen `StepType`, add `ExecutorConfig` |
| [client/src/types/index.ts](client/src/types/index.ts) | Mirror `StepType` |
| [server/src/models/database.ts](server/src/models/database.ts) | Add `executor_config` column |
| [server/src/services/workflowEngine.ts](server/src/services/workflowEngine.ts) | Replace if/else dispatch with registry |
| [server/src/index.ts](server/src/index.ts) | Register new routes |
| [client/src/components/TemplateEditor/TemplateEditor.tsx](client/src/components/TemplateEditor/TemplateEditor.tsx) | Dynamic step type selector + executor config forms |
| [client/src/components/RecipeBuilder/RecipeBuilder.tsx](client/src/components/RecipeBuilder/RecipeBuilder.tsx) | Step type icons |
| [client/src/components/Dashboard/Dashboard.tsx](client/src/components/Dashboard/Dashboard.tsx) | "Build with AI" entry point |

## New Files to Create

| File | Purpose |
|------|---------|
| `server/src/executors/StepExecutor.ts` | Executor interface |
| `server/src/executors/AIExecutor.ts` | Extracted from workflowEngine |
| `server/src/executors/ScrapingExecutor.ts` | Extracted from workflowEngine |
| `server/src/executors/ScriptExecutor.ts` | Python/Node script runner |
| `server/src/executors/HttpExecutor.ts` | HTTP request executor |
| `server/src/executors/TransformExecutor.ts` | Data transform executor |
| `server/src/executors/registry.ts` | Executor registry |
| `server/src/routes/executors.ts` | `GET /api/executors` |
| `server/src/services/workflowAssistant.ts` | AI workflow generation |
| `server/src/routes/assistant.ts` | Assistant API routes |
| `client/src/components/WorkflowBuilder/AIWorkflowBuilder.tsx` | AI builder UI |

## Verification

1. **Phase 1**: Run existing AI and scraping workflows — they should work identically after refactor
2. **Phase 2**: Create a template with script/HTTP/transform steps via TemplateEditor, execute it
3. **Phase 3**: Use AI builder to generate a multi-step workflow from natural language (test both EN and CN), save and execute it
4. **End-to-end**: Generate the market research workflow from the Chinese description in the user's example, verify it creates appropriate browser/transform/AI steps
