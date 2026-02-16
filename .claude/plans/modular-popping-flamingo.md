# Unified Chat Execution Interface

## Context

The current `ExecutionView` uses a sidebar+panel layout with a single interface for all step types. This breaks down for interactive steps (Manus agent replies, browser CAPTCHA resolution) and doesn't naturally support multi-step recipes that mix AI, scraping, and Manus types. The `ScrapingOrSpinner` component already has to sniff `output_data` for task IDs to decide what to render — a sign the abstraction is wrong.

**Goal:** Replace `ExecutionView` with a unified chat-based execution interface where workflow execution is modeled as a conversation. All step types render as messages in a scrolling thread. A top progress bar provides step-level orientation.

## Design Decisions (User-Confirmed)

- Non-interactive steps (AI, HTTP, transform, script) **auto-run** and appear as system messages — no approval pause
- Interactive steps (Manus, scraping) **pause for user approval** inline
- **Replace** ExecutionView + standalone Manus page; **keep** AI Workflow Builder separate
- **Top progress bar** (step dots) for multi-step navigation, clicking scrolls to step
- **Edit modal** (existing pattern) for reject/modify/retry flow
- **Single chat input** at bottom — context determines recipient (Manus agent vs workflow)
- `/manus` page stays as a shortcut that creates a single-step execution and redirects to chat
- No per-recipe "careful mode" toggle — keep it simple

## Architecture: Message-Centric

### 1. Unified Message Protocol

New type shared between server and client:

```typescript
interface ExecutionChatMessage {
  id: string;                    // unique message id (uuid)
  executionId: number;
  stepOrder: number;
  stepName: string;
  stepType: StepType;

  type: 'step-start' | 'progress' | 'agent-message' | 'user-message'
      | 'step-output' | 'step-error' | 'action-required'
      | 'step-approved' | 'step-rejected' | 'execution-complete';

  role: 'system' | 'assistant' | 'user';
  content: string;
  metadata?: {
    taskId?: string;            // browserTaskId or manusTaskId
    images?: GeneratedImage[];
    files?: ManusFile[];
    usage?: { promptTokens: number; completionTokens: number };
    model?: string;
    actionType?: 'approve' | 'captcha' | 'take-control';
    debuggerUrl?: string;
    isJson?: boolean;
    stepExecutionId?: number;   // for approve/reject API calls
  };
  timestamp: string;
}
```

### 2. Backend: Execution Event Emitter + SSE Endpoint

**New file:** `server/src/services/executionEvents.ts`
- `ExecutionEventEmitter` class wrapping Node `EventEmitter`, keyed by execution ID
- Methods: `emit(executionId, message)`, `subscribe(executionId, callback)`, `unsubscribe(executionId, callback)`
- Lifecycle: created when execution starts, cleaned up when execution completes/fails

**New file:** `server/src/routes/executionStream.ts`
- `GET /api/executions/:id/stream` — SSE endpoint
- Subscribes to `ExecutionEventEmitter` for the given execution
- Writes `ExecutionChatMessage` events to the response as `data: JSON\n\n`

**Modified:** `server/src/services/workflowEngine.ts`
- Import and use `ExecutionEventEmitter`
- When starting a step: emit `step-start` message
- When step completes: emit `step-output` message
- When step fails: emit `step-error` message
- **Auto-run logic:** After step output, check step type:
  - `ai`, `script`, `http`, `transform` → auto-approve, continue to next step
  - `scraping`, `manus` → set `awaiting_review`, emit `action-required`
- When execution completes: emit `execution-complete`

**Modified:** `server/src/executors/ManusExecutor.ts`
- Accept `ExecutionEventEmitter` via context
- Subscribe to Manus task SSE stream internally
- Re-emit Manus messages as `agent-message` and `action-required` (take-control) to the execution emitter

**Modified:** `server/src/executors/ScrapingExecutor.ts`
- Accept `ExecutionEventEmitter` via context
- Subscribe to browser task SSE stream internally
- Re-emit browser progress as `progress` and `action-required` (CAPTCHA) to the execution emitter

**New endpoint:** `GET /api/manus/tasks/:id/messages`
- Returns stored Manus conversation history for chat reconstruction on page reload

**Kept as-is:** Existing `/api/browser/tasks/:id/stream` and `/api/manus/tasks/:id/stream` for standalone use

### 3. Frontend: ChatExecution Component

**New file:** `client/src/components/ChatExecution/ChatExecution.tsx`

```
<ChatExecution>
  <StepProgressBar />          // Clickable step dots at top
  <ChatMessageList />          // Scrolling message thread
    <StepHeaderMessage />      // Divider: "--- Step 1: Scrape Reviews ---"
    <SystemMessage />          // Auto-run outputs, progress
    <AgentMessage />           // Manus responses (markdown rendered)
    <UserMessage />            // User replies
    <OutputMessage />          // Final step result (markdown/JSON/images)
    <ActionMessage />          // Inline approve/reject buttons, CAPTCHA alert
    <ErrorMessage />           // Failure with retry button
  <ChatInput />                // Single input, context-aware routing
  <PromptEditModal />          // Existing modal pattern for edit+retry
```

**State:** `messages: ExecutionChatMessage[]` array

**Initialization flow:**
1. Fetch `GET /api/executions/:id` → reconstruct messages from step executions
2. For Manus steps with `manusTaskId`, fetch `GET /api/manus/tasks/:id/messages` to get conversation history
3. Open SSE to `GET /api/executions/:id/stream` for real-time updates
4. Append new SSE events to messages array

**ChatInput routing:**
- During active Manus step → `POST /api/manus/tasks/:taskId/reply`
- No active step needing input → input disabled or hidden
- Approval/rejection → handled by buttons in `ActionMessage`, not the text input

**Message renderers by type:**
| Message type | Renderer | Content |
|---|---|---|
| `step-start` | `StepHeaderMessage` | Step name + type icon as divider |
| `progress` | `SystemMessage` | Scraping progress, status updates |
| `agent-message` | `AgentMessage` | Manus markdown response in assistant bubble |
| `user-message` | `UserMessage` | User text in right-aligned bubble |
| `step-output` | `OutputMessage` | Markdown/JSON/images with copy button |
| `step-error` | `ErrorMessage` | Error text + retry button |
| `action-required` | `ActionMessage` | Approve/Reject buttons, CAPTCHA link, take-control |
| `step-approved` | `SystemMessage` | "Step approved, continuing..." |
| `step-rejected` | `SystemMessage` | "Step rejected" |
| `execution-complete` | `SystemMessage` | "All steps complete" summary |

### 4. StepProgressBar

Minimal top bar showing step dots:
- Each dot = one step, colored by status (gray=pending, blue=running, green=done, red=failed, purple=review)
- Clicking a dot scrolls the message list to that step's `step-start` message
- Shows "Step 2 of 5" label next to dots

### 5. Routes & Navigation

| Route | Change |
|---|---|
| `/executions/:id` | Renders `<ChatExecution>` instead of `<ExecutionView>` |
| `/manus` | Simplified: text input → creates single-step manus execution → redirects to `/executions/:id` |
| `/workflows/ai-builder` | No change |
| `/recipes/:id/run` | No change (creates execution, redirects to `/executions/:id`) |
| `/executions` | No change (execution list) |

### 6. Files to Delete

- `client/src/components/WorkflowExecution/ExecutionView.tsx` — replaced by ChatExecution
- `client/src/components/ManusChat/ManusChat.tsx` — SSE logic absorbed into execution stream
- `client/src/components/BrowserChat/BrowserChat.tsx` — SSE logic absorbed into execution stream
- Standalone Manus page component (the full page, not the shortcut)

### 7. Files to Create

- `server/src/services/executionEvents.ts` — ExecutionEventEmitter
- `server/src/routes/executionStream.ts` — SSE endpoint
- `client/src/components/ChatExecution/ChatExecution.tsx` — main component
- `client/src/components/ChatExecution/StepProgressBar.tsx`
- `client/src/components/ChatExecution/ChatMessageList.tsx`
- `client/src/components/ChatExecution/ChatInput.tsx`
- `client/src/components/ChatExecution/messages/` — individual message renderers
- Shared types file update for `ExecutionChatMessage`

### 8. Files to Modify

- `server/src/services/workflowEngine.ts` — integrate EventEmitter, auto-run logic
- `server/src/executors/ManusExecutor.ts` — re-emit to execution events
- `server/src/executors/ScrapingExecutor.ts` — re-emit to execution events
- `server/src/executors/StepExecutor.ts` — add optional emitter to context
- `server/src/routes/manus.ts` — add messages endpoint
- `server/src/app.ts` or `server/src/index.ts` — register new SSE route
- `client/src/App.tsx` — update route for `/executions/:id`
- `client/src/types/index.ts` — add ExecutionChatMessage type
- `server/src/types/index.ts` — add ExecutionChatMessage type
- Manus standalone page — simplify to shortcut

## Verification

1. **Single-step AI template:** Execute → chat shows step-start, auto-runs, shows output. No approval needed.
2. **Single-step Manus template:** Execute → chat streams Manus messages, user can reply, sees completion, approves inline.
3. **Multi-step mixed recipe (AI + Scraping + AI):** Execute → Step 1 auto-runs, Step 2 shows scraping progress + CAPTCHA handling + approval, Step 3 auto-runs using Step 2 output.
4. **Page reload mid-execution:** Navigate away and back → chat reconstructs full history from DB + Manus message history.
5. **Reject + retry:** Reject a step → edit modal → retry → new output appears in chat.
6. **/manus shortcut:** Type a task → creates execution → opens chat → Manus runs as single step.
7. **Progress bar:** Click step dots → scrolls to correct position in chat.
8. **Execution list:** Existing `/executions` page still works, links open new chat view.
