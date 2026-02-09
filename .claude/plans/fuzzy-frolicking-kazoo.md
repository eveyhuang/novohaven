# Fix: AI Workflow Builder — Truncated JSON Causes Empty Preview Panel

## Context

The AI assistant IS returning a `workflow-json` code block, but for complex multi-step workflows (10 steps with long Chinese prompts), the response gets **truncated** at `maxTokens: 4000`. The JSON is cut off mid-token, `JSON.parse()` fails silently, `response.workflow` stays `undefined`, and the right panel remains empty.

Evidence: the user's pasted response ends at `'sources': source_` — clearly truncated mid-variable name.

**Previous changes already applied** (system message + multi-turn + robust parsing): these are in place and correct, but insufficient alone because the token limit causes truncation before parsing even runs.

## Changes

### 1. Increase `maxTokens` in `generateWorkflow()`
**File**: [server/src/services/workflowAssistant.ts:266](server/src/services/workflowAssistant.ts#L266)

Change `maxTokens: 4000` → `maxTokens: 16000`

A 10-step workflow with detailed Chinese prompt_templates in each step easily needs 8000-12000 tokens for the JSON alone, plus the conversational explanation. 16000 gives comfortable headroom. All configured models support this (Gemini: 1M, Claude: 200K, GPT-4o: 128K).

### 2. Add system prompt instruction to keep prompts concise
**File**: [server/src/services/workflowAssistant.ts](server/src/services/workflowAssistant.ts) — in `buildSystemPrompt()`

Add instruction: For AI steps, write **focused** prompt templates — include essential instructions but avoid excessive examples or verbose formatting guidelines that inflate the JSON size.

### 3. Add server-side logging for truncation debugging
**File**: [server/src/services/workflowAssistant.ts](server/src/services/workflowAssistant.ts) — in `generateWorkflow()` after AI response

Add a `console.warn` when `response.content` doesn't contain a valid workflow-json block — helps debug future truncation issues.

## Files modified
- `server/src/services/workflowAssistant.ts` — increase maxTokens, add conciseness instruction, add debug logging

## Verification
1. Build: `cd server && npx tsc --noEmit`
2. Tests: `cd server && npx jest`
3. Restart server, go to AI Workflow Builder, enter a complex multi-step workflow request
4. Verify the right panel populates with all steps
5. Check server logs — no truncation warnings
