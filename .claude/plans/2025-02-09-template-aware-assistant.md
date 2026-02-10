# Plan: Template-Aware Workflow Assistant

## Context

The workflow assistant (`workflowAssistant.ts`) currently generates all workflows from scratch. It has no knowledge of existing templates, even when the user's request closely matches a pre-built template. This leads to:

- Redundant generation when a template already exists
- Loss of curated configs (BrightData API settings, Python scripts) that the AI can't reliably reproduce
- Missed opportunity to combine proven template steps with new AI-generated steps

## Design

### Approach: Contextual Template Awareness

The assistant gains three modes of template usage, chosen contextually:

1. **Recommend as-is** — exact match, suggest running the template directly
2. **Recommend + customize** — partial match, suggest the template with modifications
3. **Use as building blocks** — pull individual steps from templates, combine with new steps

**Scope**: Templates only (`is_template = 1`). User-created recipes are excluded to avoid referencing broken or in-progress workflows.

### Data Flow

**Layer 1 — Template summaries in system prompt.** `buildSystemPrompt(userId)` queries all templates and includes a compact summary: ID, name, description, step types. Minimal token cost.

**Layer 2 — Full details on demand.** When the AI needs full template details, it emits a `template-request` block. The backend fetches full step data and injects it into a follow-up message. A second AI call produces the actual workflow.

**Layer 3 — Hybrid merge on save.** Steps sourced from templates are marked with `from_template_id` and `from_step_order`. The backend pulls real configs from the DB, only applying AI-specified overrides. Scripts, API configs, and complex prompts are never passed through the AI.

---

## Implementation Details

### 1. System Prompt Changes

`buildSystemPrompt()` gains a `userId` parameter and appends a template summary section:

```
## Available Templates

You have access to pre-built templates. When a user's request matches or partially matches
a template, reference it instead of generating from scratch.

Templates:
- ID 1: "Image Style Analyzer" — Analyze photography style for AI image generation. Steps: [ai]
- ID 3: "Amazon Review Extractor" — Extract reviews from Amazon URLs via BrightData. Steps: [scraping]
- ID 4: "Product Review Analyzer" — Analyze product reviews for sentiment & insights. Steps: [ai]

### When to use templates:
- **Exact match**: Recommend as-is, ask if user wants to run it directly
- **Partial match**: Suggest customizing (add/remove/modify steps)
- **Building blocks**: Pull specific steps from multiple templates, combine with new ones

### How to get template details:
Include a ```template-request block with template IDs as a JSON array.

### How to use a template step:
In your workflow-json, mark the step with "from_template_id" and "from_step_order".
You can override specific fields by listing them in "override_fields".
```

### 2. Template Detail Retrieval (Two-Pass)

`parseAssistantResponse()` gains extraction for `template-request` blocks:

```typescript
interface AssistantResponse {
  message: string;
  workflow?: GeneratedWorkflow;
  suggestions?: string[];
  templateRequest?: number[];  // NEW: template IDs the AI wants details for
}
```

`generateWorkflow()` handles the two-pass flow:

1. First AI call returns a `template-request`
2. Backend fetches full template data (steps with configs, prompts, scripts)
3. Injects as a follow-up message with a note: "Reference these steps using from_template_id rather than regenerating the config."
4. Second AI call produces the `workflow-json`
5. Two-pass logic is invisible to the frontend

### 3. Hybrid Merge on Save

`GeneratedStep` gains template reference fields:

```typescript
interface GeneratedStep {
  step_name: string;
  step_type: string;
  ai_model: string;
  prompt_template: string;
  output_format: 'text' | 'json' | 'markdown' | 'image';
  executor_config?: Record<string, any>;
  // Template sourcing
  from_template_id?: number;
  from_step_order?: number;
  override_fields?: string[];  // which fields the AI explicitly changed
}
```

`saveWorkflowAsRecipe()` merge logic:

1. Fetch source step from DB: `getStepsByRecipeId(from_template_id)` → find by `from_step_order`
2. Use DB step's `prompt_template`, `executor_config`, `api_config`, `model_config`, `input_config` as base
3. Apply AI's values only for fields listed in `override_fields`
4. Write merged step to new recipe

Example AI output:
```json
{
  "step_name": "Scrape Amazon Reviews",
  "step_type": "scraping",
  "from_template_id": 3,
  "from_step_order": 1,
  "override_fields": ["step_name"]
}
```
Result: full BrightData `api_config` from template 3, custom step name from AI.

---

## Files to Modify

| File | Changes |
|------|---------|
| `server/src/services/workflowAssistant.ts` | `buildSystemPrompt()` accepts userId, queries templates. `parseAssistantResponse()` extracts `template-request`. `generateWorkflow()` gains two-pass logic and userId param. `saveWorkflowAsRecipe()` gains hybrid merge. `GeneratedStep` gets template reference fields. |
| `server/src/routes/assistant.ts` | Pass userId to `generateWorkflow()` |

## No Changes Needed

- **No new files** — entirely contained in existing service + route
- **No DB changes** — existing queries (`getRecipesByUser`, `getStepsByRecipeId`) suffice
- **No frontend changes** — two-pass logic invisible to client, saved steps look identical

## Verification

1. Ask assistant to "extract Amazon reviews" → should recommend the existing Review Extractor template as-is
2. Ask assistant to "scrape reviews and analyze them" → should combine Review Extractor (template) + Review Analyzer (template) steps
3. Ask assistant to "scrape reviews, clean duplicates, then analyze" → should use template steps for scraping + analysis, generate a new transform step for dedup
4. Save a workflow with template-sourced scraping step → verify `api_config` matches the original template exactly
5. Ask something with no template match (e.g., "translate documents") → should generate from scratch as before
