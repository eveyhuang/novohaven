# Manus AI Agent Template Integration

## Context
Users frequently run similar Manus AI agent prompts (e.g., "analyze trends for X products"). They want to save these as reusable templates with `{{variables}}` they can swap each run, plus have these templates work within multi-step workflows.

## Approach
Create a new `ManusExecutor` (type: `'manus'`) that plugs into the existing executor plugin system. This executor uses `compilePrompt()` from `promptParser.ts` to resolve `{{variables}}` before sending to Manus — something the existing `ScrapingExecutor` doesn't do. The existing `ScrapingExecutor` stays as-is for quick scraping tasks with URL config.

**No database changes needed** — the existing `recipes`/`recipe_steps` schema already supports everything.

---

## Phase 1: Backend — ManusExecutor

### 1.1 Create `server/src/executors/ManusExecutor.ts`
New executor implementing `StepExecutor` interface:
- `type = 'manus'`, `displayName = 'Manus Agent'`, `icon = '🧠'`
- `execute()`: Calls `compilePrompt()` to resolve `{{variables}}` + `{{step_N_output}}` + company standards, then `createTask(compiledPrompt)` from manusService
- Stores `manusTaskId` in step execution metadata early (same pattern as `ScrapingExecutor:63-64`) so ExecutionView can connect SSE stream
- Calls `waitForCompletion()`, logs usage, returns result
- `getConfigSchema()`: Returns `prompt_template` field (textarea)
- Reuses: `compilePrompt` from `promptParser.ts`, `createTask`/`waitForCompletion`/`isManusConfigured` from `manusService.ts`

### 1.2 Register in `server/src/executors/registry.ts`
- Import `ManusExecutor` and call `registerExecutor(new ManusExecutor())`

### 1.3 Update StepType in both type files
- `server/src/types/index.ts`: Add `'manus'` to StepType union
- `client/src/types/index.ts`: Add `'manus'` to StepType union

---

## Phase 2: Template Editor UI — Manus Config Panel

### 2.1 Modify `client/src/components/TemplateEditor/TemplateEditor.tsx`
Add a `manus` branch between the `scraping` and `ai` branches (~line 627):
- Prompt template textarea (reuses existing `promptTextAreaRef`)
- Variable help button (reuses existing `setShowVariableHelp`)
- "How it works" info box (variables replaced at runtime → agent executes → user can interact)
- Output format selector (text/markdown/json)
- No model selection needed (Manus handles that internally)
- Update save validation to require `prompt_template` for `manus` type (alongside `ai`)

The Input Variables section (line 725+) already auto-extracts variables from `prompt_template`, so it works automatically for `manus` steps.

---

## Phase 3: Manus Agent Page — Template Picker

### 3.1 Modify `client/src/components/ManusAgent/ManusAgentPage.tsx`
Add a collapsible template picker sidebar:

**Layout**: Header with "Templates" toggle button → two-column layout (sidebar + ManusChat)

**Template sidebar** (left, ~320px, collapsible):
- Fetches all recipes, filters to `is_template` with step_type `'manus'`
- Loads full recipe on selection to get steps + input_config
- Shows variable input form using existing `DynamicInput` patterns from RecipeRunner
- "Run with Template" button compiles prompt client-side (string replacement)
- Uses `key={manusKey}` pattern to remount ManusChat with `initialPrompt={compiledPrompt}`

**ManusChat** (right, main area):
- Same as today when no template selected (freeform prompt)
- When template run: receives compiled prompt as `initialPrompt`, auto-starts task
- User can still interact (verification, follow-ups) during execution

### 3.2 Add server endpoint `POST /api/manus/tasks/from-template` (in `server/src/routes/manus.ts`)
Server-side prompt compilation (resolves company standards the client can't access):
- Accepts `{ templateId, variables }`
- Loads template + step, calls `compilePrompt()` with variables
- Creates Manus task, returns `{ taskId, compiledPrompt }`

### 3.3 Add client API method in `client/src/services/api.ts`
- `startManusTaskFromTemplate(templateId, variables)` → POST `/manus/tasks/from-template`

---

## Phase 4: i18n Translations

### 4.1 Modify `client/src/i18n/translations.ts`
Add ~20 keys in both EN and ZH for:
- Manus template editor config panel strings
- Manus Agent page template picker strings
- How-it-works descriptions

---

## What Already Works (No Changes Needed)
- **Workflow execution**: `workflowEngine.ts` dispatches via `getExecutor(step.step_type)` — `'manus'` routes to ManusExecutor automatically
- **ExecutionView**: Already detects `manusTaskId` in step output_data and embeds ManusChat (~line 454)
- **RecipeBuilder**: Step type selector fetches executors dynamically — `'manus'` appears automatically
- **RecipeRunner**: Variable input form extracts from `prompt_template` — works for `manus` steps
- **promptParser.ts**: Handles all variable types — used directly by ManusExecutor
- **Executors API** (`/api/executors`): Returns all registered executors automatically

---

## End-to-End Flows

**A) Create + Run from Dashboard:**
1. Create template → TemplateEditor → select "Manus Agent" → write prompt with `{{product_type}}` → save
2. Run → RecipeRunner → fill `product_type = "wireless earbuds"` → Start
3. WorkflowEngine → ManusExecutor → compiles prompt → creates Manus task
4. ExecutionView shows ManusChat embedded → user watches/interacts → approves result

**B) Run from Manus Agent Page:**
1. Navigate to `/manus` → click "Templates" → select template
2. Fill variables in sidebar form → "Run with Template"
3. ManusChat auto-starts with compiled prompt → real-time interaction
4. Result saved to `manus_outputs`

**C) Within Multi-Step Workflow:**
1. RecipeBuilder → add Manus step with `Research {{step_1_output}} competitors`
2. Run workflow → AI step produces output → ManusExecutor resolves `{{step_1_output}}`
3. ManusChat embeds in ExecutionView for that step → user interacts → approves → next step

---

## Files Summary

| File | Action | What |
|------|--------|------|
| `server/src/executors/ManusExecutor.ts` | CREATE | Core executor with prompt compilation |
| `server/src/executors/registry.ts` | EDIT | Register ManusExecutor |
| `server/src/types/index.ts` | EDIT | Add 'manus' to StepType |
| `client/src/types/index.ts` | EDIT | Add 'manus' to StepType |
| `client/src/components/TemplateEditor/TemplateEditor.tsx` | EDIT | Manus config panel |
| `client/src/components/ManusAgent/ManusAgentPage.tsx` | EDIT | Template picker sidebar |
| `server/src/routes/manus.ts` | EDIT | /tasks/from-template endpoint |
| `client/src/services/api.ts` | EDIT | startManusTaskFromTemplate() |
| `client/src/i18n/translations.ts` | EDIT | New translation keys |

## Verification
1. Create a Manus template with `{{product_type}}` variable in TemplateEditor
2. Run from RecipeRunner — verify variable form, execution, ManusChat embedding
3. Run from Manus Agent page template picker — verify sidebar, variable form, chat auto-start
4. Add Manus step to multi-step workflow — verify `{{step_N_output}}` resolution
5. Verify i18n in both EN and ZH
