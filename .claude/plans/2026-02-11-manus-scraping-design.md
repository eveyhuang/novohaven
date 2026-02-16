# Replace BrightData with Manus AI for Web Scraping

**Date:** 2026-02-11
**Status:** Approved

## Problem

The current web scraping system uses BrightData, which requires separate dataset IDs and custom integrations for each use case (product reviews, search keywords, bestsellers, Google Trends). Users need flexible, AI-powered scraping that can handle diverse requests via natural language.

## Solution

Replace BrightData (and CSV upload) with Manus AI — an autonomous agent that receives natural language prompts, navigates websites independently, and returns results. This simplifies the architecture and opens up unlimited scraping use cases.

## Key Decisions

- **Full replacement**: Manus replaces both BrightData and CSV upload
- **Flexible input**: Users can provide natural language requests, specific URLs, or both
- **Raw output**: Manus results pass through as-is; downstream workflow steps (AI, transform) handle structuring
- **Async task model**: Create task → poll for completion (same pattern as BrightData, longer timeout)

## Architecture

### Current Flow
```
User provides URLs → BrightData scrapes fixed schema → ReviewData[] → next step
```

### New Flow
```
User provides prompt (+ optional URLs) → Manus executes autonomously → raw output → next step
```

## Changes

### 1. New Service: `server/src/services/manusService.ts`

Replaces `brightDataService.ts`. Wraps the Manus REST API (`https://open.manus.im`).

**Environment variables:**
```
MANUS_API_KEY=<api-key>
MANUS_API_BASE=https://open.manus.im  (default)
```

**Functions:**
- `isManusConfigured()` — checks `MANUS_API_KEY` env var
- `createTask(prompt, fileIds?)` — `POST /v1/tasks`, returns `task_id`
- `getTaskStatus(taskId)` — `GET /v1/tasks/{taskId}`, returns status + result
- `waitForCompletion(taskId, timeoutMs?)` — polls until done/failed, default ~15 min
- `getTaskFiles(taskId)` — fetches output files via file API

**Types:**
```typescript
interface ManusTaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  files?: ManusFile[];
  creditsUsed?: number;
}

interface ManusFile {
  id: string;
  name: string;
  content: string;
  mimeType: string;
}
```

### 2. Updated `ScrapingExecutor`

Simplified from URL/CSV/platform juggling to a thin Manus wrapper.

**New input config:**
- `prompt` (required) — natural language scraping request
- `urls` (optional) — specific URLs appended as context

**Execution flow:**
1. Resolve variables in prompt (`{{variable_name}}`, `{{step_N_output}}`)
2. Build full prompt: user prompt + URLs if provided
3. `manusService.createTask(fullPrompt)`
4. `manusService.waitForCompletion(taskId)`
5. Log usage (`service: "manus"`, credits used)
6. Return raw output as step result

**Output:** `StepExecutorResult.output` is raw Manus response. Metadata includes `{ service: "manus", taskId, creditsUsed }`.

**Removed from executor:** platform detection, CSV parsing, BrightData transformation, ReviewData enforcement, mock data fallback.

### 3. API Routes (`server/src/routes/scraping.ts`)

| Endpoint | Action |
|----------|--------|
| `GET /api/scraping/status` | Keep — returns `{ manus_configured: boolean }` |
| `POST /api/scraping/test` | New — send prompt, get Manus result (for testing prompts) |
| `POST /api/scraping/reviews` | Remove |
| `POST /api/scraping/csv/parse` | Remove |
| `POST /api/scraping/export` | Remove |
| `POST /api/scraping/normalize` | Remove |

### 4. UI Changes

**Replace `ReviewExtractorInput` component with:**
- Prompt textarea ("Describe what you want to scrape...")
- Optional URL input field
- "Test" button → hits `/api/scraping/test` for preview
- Manus connection status indicator

**Remove:** URL textarea with platform validation, CSV drag-and-drop, platform badges, BrightData status.

**Recipe step builder:** input config UI changes from URL/CSV fields to prompt + optional URLs.

**Usage dashboard:** Update service labels from "brightdata"/"csv_upload" to "manus". Update billing formula from per-request+per-record to credits-based.

### 5. Type Changes

**Remove from both server and client types:**
- `ScrapingPlatform`
- `ReviewData`
- `ScrapedProductData`
- `ScrapingResponse`

**Add:** `ManusTaskResult`, `ManusFile`, updated `ScrapingStatus`

**Client API service:** Remove `scrapeReviews()`, `parseCSV()`, `exportReviews()`, `normalizeReviews()`. Add updated `getScrapingStatus()` and `testScraping(prompt, urls?)`.

### 6. Files to Delete
- `server/src/services/brightDataService.ts`
- `server/src/services/csvParserService.ts`

### 7. Files to Rewrite
- `server/src/executors/ScrapingExecutor.ts`
- `server/src/routes/scraping.ts`
- `client/src/components/ReviewAnalysis/ReviewExtractorInput.tsx`
- `client/src/components/ReviewAnalysis/UsageDashboard.tsx` (update labels/billing)
- `server/src/__tests__/executors/ScrapingExecutor.test.ts`

### 8. Database

`api_usage` table unchanged — already supports arbitrary service names. New records use `service: 'manus'`. Old BrightData records remain as history.

### 9. Environment Variables

**Remove:** `BRIGHTDATA_API_KEY`, `BRIGHTDATA_AMAZON_DATASET`, `BRIGHTDATA_WALMART_DATASET`, `BRIGHTDATA_WAYFAIR_DATASET`

**Add:** `MANUS_API_KEY`, `MANUS_API_BASE` (optional, defaults to `https://open.manus.im`)

## Manus API Reference

- Base: `https://open.manus.im`
- Auth: API key header
- Create task: `POST /v1/tasks`
- Get task: `GET /v1/tasks/{task_id}`
- Files: `GET /v1/files/{file_id}`
- Webhooks: `POST /v1/webhooks` (future optimization)
- Pricing: Credit-based per task complexity
- Docs: https://manus.im/docs/integrations/manus-api

## Sources

- [Manus API Docs](https://manus.im/docs/integrations/manus-api)
- [Manus API Reference](https://open.manus.im/docs)
- [Manus Plans & Pricing](https://manus.im/docs/introduction/plans.md)
