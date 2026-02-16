# Browser Chat Debugging Guide

## Debugging Added

I've added comprehensive logging throughout the entire Browser Chat flow to diagnose why the interface isn't showing. Here's what to look for:

## Server-Side Debugging

### 1. ScrapingExecutor (`server/src/executors/ScrapingExecutor.ts`)

When a scraping step starts, you should see:

```
[ScrapingExecutor] Starting execution
[ScrapingExecutor] User inputs: { ... }
[ScrapingExecutor] Step execution ID: <number>
[ScrapingExecutor] Parsed URL list: [...]
[ScrapingExecutor] Detected platform: wayfair
[ScrapingExecutor] Created browser task: <uuid>
[ScrapingExecutor] Retrieved task object, status: created
[ScrapingExecutor] Updating step execution with metadata: {"browserTaskId":"...","stepType":"scraping","platform":"wayfair"}
[ScrapingExecutor] Emitting initial messages to task <uuid>
[ScrapingExecutor] Launching browser...
[ScrapingExecutor] Browser launched successfully
```

**If you DON'T see these logs:** The ScrapingExecutor isn't being invoked. Check if:
- The recipe step has `step_type: 'scraping'`
- The workflow engine is routing to the correct executor

### 2. BrowserService (`server/src/services/browserService.ts`)

You should see:

```
[BrowserService] Created task <uuid>, total active tasks: 1
[BrowserService] Emitting event to task <uuid>: type=message, listeners=0
[BrowserService] Event data: {"role":"system","content":[{"type":"text","text":"Starting browser scraping..."}]}
[BrowserService] launchBrowser called for task <uuid>
[BrowserService] Active browsers: 0/2
[BrowserService] Setting task <uuid> status to 'launching'
[BrowserService] Emitting event to task <uuid>: type=status, listeners=0
```

**Key metric: `listeners=0`** means no SSE clients are connected yet. This is OK initially.

**If you see `listeners=1` or more:** Good! The SSE client has connected.

### 3. Database Update (`server/src/models/database.ts`)

You should see:

```
[DB] updateStepExecution: id=<number>, status=running, outputData={"browserTaskId":"...","stepType":"scraping"...
```

**If you DON'T see this:** The database isn't being updated with the browserTaskId, so the frontend won't know to show BrowserChat.

### 4. SSE Endpoint (`server/src/routes/browser.ts`)

When a client connects to the SSE stream:

```
[Browser SSE] Client attempting to connect to task <uuid>, userId: <number>
[Browser SSE] Task <uuid> found, status: created
[Browser SSE] Sending initial connection event
[Browser SSE] Attaching progress listener to task <uuid>
[Browser SSE] Current listener count: 1
```

Then when events are emitted:

```
[Browser SSE] Received progress event: type=message
[Browser SSE] Sending event to client: type=message
[Browser SSE] Received progress event: type=status
[Browser SSE] Sending event to client: type=status
```

**If you DON'T see "Client attempting to connect":** The frontend isn't connecting to the SSE endpoint. Check the client-side logs.

**If you see "Task not found":** The browserTaskId from the frontend doesn't match any task in memory. Possible timing issue or task was destroyed too early.

## Client-Side Debugging (Browser Console)

### 1. ExecutionView Polling

Every 3 seconds during execution:

```
[ScrapingOrSpinner] Checking step output_data: {"browserTaskId":"...","stepType":"scraping","platform":"wayfair"}
[ScrapingOrSpinner] Parsed output_data: {browserTaskId: "...", stepType: "scraping", ...}
[ScrapingOrSpinner] Extracted IDs: {browserTaskId: "...", manusTaskId: null}
[ScrapingOrSpinner] Rendering BrowserChat with taskId: <uuid>
```

**If you see "No output_data found":** The database update didn't work or the frontend polling isn't picking it up.

**If you see "No taskId found, showing spinner":** Either:
- `output_data` doesn't contain `browserTaskId`
- JSON parsing failed
- The field name is wrong

### 2. BrowserChat Component

When BrowserChat mounts:

```
[BrowserChat] useEffect for external task, externalTaskId: <uuid>, hasEventSource: false
[BrowserChat] Connecting to external task: <uuid>
[BrowserChat] connectStream called with taskId: <uuid>
[BrowserChat] Creating new EventSource connection
[BrowserChat] All event listeners attached
```

When events are received:

```
[BrowserChat] Received status event: {"status":"connected","taskId":"..."}
[BrowserChat] Received message event: {"role":"system","content":[{"type":"text","text":"Starting browser scraping..."}]}
[BrowserChat] Adding message to state: {id: "...", role: "system", content: [...]}
```

**If you DON'T see "useEffect for external task":** BrowserChat component isn't mounting.

**If you DON'T see "Creating new EventSource connection":** The component mounted but the connection logic isn't running.

**If you see "SSE connection error":** Network issue or authentication problem with the SSE endpoint.

## Testing Flow

### Step 1: Run a Scraping Recipe

1. Open your browser's Developer Console (F12)
2. Go to the Network tab and filter by "stream" to see SSE connections
3. Run a recipe with a Browser Scraping step
4. Provide URLs and start the workflow

### Step 2: Check Server Logs

In your terminal where `npm run dev` is running, watch for the logs in this order:

```
[ScrapingExecutor] Starting execution
[ScrapingExecutor] Created browser task: <uuid>
[DB] updateStepExecution: id=X, status=running, outputData={"browserTaskId":"..."}
[BrowserService] Emitting event to task <uuid>: type=message
[Browser SSE] Client attempting to connect to task <uuid>
[Browser SSE] Current listener count: 1
[BrowserService] Emitting event to task <uuid>: type=message, listeners=1
[Browser SSE] Received progress event: type=message
[Browser SSE] Sending event to client: type=message
```

### Step 3: Check Browser Console

In the browser console, look for:

```
[ScrapingOrSpinner] Rendering BrowserChat with taskId: <uuid>
[BrowserChat] connectStream called with taskId: <uuid>
[BrowserChat] Received message event: {...}
```

## Common Issues & Diagnosis

### Issue 1: No Server Logs at All

**Symptom:** No `[ScrapingExecutor]` logs appear

**Diagnosis:**
- Recipe step doesn't have correct `step_type`
- Workflow engine isn't routing correctly
- Check the recipe configuration

### Issue 2: Task Created But No SSE Connection

**Symptom:** See `[ScrapingExecutor]` and `[BrowserService]` logs, but no `[Browser SSE] Client attempting to connect`

**Diagnosis:**
- Frontend isn't polling
- Frontend can't parse `output_data`
- Check browser console for errors

### Issue 3: SSE Connects But No Messages

**Symptom:** See `[Browser SSE] Client attempting to connect` but no `[Browser SSE] Received progress event`

**Diagnosis:**
- Events are being emitted before client connects (timing issue)
- EventEmitter listener not attached properly
- Check `listener count` - should be > 0

### Issue 4: BrowserChat Component Not Rendering

**Symptom:** No `[ScrapingOrSpinner] Rendering BrowserChat` in browser console

**Diagnosis:**
- `output_data` doesn't contain `browserTaskId`
- Step status isn't `running`
- ExecutionView not detecting the task type

### Issue 5: Task Not Found

**Symptom:** `[Browser SSE] Task <uuid> not found`

**Diagnosis:**
- Frontend has wrong taskId (typo/corruption)
- Task was destroyed before frontend connected
- Timing issue - task created after frontend tried to connect

## Quick Diagnostic Checklist

Run through this checklist in order:

1. ☐ Server logs show `[ScrapingExecutor] Starting execution`
2. ☐ Server logs show `[ScrapingExecutor] Created browser task: <uuid>`
3. ☐ Server logs show `[DB] updateStepExecution` with browserTaskId in outputData
4. ☐ Browser console shows `[ScrapingOrSpinner] Extracted IDs: {browserTaskId: "..."}`
5. ☐ Browser console shows `[ScrapingOrSpinner] Rendering BrowserChat`
6. ☐ Browser console shows `[BrowserChat] connectStream called`
7. ☐ Server logs show `[Browser SSE] Client attempting to connect`
8. ☐ Server logs show `[Browser SSE] Current listener count: 1` (or more)
9. ☐ Server logs show `[BrowserService] Emitting event... listeners=1` (or more)
10. ☐ Server logs show `[Browser SSE] Received progress event`
11. ☐ Browser console shows `[BrowserChat] Received message event`

**Where the chain breaks = where the problem is!**

## Network Tab Analysis

In Chrome DevTools Network tab:

1. Filter by "stream"
2. You should see a request to `/api/browser/tasks/<uuid>/stream`
3. Type: "eventsource"
4. Status: "200" (pending)
5. Click on it and go to "EventStream" tab
6. You should see events flowing in real-time

If the request:
- **Never appears:** Frontend isn't trying to connect
- **404:** TaskId is wrong or task doesn't exist
- **401:** Authentication issue
- **Closes immediately:** Server-side error or task destroyed

## Next Steps

After running a test:

1. **Share the server logs** - Copy all logs from when you start the workflow
2. **Share browser console logs** - Copy all logs from the browser console
3. **Check Network tab** - Screenshot or describe the SSE request status

This will tell us exactly where the flow is breaking!
