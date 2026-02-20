# Agent Chat Image Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show agent-generated images inline in chat with a download button, and restore user-uploaded image previews when switching back to a previous session.

**Architecture:** Generated and uploaded images are written to `server/uploads/session-<id>/` on disk; a tiny file URL flows through IPC → SSE → frontend; the browser fetches the image directly from a static file endpoint, enabling both inline preview and full-resolution download.

**Tech Stack:** Node.js `fs`, Express static middleware, better-sqlite3, React, TypeScript, SSE (EventSource)

---

## Context

### Key file paths

| File | Role |
|------|------|
| `server/src/index.ts` | Express server entry — add static uploads route |
| `server/src/plugins/builtin/channel-web/index.ts` | Web channel — save user-uploaded base64 to disk on inbound |
| `server/src/plugins/builtin/tool-skill-manager/index.ts` | Executes skills — extract generated images, save to disk |
| `server/src/agent/AgentRunner.ts` | Agentic loop — persist attachment URLs; collect image URLs from tool results; send with stream_done |
| `server/src/gateway/agentSupervisor.ts` | IPC listener — forward image URLs as AgentResponse.attachments |
| `server/src/routes/sessions.ts` | Session delete — clean up uploads directory |
| `client/src/components/AgentChat/AgentChat.tsx` | Chat UI — restore attachments from metadata; handle done SSE event; render images with download |

### Uploads directory layout

```
server/
  uploads/                          ← served at /uploads/*
    session-<sessionId>/
      upload-<timestamp>-0.jpg      ← user-uploaded file
      generated-<execId>-0.png      ← agent-generated image
```

- **Path from `server/src/index.ts`**: `path.join(__dirname, '../uploads')` = `server/uploads/`
- **Path from `server/src/plugins/builtin/*/index.ts`**: `path.join(__dirname, '../../../../uploads')` = `server/uploads/`
- **Path from `server/src/agent/AgentRunner.ts`**: `path.join(__dirname, '../../uploads')` = `server/uploads/`
- **Path from `server/src/routes/sessions.ts`**: `path.join(__dirname, '../../uploads')` = `server/uploads/`

### Image data format

- User uploads arrive from the browser as `data:<mime>;base64,<data>` strings
- AI-generated images from `aiService` are raw base64 strings (no `data:` prefix) with a separate `mimeType` field
- Both are written to disk as binary files using `Buffer.from(base64, 'base64')`
- The URL stored everywhere is the relative path `/uploads/session-<id>/filename.ext`

### Current SSE event shape (channel-web sendOutbound)

```typescript
// Already supports attachments — just not populated yet:
{
  type: 'done' | 'chunk' | 'message',
  messageId,
  content,
  attachments: [{ type, name, mimeType, url }],  // url = file URL
  timestamp
}
```

### Frontend ChatMessage type

```typescript
interface FileAttachment {
  type: string;
  data: string;   // base64 data URL -OR- file URL (/uploads/...)
  name: string;
  mimeType: string;
}
```

The `data` field already works for either base64 URLs or `/uploads/...` file URLs as `<img src>`.

---

## Task 1: Create uploads directory and serve as static

**Files:**
- Modify: `server/src/index.ts` (around line 45)
- Create: `server/uploads/.gitkeep`

**Step 1: Create the uploads directory with a gitkeep**

```bash
mkdir -p /Users/eveyhuang/Documents/novohaven-app/server/uploads
touch /Users/eveyhuang/Documents/novohaven-app/server/uploads/.gitkeep
```

**Step 2: Add `.gitignore` entry to ignore uploaded files but keep the directory**

Add to `server/.gitignore` (or create it):
```
uploads/session-*/
```

**Step 3: Add static file serving and increase JSON body limit in `server/src/index.ts`**

In `server/src/index.ts`, add `import fs from 'fs';` at the top with other imports.

Change the json body limit (currently `10mb`) to `50mb` to handle high-res image uploads:
```typescript
// Find this line:
app.use(express.json({ limit: '10mb' }));
// Replace with:
app.use(express.json({ limit: '50mb' }));
```

Add the static uploads route BEFORE the API routes block (around line 68):
```typescript
// Serve uploaded files (chat images)
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
```

**Step 4: Verify the server still starts**

```bash
cd /Users/eveyhuang/Documents/novohaven-app && npm run dev:server
```

Expected: Server starts without errors, `GET /uploads/anything` returns 404 (not a 500).

**Step 5: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/uploads/.gitkeep server/src/index.ts
git commit -m "feat: serve uploads/ as static, increase JSON body limit to 50mb"
```

---

## Task 2: Shared upload helper utility

**Files:**
- Create: `server/src/utils/uploadHelpers.ts`

This utility is used by both the main process and child agent processes, so it must be self-contained.

**Step 1: Create `server/src/utils/uploadHelpers.ts`**

```typescript
import fs from 'fs';
import path from 'path';

/**
 * Returns the absolute path to the uploads root (server/uploads/).
 * Works from any file depth by using the DATABASE_PATH env var as anchor,
 * or falling back to a path relative to this file (server/src/utils/).
 */
export function getUploadsDir(): string {
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR;
  // This file is at server/src/utils/uploadHelpers.ts
  // ../../ = server/
  return path.resolve(__dirname, '../../uploads');
}

/**
 * Returns the absolute path to a session's uploads subdirectory, creating it if needed.
 */
export function getSessionUploadsDir(sessionId: string): string {
  const dir = path.join(getUploadsDir(), `session-${sessionId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Saves a base64-encoded image to disk and returns the public URL path.
 *
 * @param base64     Raw base64 string OR data URL (data:<mime>;base64,<data>)
 * @param mimeType   MIME type e.g. 'image/png' (used for extension if not in base64)
 * @param sessionId  Session ID — determines the subdirectory
 * @param filename   File name without extension (timestamp-based suffix is added)
 * @returns          Public URL like '/uploads/session-abc/filename-123.png'
 */
export function saveImageToDisk(
  base64: string,
  mimeType: string,
  sessionId: string,
  filename: string
): string {
  // Strip data URL prefix if present
  let rawBase64 = base64;
  if (base64.startsWith('data:')) {
    const commaIdx = base64.indexOf(',');
    rawBase64 = base64.slice(commaIdx + 1);
  }

  const ext = mimeTypeToExt(mimeType);
  const safeName = `${filename}-${Date.now()}${ext}`;
  const dir = getSessionUploadsDir(sessionId);
  const filePath = path.join(dir, safeName);

  fs.writeFileSync(filePath, Buffer.from(rawBase64, 'base64'));
  return `/uploads/session-${sessionId}/${safeName}`;
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return map[mimeType] || '.bin';
}

/**
 * Deletes the entire uploads directory for a session.
 * Called when a session is deleted.
 */
export function deleteSessionUploads(sessionId: string): void {
  const dir = path.join(getUploadsDir(), `session-${sessionId}`);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
```

**Step 2: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/utils/uploadHelpers.ts
git commit -m "feat: add uploadHelpers utility for saving images to disk"
```

---

## Task 3: Save user-uploaded images to disk in channel-web

**Files:**
- Modify: `server/src/plugins/builtin/channel-web/index.ts`

Currently `parseInbound` passes the raw base64 `data:` URL directly as `a.url`. We need to save each image to disk and replace the URL with a file path.

**Step 1: Update `parseInbound` in channel-web**

At the top of `server/src/plugins/builtin/channel-web/index.ts`, add the import:
```typescript
import { saveImageToDisk } from '../../../utils/uploadHelpers';
```

Find `parseInbound` (around line 39) and replace the attachment mapping:

```typescript
parseInbound(req: Request): ChannelMessage | null {
  const { text, sessionId, attachments } = req.body;
  if (!text && (!attachments || attachments.length === 0)) return null;

  const channelId = sessionId || 'web-default';

  // Save uploaded images to disk; keep file types as-is (just record name)
  const processedAttachments = attachments?.map((a: any, i: number) => {
    if (a.type === 'image' && a.data && a.data.startsWith('data:')) {
      try {
        const fileUrl = saveImageToDisk(a.data, a.mimeType || 'image/png', channelId, `upload-${i}`);
        return {
          type: a.type || 'image',
          url: fileUrl,
          name: a.name,
          mimeType: a.mimeType,
        };
      } catch (err) {
        console.error('[channel-web] Failed to save upload to disk:', err);
        // Fall back to passing data URL (may be large)
        return { type: a.type, url: a.data, name: a.name, mimeType: a.mimeType };
      }
    }
    return {
      type: a.type || 'file',
      url: a.data, // non-image files: keep data URL for now
      name: a.name,
      mimeType: a.mimeType,
    };
  });

  return {
    channelType: 'web',
    channelId,
    userId: (req as any).userId?.toString() || '1',
    content: {
      text,
      attachments: processedAttachments,
    },
    metadata: { sessionId },
    timestamp: new Date(),
  };
},
```

**Step 2: Verify by restarting dev server and sending a test image message**

Start the dev server and send a message with an image attachment via the chat UI. Check that:
- `server/uploads/session-<id>/upload-0-<timestamp>.png` exists on disk
- No errors in server logs

**Step 3: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/plugins/builtin/channel-web/index.ts
git commit -m "feat: save user-uploaded images to disk in channel-web, store file URLs"
```

---

## Task 4: Persist user attachment URLs in session_messages metadata

**Files:**
- Modify: `server/src/agent/AgentRunner.ts` (around line 150)

Currently only `attachmentCount` is stored. We need to store the actual file URLs so they can be restored on session reload.

**Step 1: Update the user message persistence in `AgentRunner.handleTurn`**

Find this block (around line 150):
```typescript
// Step 2: Persist user message
const inboundAttachments = message.content.attachments;
this.db.prepare(`
  INSERT INTO session_messages (session_id, role, content, metadata)
  VALUES (?, 'user', ?, ?)
`).run(this.sessionId, message.content.text, JSON.stringify({
  ...message.metadata,
  ...(inboundAttachments?.length ? { attachmentCount: inboundAttachments.length } : {}),
}));
```

Replace the JSON.stringify argument to also include the full attachment array:
```typescript
// Step 2: Persist user message
const inboundAttachments = message.content.attachments;
this.db.prepare(`
  INSERT INTO session_messages (session_id, role, content, metadata)
  VALUES (?, 'user', ?, ?)
`).run(this.sessionId, message.content.text, JSON.stringify({
  ...message.metadata,
  ...(inboundAttachments?.length ? {
    attachmentCount: inboundAttachments.length,
    // Store file URLs (not base64) for restoring previews on session reload
    attachments: inboundAttachments.map(a => ({
      type: a.type,
      url: a.url,   // file URL: /uploads/session-<id>/upload-<n>-<ts>.<ext>
      name: a.name,
      mimeType: a.mimeType,
    })),
  } : {}),
}));
```

**Step 2: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/agent/AgentRunner.ts
git commit -m "feat: persist attachment file URLs in session_messages metadata"
```

---

## Task 5: Extract and save generated images to disk in tool-skill-manager

**Files:**
- Modify: `server/src/plugins/builtin/tool-skill-manager/index.ts`

After a skill executes successfully, check each step execution's `output_data` for `generatedImages`, save them to disk, and return the file URLs in `ToolResult.metadata`.

**Step 1: Add the import at the top of tool-skill-manager**

```typescript
import { saveImageToDisk } from '../../../utils/uploadHelpers';
```

**Step 2: Add `extractAndSaveGeneratedImages` method to `SkillManagerPlugin`**

Add this private method near `extractLatestContent` (around line 725):

```typescript
/**
 * Extracts generatedImages from all step executions, saves them to disk,
 * and returns an array of public file URLs.
 */
private extractAndSaveGeneratedImages(
  stepExecutions: any[],
  executionId: number,
  sessionId: string
): string[] {
  const urls: string[] = [];
  for (const step of stepExecutions) {
    if (!step.output_data) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(step.output_data);
    } catch {
      continue;
    }
    const images: Array<{ base64: string; mimeType: string }> = parsed?.generatedImages || [];
    images.forEach((img, i) => {
      try {
        const url = saveImageToDisk(
          img.base64,
          img.mimeType || 'image/png',
          sessionId,
          `generated-${executionId}-step${step.step_order || 0}-${i}`
        );
        urls.push(url);
      } catch (err) {
        console.error('[tool-skill-manager] Failed to save generated image:', err);
      }
    });
  }
  return urls;
}
```

**Step 3: Call the new method in `executeSkill` and return image URLs in metadata**

In `executeSkill`, find the success return block (around line 371):

```typescript
const truncated = latestContent.length > 4000 ? `${latestContent.slice(0, 4000)}...` : latestContent;
return {
  success: true,
  output: `Execution #${executionId} for ${parentType} "${skill.name}" completed.\nResult:\n${truncated}`,
  metadata: { executionId, status: settled.status },
};
```

Replace with:
```typescript
// Extract and save any generated images to disk
const generatedImageUrls = this.extractAndSaveGeneratedImages(
  settled.stepExecutions, executionId, context.sessionId
);

const truncated = latestContent.length > 4000 ? `${latestContent.slice(0, 4000)}...` : latestContent;
return {
  success: true,
  output: `Execution #${executionId} for ${parentType} "${skill.name}" completed.\nResult:\n${truncated}`,
  metadata: {
    executionId,
    status: settled.status,
    ...(generatedImageUrls.length > 0 ? { generatedImageUrls } : {}),
  },
};
```

Also handle the "no text output" early return (around line 354):
```typescript
// Find:
return {
  success: true,
  output: `Execution #${executionId} for ${parentType} "${skill.name}" completed successfully but returned no textual output.`,
  metadata: { executionId, status: settled.status },
};
// Replace with:
const imageUrls = this.extractAndSaveGeneratedImages(
  settled.stepExecutions, executionId, context.sessionId
);
return {
  success: true,
  output: `Execution #${executionId} for ${parentType} "${skill.name}" completed successfully${imageUrls.length > 0 ? ` with ${imageUrls.length} image(s)` : ' but returned no textual output'}.`,
  metadata: {
    executionId,
    status: settled.status,
    ...(imageUrls.length > 0 ? { generatedImageUrls: imageUrls } : {}),
  },
};
```

**Step 4: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/plugins/builtin/tool-skill-manager/index.ts
git commit -m "feat: extract generated images from executions, save to disk, return URLs in tool metadata"
```

---

## Task 6: Accumulate image URLs in AgentRunner, send with stream_done

**Files:**
- Modify: `server/src/agent/AgentRunner.ts`

**Step 1: Add a `pendingImageUrls` accumulator to the `handleTurn` method**

In `handleTurn`, find the tool execution loop (around line 299):
```typescript
// Execute tool calls via ToolExecutor
for (const tc of toolCalls) {
  let result: string;
  try {
    const executor = this.toolExecutor || new ToolExecutor(this.tools, { sessionId: this.sessionId, userId: 1 });
    const toolResult = await executor.execute(tc.name, tc.args);
    result = toolResult.output;
  } catch (err: any) {
    result = `Tool error: ${err.message}`;
  }
  ...
```

We need to:
1. Declare `pendingImageUrls` before the `while` loop
2. Capture image URLs from each tool result
3. Pass `pendingImageUrls` with `stream_done`

Add `let pendingImageUrls: string[] = [];` just before `while (round < this.maxToolRounds) {` (around line 228).

Then in the tool execution block, replace:
```typescript
const toolResult = await executor.execute(tc.name, tc.args);
result = toolResult.output;
```
with:
```typescript
const toolResult = await executor.execute(tc.name, tc.args);
result = toolResult.output;
// Collect any generated image URLs from this tool call
if (toolResult.metadata?.generatedImageUrls?.length) {
  pendingImageUrls.push(...toolResult.metadata.generatedImageUrls);
}
```

**Step 2: Include image URLs in the `stream_done` IPC message**

Find (around line 276):
```typescript
if (fullText) {
  process.send!({
    type: 'stream_done',
    sessionId: this.sessionId,
    messageId,
  });
  this.persistAssistantMessage(fullText);
}
```

Replace with:
```typescript
if (fullText || pendingImageUrls.length > 0) {
  process.send!({
    type: 'stream_done',
    sessionId: this.sessionId,
    messageId,
    ...(pendingImageUrls.length > 0 ? { generatedImageUrls: pendingImageUrls } : {}),
  });
  this.persistAssistantMessage(fullText, pendingImageUrls);
  pendingImageUrls = []; // reset after sending
}
```

**Step 3: Update `persistAssistantMessage` to store image URLs in metadata**

Find (around line 346):
```typescript
private persistAssistantMessage(content: string): void {
  this.db.prepare(`
    INSERT INTO session_messages (session_id, role, content)
    VALUES (?, 'assistant', ?)
  `).run(this.sessionId, content);
}
```

Replace with:
```typescript
private persistAssistantMessage(content: string, imageUrls: string[] = []): void {
  this.db.prepare(`
    INSERT INTO session_messages (session_id, role, content, metadata)
    VALUES (?, 'assistant', ?, ?)
  `).run(
    this.sessionId,
    content,
    JSON.stringify(imageUrls.length > 0 ? { generatedImageUrls: imageUrls } : {})
  );
}
```

**Step 4: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/agent/AgentRunner.ts
git commit -m "feat: accumulate generated image URLs in AgentRunner, send with stream_done IPC"
```

---

## Task 7: Pass image URLs from AgentSupervisor to AgentResponse

**Files:**
- Modify: `server/src/gateway/agentSupervisor.ts` (around line 74)

**Step 1: Update the `stream_done` handler in `spawnAgent`**

Find (around line 74):
```typescript
} else if (msg.type === 'stream_done') {
  this.onResponse(msg.sessionId, { text: '', isDone: true, messageId: msg.messageId } as any);
}
```

Replace with:
```typescript
} else if (msg.type === 'stream_done') {
  const imageAttachments = (msg.generatedImageUrls as string[] | undefined)?.map((url: string) => ({
    type: 'image' as const,
    data: url,   // file URL like /uploads/session-<id>/generated-<n>.png
    name: url.split('/').pop() || 'generated-image.png',
    mimeType: url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg'
              : url.endsWith('.webp') ? 'image/webp'
              : 'image/png',
  }));
  this.onResponse(msg.sessionId, {
    text: '',
    isDone: true,
    messageId: msg.messageId,
    attachments: imageAttachments,
  } as any);
}
```

**Step 2: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/gateway/agentSupervisor.ts
git commit -m "feat: forward generated image URLs as AgentResponse.attachments from supervisor"
```

---

## Task 8: Fix channel-web sendOutbound to properly format image URLs in done events

**Files:**
- Modify: `server/src/plugins/builtin/channel-web/index.ts`

**Step 1: Review the existing `sendOutbound` attachment mapping**

Currently (around line 78):
```typescript
attachments: response.attachments?.map(a => ({
  type: a.type,
  name: a.name,
  mimeType: a.mimeType,
  url: typeof a.data === 'string' ? a.data : undefined,
})),
```

`a.data` for generated images will be a file URL string like `/uploads/session-.../file.png`. This is already a string, so it will flow through correctly as `url`. No change needed here — the existing code already handles this case.

**Step 2: Verify the SSE done event shape**

With images, the SSE event will look like:
```json
{
  "type": "done",
  "messageId": "msg-123",
  "content": "",
  "attachments": [{ "type": "image", "name": "generated-123.png", "mimeType": "image/png", "url": "/uploads/session-abc/generated-123.png" }],
  "timestamp": "2026-02-19T..."
}
```

This is correct — no code changes needed for `sendOutbound`.

**Step 3: Commit noting the no-op**

No file changes for this task — the existing code already handles it.

---

## Task 9: Clean up session uploads on session delete

**Files:**
- Modify: `server/src/routes/sessions.ts`

**Step 1: Add import to sessions.ts**

At the top of `server/src/routes/sessions.ts`:
```typescript
import { deleteSessionUploads } from '../utils/uploadHelpers';
```

**Step 2: Update the DELETE /:id route to also delete uploads**

Find (around line 56):
```typescript
db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(req.params.id);
db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
res.json({ success: true });
```

Add the upload cleanup:
```typescript
db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(req.params.id);
db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
// Clean up any uploaded/generated images for this session
deleteSessionUploads(req.params.id);
res.json({ success: true });
```

**Step 3: Update the DELETE / (all sessions) route**

Find (around line 64):
```typescript
router.delete('/', (req, res) => {
  const db = getDatabase();
  db.prepare('DELETE FROM session_messages').run();
  db.prepare('DELETE FROM sessions').run();
  res.json({ success: true });
});
```

Replace with:
```typescript
router.delete('/', (req, res) => {
  const db = getDatabase();
  // Collect session IDs before deleting for upload cleanup
  const sessionIds = (db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>)
    .map(s => s.id);
  db.prepare('DELETE FROM session_messages').run();
  db.prepare('DELETE FROM sessions').run();
  sessionIds.forEach(id => deleteSessionUploads(id));
  res.json({ success: true });
});
```

**Step 4: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add server/src/routes/sessions.ts
git commit -m "feat: delete session upload files when session is deleted"
```

---

## Task 10: Frontend — restore attachments from session metadata in loadSessionMessages

**Files:**
- Modify: `client/src/components/AgentChat/AgentChat.tsx` (around line 60)

**Step 1: Update `loadSessionMessages` to map attachment metadata**

Find (around line 63):
```typescript
const loaded: ChatMessage[] = data.messages
  .filter((m: any) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
  .map((m: any) => ({
    id: `db-${m.id || m.created_at}`,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    timestamp: m.created_at || new Date().toISOString(),
  }));
```

Replace with:
```typescript
const loaded: ChatMessage[] = data.messages
  .filter((m: any) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
  .map((m: any) => {
    // Parse metadata to restore attachments (user uploads and agent-generated images)
    let metadata: any = {};
    try { metadata = JSON.parse(m.metadata || '{}'); } catch {}

    const attachments: FileAttachment[] = [];

    // Restore user-uploaded file URLs (stored as metadata.attachments on user messages)
    if (m.role === 'user' && Array.isArray(metadata.attachments)) {
      metadata.attachments.forEach((a: any) => {
        attachments.push({
          type: a.type || 'image',
          data: a.url,           // file URL: /uploads/session-.../upload-0-123.png
          name: a.name || 'attachment',
          mimeType: a.mimeType || 'image/png',
        });
      });
    }

    // Restore agent-generated image URLs (stored as metadata.generatedImageUrls on assistant messages)
    if (m.role === 'assistant' && Array.isArray(metadata.generatedImageUrls)) {
      metadata.generatedImageUrls.forEach((url: string) => {
        attachments.push({
          type: 'image',
          data: url,
          name: url.split('/').pop() || 'generated-image.png',
          mimeType: url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg'
                    : url.endsWith('.webp') ? 'image/webp'
                    : 'image/png',
        });
      });
    }

    return {
      id: `db-${m.id || m.created_at}`,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: m.created_at || new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  });
```

**Step 2: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add client/src/components/AgentChat/AgentChat.tsx
git commit -m "feat: restore image attachments from session message metadata on session load"
```

---

## Task 11: Frontend — handle attachments in SSE done event

**Files:**
- Modify: `client/src/components/AgentChat/AgentChat.tsx` (around line 290)

**Step 1: Update the SSE `done` handler to attach images to the last assistant message**

Find (around line 290):
```typescript
} else if (data.type === 'done' || data.type === 'end') {
  setStreaming(false);
}
```

Replace with:
```typescript
} else if (data.type === 'done' || data.type === 'end') {
  setStreaming(false);
  // Attach any generated images to the last assistant message
  if (Array.isArray(data.attachments) && data.attachments.length > 0) {
    const newAttachments: FileAttachment[] = data.attachments.map((a: any) => ({
      type: a.type || 'image',
      data: a.url,    // file URL served by /uploads static endpoint
      name: a.name || 'generated-image.png',
      mimeType: a.mimeType || 'image/png',
    }));
    setMessages((prev) => {
      // Find the last assistant message (the one we just streamed)
      const lastIdx = [...prev].reverse().findIndex(m => m.role === 'assistant');
      if (lastIdx === -1) return prev;
      const idx = prev.length - 1 - lastIdx;
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        attachments: [...(updated[idx].attachments || []), ...newAttachments],
      };
      return updated;
    });
  }
}
```

**Step 2: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add client/src/components/AgentChat/AgentChat.tsx
git commit -m "feat: attach generated images from SSE done event to last assistant message"
```

---

## Task 12: Frontend — render images with download button

**Files:**
- Modify: `client/src/components/AgentChat/AgentChat.tsx` (around line 549)

**Step 1: Add a download button to image renders in the message bubble**

Find the existing attachment rendering block (around line 549):
```tsx
{msg.attachments && msg.attachments.length > 0 && (
  <div className="flex flex-wrap gap-1.5 mb-2">
    {msg.attachments.filter(a => a.type === 'image').map((a, i) => (
      <img
        key={i}
        src={a.data}
        alt={a.name}
        className="max-w-[200px] max-h-[150px] rounded object-cover"
      />
    ))}
    {msg.attachments.filter(a => a.type !== 'image').map((a, i) => (
      <span key={i} className="inline-flex items-center gap-1 text-xs bg-white/20 rounded px-2 py-1">
        ...
      </span>
    ))}
  </div>
)}
```

Replace with:
```tsx
{msg.attachments && msg.attachments.length > 0 && (
  <div className="flex flex-wrap gap-2 mb-2">
    {msg.attachments.filter(a => a.type === 'image').map((a, i) => (
      <div key={i} className="relative group">
        <img
          src={a.data}
          alt={a.name}
          className="max-w-[300px] max-h-[300px] rounded object-contain border border-white/20 bg-black/10"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <a
          href={a.data}
          download={a.name || 'image.png'}
          className={`absolute bottom-1.5 right-1.5 flex items-center justify-center w-7 h-7 rounded-full
            shadow-sm opacity-0 group-hover:opacity-100 transition-opacity
            ${msg.role === 'user' ? 'bg-primary-800 text-white' : 'bg-white text-secondary-700 border border-secondary-200'}`}
          title="Download image"
          onClick={(e) => e.stopPropagation()}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </a>
      </div>
    ))}
    {msg.attachments.filter(a => a.type !== 'image').map((a, i) => (
      <span key={i} className="inline-flex items-center gap-1 text-xs bg-white/20 rounded px-2 py-1">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
        {a.name}
      </span>
    ))}
  </div>
)}
```

**Step 2: Verify rendering**

- Restart dev server + client
- Send a message with an image upload → verify preview appears with download button on hover
- Switch to another session and back → verify image preview still shows
- Ask agent to generate an image → verify image appears in chat after `done` event, with download button
- Click download button → verify original file downloads

**Step 3: Commit**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add client/src/components/AgentChat/AgentChat.tsx
git commit -m "feat: render chat images with download button, increase preview size to 300px"
```

---

## Task 13: End-to-end smoke test

**Step 1: Start dev server and client**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
npm run dev
```

**Step 2: Test user upload persistence**
1. Open Agent Chat
2. Upload an image and send a message
3. Note the session ID in the sidebar
4. Switch to a different session (or create a new one)
5. Switch back to the original session
6. ✅ Verify: the uploaded image preview is still visible in the message

**Step 3: Test agent-generated image display**
1. Ask the agent: "Please generate a product image" (or use a skill that generates images)
2. Wait for the agent to complete
3. ✅ Verify: the generated image appears in the chat bubble (not just in the Outputs area)
4. ✅ Verify: hovering shows a download button
5. ✅ Verify: clicking download saves the full-resolution file

**Step 4: Test cleanup on session delete**
1. Note a session ID with images in `server/uploads/`
2. Delete the session via the trash icon in the sidebar
3. ✅ Verify: `server/uploads/session-<id>/` directory is gone

**Step 5: Commit final**

```bash
cd /Users/eveyhuang/Documents/novohaven-app
git add -p   # review any remaining changes
git commit -m "feat: agent chat image display — complete implementation"
```
