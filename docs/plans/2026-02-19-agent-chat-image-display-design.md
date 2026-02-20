# Agent Chat Image Display Design

**Date:** 2026-02-19
**Status:** Approved

## Problem Statement

Two related issues with image handling in the AgentChat UI:

1. **Agent-generated images don't appear in chat** — When the agent executes an image-generating skill (e.g. nano-banana-pro), the output images are stored in `step_executions.output_data.generatedImages` and visible only in the Outputs area. No image data flows back through the IPC → SSE → chat pipeline. The chat shows only text like "Execution completed."

2. **User-uploaded image previews disappear** — When a user uploads images with their message, they display inline in the chat. But on switching sessions and returning, `loadSessionMessages()` reloads from the DB where only `attachmentCount` is stored in metadata (not the actual image data), so previews are gone.

## Constraints

- Generated images can be **large / high-resolution** (users need to download the original)
- Users need a **download button** for full-resolution access
- Solution must avoid passing large base64 through IPC or SSE

## Chosen Approach: Disk Files + Static URL Serving

Images (both generated and user-uploaded) are written to disk at `server/uploads/`. A tiny URL string (`/uploads/<filename>`) travels through IPC → SSE → frontend. The browser fetches the image directly from the static file endpoint. This avoids base64 bloat at every layer and makes downloads trivial (direct link).

## Architecture

### Directory Structure

```
server/
  uploads/           ← new static directory for all chat images
    session-<id>/    ← subdirectory per session for easy cleanup
      generated-<executionId>-<n>.png
      upload-<msgId>-<n>.<ext>
```

### Data Flow: Agent-Generated Images

```
skill_execute() completes
  → extract generatedImages from step_executions.output_data
  → write each image to server/uploads/session-<id>/generated-<execId>-<n>.png
  → return file URLs in ToolResult.metadata.generatedImageUrls

AgentRunner (tool result loop)
  → accumulate generatedImageUrls across tool rounds
  → include in stream_done IPC message

AgentSupervisor
  → stream_done handler: build AgentResponse.attachments from image URLs
  → call onResponse(sessionId, { text: '', isDone: true, attachments })

channel-web sendOutbound
  → isDone event: SSE payload includes attachments[].url
  → no base64; just URL strings

AgentRunner (persist)
  → store image URLs in assistant session_message metadata

Frontend SSE handler
  → 'done' event: add attachments to the last streamed assistant message
  → render <img src={url}> with download button
```

### Data Flow: User-Uploaded Images (Persistence)

```
POST /channels/channel-web/message (with base64 attachments)
  → channel-web parseInbound: save each attachment to
    server/uploads/session-<id>/upload-<timestamp>-<n>.<ext>
  → replace a.url (base64 data URL) with file URL

AgentRunner (persist user message)
  → metadata.attachments = [{ type, url (file URL), name, mimeType }]

loadSessionMessages() (frontend)
  → parse metadata.attachments
  → map to ChatMessage.attachments with url as data field
  → render <img src={url}> — browser fetches from static endpoint
```

### Static File Serving

`server/src/index.ts` adds:
```typescript
import express from 'express';
const uploadsDir = path.join(__dirname, '../../uploads');
app.use('/uploads', express.static(uploadsDir));
```

Auth note: uploads are served without auth middleware (standard for chat media); if privacy is needed, add a signed-URL or session-token check in a follow-up.

### File Cleanup

When a session is deleted (`DELETE /sessions/:id`), delete `server/uploads/session-<id>/` recursively. This covers both generated and uploaded images for that session.

## Files Modified

| File | Change |
|------|--------|
| `server/src/index.ts` | Serve `uploads/` as static |
| `server/src/plugins/builtin/channel-web/index.ts` | Save user-uploaded base64 to disk in `parseInbound`; return file URLs |
| `server/src/plugins/builtin/tool-skill-manager/index.ts` | Extract `generatedImages`, write to disk, return URLs in metadata |
| `server/src/agent/AgentRunner.ts` | Accumulate image URLs from tool results; include in `stream_done` IPC; store URLs in user/assistant message metadata |
| `server/src/gateway/agentSupervisor.ts` | Pass image URLs from `stream_done` as `AgentResponse.attachments` |
| `server/src/routes/sessions.ts` | Delete session uploads directory on session delete |
| `client/src/components/AgentChat/AgentChat.tsx` | Handle `attachments` in `done` SSE event; restore from metadata in `loadSessionMessages`; render images with download button |

## UI: Image Display in Chat

Assistant messages with image attachments show:
```
┌─────────────────────────────────────┐
│ [assistant bubble]                  │
│ Here is your generated product      │
│ image:                              │
│                                     │
│ ┌──────────────┐                    │
│ │              │  ↓ Download        │
│ │   [image]    │                    │
│ │              │                    │
│ └──────────────┘                    │
│                                   12:34 │
└─────────────────────────────────────┘
```

- Images are capped at `max-w-[300px] max-h-[300px]` for preview
- A download button (↓ icon) links directly to the file URL with `download` attribute
- User-uploaded images in user messages also get a download button

## Non-Goals

- Auth-gated uploads (follow-up concern)
- Image compression / thumbnail generation
- Cross-session image references
- Cleanup of orphaned uploads if server restarts mid-session
