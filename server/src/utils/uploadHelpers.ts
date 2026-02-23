import fs from 'fs';
import path from 'path';

/**
 * Returns the absolute path to the uploads root (server/uploads/).
 * Works from any file depth. This file is at server/src/utils/uploadHelpers.ts
 * so ../../ goes to server/.
 */
export function getUploadsDir(): string {
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR;
  return path.resolve(__dirname, '../../uploads');
}

/**
 * Returns the absolute path to a session's uploads subdirectory, creating it if needed.
 */
export function getSessionUploadsDir(sessionId: string): string {
  // Validate sessionId to prevent path traversal attacks
  if (!/^[0-9a-f-]{1,64}$/i.test(sessionId) && sessionId !== 'web-default') {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  const dir = path.join(getUploadsDir(), `session-${sessionId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Saves a base64-encoded image to disk and returns the public URL path.
 *
 * @param base64     Raw base64 string OR data URL (data:<mime>;base64,<data>)
 * @param mimeType   MIME type e.g. 'image/png'
 * @param sessionId  Session ID — determines the subdirectory
 * @param filename   Base filename (timestamp suffix added automatically)
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

/**
 * Saves an arbitrary attachment payload (data URL or raw base64) to disk and returns a public URL.
 */
export function saveAttachmentToDisk(
  payload: string,
  mimeType: string,
  sessionId: string,
  filename: string
): string {
  let data = String(payload || '');
  let resolvedMime = String(mimeType || '').trim();
  let isBase64 = true;

  if (data.startsWith('data:')) {
    const m = data.match(/^data:([^;,]+)?(?:;(base64))?,(.*)$/s);
    if (m) {
      if (m[1]) resolvedMime = m[1];
      isBase64 = m[2] === 'base64';
      data = m[3] || '';
    }
  }

  const providedExt = path.extname(filename || '').toLowerCase();
  const ext = providedExt || mimeTypeToExt(resolvedMime || 'application/octet-stream');
  const baseName = safeBaseName(filename || 'attachment');
  const safeName = `${baseName}-${Date.now()}${ext}`;
  const dir = getSessionUploadsDir(sessionId);
  const filePath = path.join(dir, safeName);

  const buffer = isBase64
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'utf8');
  fs.writeFileSync(filePath, buffer);
  return `/uploads/session-${sessionId}/${safeName}`;
}

function safeBaseName(filename: string): string {
  const parsed = path.parse(String(filename || 'attachment'));
  const name = parsed.name || 'attachment';
  const cleaned = name.replace(/[^\w.\-() ]+/g, '_').trim();
  return cleaned.slice(0, 120) || 'attachment';
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/xml': '.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-excel': '.xls',
    'application/msword': '.doc',
    'application/vnd.ms-powerpoint': '.ppt',
  };
  return map[String(mimeType || '').toLowerCase()] || '.bin';
}

/**
 * Deletes the entire uploads directory for a session.
 * Called when a session is deleted.
 */
export function deleteSessionUploads(sessionId: string): void {
  if (!/^[0-9a-f-]{1,64}$/i.test(sessionId) && sessionId !== 'web-default') {
    return; // silently ignore invalid session IDs during cleanup
  }
  const dir = path.join(getUploadsDir(), `session-${sessionId}`);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
