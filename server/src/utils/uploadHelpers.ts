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
  if (!/^[0-9a-f-]{1,64}$/i.test(sessionId) && sessionId !== 'web-default') {
    return; // silently ignore invalid session IDs during cleanup
  }
  const dir = path.join(getUploadsDir(), `session-${sessionId}`);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
