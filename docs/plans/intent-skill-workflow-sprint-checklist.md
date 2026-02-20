# Intent-First Skills/Workflows Implementation Checklist

## Scope Guardrails
- Do not change core architecture:
  - Gateway/session/agent process model
  - Plugin model (channel/tool/memory/provider)
  - Step executor architecture
  - Existing `/api/skills`, `/api/workflows`, `/api/executions`, `/api/assistant/*` route shapes
- Keep backward compatibility for existing skills/workflows and legacy step types.

## PR Sequence
- PR1: UI filtering + intent-first authoring
- PR2: assistant decomposition (manager SOP -> reusable skills + chained workflow)
- PR3: deterministic routing + strict required-input gating
- PR4: browser executor runtime alignment for browser scraping skills
- PR5: end-to-end and backend tests + release gates

---

## Sprint 1 (PR1) - UI Filtering + Intent-First Authoring

### Goal
Make skill creation non-technical by default while preserving advanced/internal capabilities.

### Files
- `client/src/components/SkillEditor/SkillEditor.tsx`
- `client/src/components/common/ExecutorConfigFields.tsx`
- `client/src/services/api.ts`
- `server/src/routes/executors.ts`

### Tasks
- Add `authoring_mode` in Skill Builder (`intent` default).
- In default mode, only show:
  - `ai`
  - `scraping` (browser scraping)
  - `manus`
- Hide `script`, `http`, `transform` behind explicit `Advanced/Internal` toggle.
- Keep payload format unchanged (`steps`, `step_type`, `executor_config`).
- Optional non-breaking backend enhancement:
  - support `GET /api/executors?mode=business` to return user-facing subset.

### Acceptance
- Normal user flow cannot accidentally pick script/http/transform.
- Existing advanced skills still load and run.
- Client and server builds pass.

---

## Sprint 2 (PR2) - Assistant Decomposition

### Goal
Convert manager natural-language SOP into reusable skills and coherent workflows.

### Files
- `server/src/services/workflowAssistant.ts`
- `server/src/routes/assistant.ts`
- `client/src/components/WorkflowBuilder/AIWorkflowBuilder.tsx`

### Tasks
- Update assistant prompting and parsing to generate:
  - reusable skill blocks (single-purpose)
  - workflow chain referencing those skills
  - explicit input/output contracts per generated block
- Preserve existing save path:
  - `/api/assistant/save`
  - `saveWorkflowGraph(...)`
- Show clearer workflow preview metadata:
  - step source (from skill vs generated)
  - per-step model assignment

### Acceptance
- Chinese SOP example for market research generates usable multi-step workflow plan.
- Saved result remains compatible with current `skills/workflows/skill_steps` tables.
- No route or schema breakage.

---

## Sprint 3 (PR3) - Routing + Required Input Gating

### Goal
Ensure short analyst prompts reliably trigger correct published assets and collect only required inputs.

### Files
- `server/src/agent/PromptBuilder.ts`
- `server/src/plugins/builtin/tool-skill-manager/index.ts`
- `server/src/agent/ToolExecutor.ts` (only if needed for tool-rule alignment)

### Tasks
- Improve relevance ranking in skill/workflow suggestions using:
  - name
  - description
  - tags
  - required output expectation
- In `skill_execute`:
  - block only on missing required inputs
  - never re-ask optional inputs
  - enforce output artifact checks for completion (for CSV tasks, require actual CSV path/artifact)
- Keep provider adapters/tool loop architecture unchanged.

### Acceptance
- Prompt like `Investigate smart home trends` (or equivalent Chinese prompt) routes to expected workflow.
- Agent asks only required fields and proceeds without optional ones.
- Completion message is not accepted without real artifact generation.

---

## Sprint 4 (PR4) - Browser Executor Runtime Alignment

### Goal
Ensure "Browser Scraping" skill type has a first-class, stable execution path.

### Files
- `server/src/executors/BrowserExecutor.ts` (new)
- `server/src/executors/registry.ts`
- `server/src/services/workflowEngine.ts` (minimal support if required)
- `client/src/components/SkillEditor/SkillEditor.tsx` (if schema/UI binding update needed)

### Tasks
- Implement `BrowserExecutor` under existing executor interface.
- Register executor in existing registry.
- Reuse existing browser capabilities/services for:
  - navigate
  - click
  - type
  - scroll
  - extract
- Add business-level configuration schema for browser scraping tasks and CSV output contract.
- Keep current `ScrapingExecutor` for backward compatibility.

### Acceptance
- Browser scraping skill runs end-to-end and returns structured extracted rows.
- CSV is actually produced and discoverable in Outputs.
- No architecture change beyond adding one executor plugin.

---

## Sprint 5 (PR5) - Test Coverage + Release Gates

### Goal
Lock behavior with automated checks before rollout.

### Files
- `docs/user-stories-web-tests.md`
- `e2e/run-user-stories.cjs`
- `server/src/__tests__/*`

### Tasks
- Add/update user stories for:
  - manager SOP decomposition
  - analyst short-prompt routing
  - required vs optional input handling
  - browser tool execution producing real CSV output
- Implement/refresh Playwright cases and mark pass/fail in story doc.
- Add backend tests for:
  - `skill_execute` required-input logic
  - output artifact enforcement
  - workflow assistant decomposition parse/validation

### Acceptance
- Critical scenarios pass with deterministic assertions.
- Failures include observed behavior notes in story doc.
- Release checklist includes rollback switch (UI fallback to advanced mode if needed).

---

## Tracking Template (per PR)

### PRN
- Branch:
- Owner:
- Linked stories:
- Risk level:
- Migrations:
- Rollback:
- Verification commands:
  - `npm --prefix server run build`
  - `npm --prefix client run build`
  - `node e2e/run-user-stories.cjs --stories=<ids>`

