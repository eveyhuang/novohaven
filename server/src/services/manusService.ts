import https from 'https';
import { ManusMessage } from '../types';

// Default base: https://api.manus.ai/v1
// MANUS_API_BASE can be a full URL (https://api.manus.ai/v1) or just a hostname (api.manus.ai)
const DEFAULT_BASE_URL = 'https://api.manus.ai/v1';

function getBaseUrl(): URL {
  const raw = process.env.MANUS_API_BASE || DEFAULT_BASE_URL;
  // If it already looks like a full URL, parse it directly
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    // Strip trailing /tasks if user set it to the tasks endpoint
    const cleaned = raw.replace(/\/tasks\/?$/, '');
    return new URL(cleaned);
  }
  // Otherwise treat as hostname
  return new URL(`https://${raw}/v1`);
}

function getManusApiKey(): string | undefined {
  return process.env.MANUS_API_KEY;
}

export function isManusConfigured(): boolean {
  const apiKey = getManusApiKey();
  if (!apiKey) {
    console.log('[Manus] API key not found in process.env.MANUS_API_KEY');
  }
  return !!apiKey;
}

export interface ManusFile {
  name: string;
  url: string;
  type: string;
  size?: number;
}

export interface ManusTaskResult {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output: string;
  files?: ManusFile[];
  creditsUsed?: number;
}

// ManusMessage is imported from ../types

function makeHttpsRequest(
  options: https.RequestOptions,
  data?: string,
  timeoutMs: number = 120000
): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    let isResolved = false;

    console.log(`[Manus] Making ${options.method || 'GET'} request to: ${options.hostname}${options.path}`);

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk: Buffer) => {
        responseData += chunk.toString();
      });

      res.on('end', () => {
        if (isResolved) return;
        isResolved = true;
        console.log(`[Manus] Response complete: status ${res.statusCode}, ${responseData.length} bytes`);
        resolve({ statusCode: res.statusCode || 0, data: responseData });
      });
    });

    req.on('error', (error: Error) => {
      if (isResolved) return;
      isResolved = true;
      console.error(`[Manus] Request error:`, error.message);
      reject(error);
    });

    req.setTimeout(timeoutMs, () => {
      if (isResolved) return;
      isResolved = true;
      console.error(`[Manus] Request timeout after ${timeoutMs}ms`);
      req.destroy();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function buildRequestOptions(method: string, path: string, apiKey: string, body?: string): https.RequestOptions {
  const base = getBaseUrl();
  // Combine the base path (e.g. /v1) with the endpoint path (e.g. /tasks)
  const fullPath = base.pathname.replace(/\/$/, '') + path;

  const headers: Record<string, string> = {
    'API_KEY': apiKey,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  if (body) {
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }

  return {
    hostname: base.hostname,
    port: base.port || undefined,
    path: fullPath,
    method,
    headers,
  };
}

export async function createTask(prompt: string): Promise<string> {
  const apiKey = getManusApiKey();
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const body = JSON.stringify({ prompt });
  const options = buildRequestOptions('POST', '/tasks', apiKey, body);

  const response = await makeHttpsRequest(options, body);

  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`Failed to create Manus task: ${response.statusCode} - ${response.data}`);
  }

  const result = JSON.parse(response.data);
  const taskId = result.task_id || result.taskId || result.id;

  if (!taskId) {
    throw new Error(`No task ID in Manus response: ${response.data}`);
  }

  console.log(`[Manus] Task created with ID: ${taskId}`);
  return taskId;
}

export async function getTaskStatus(taskId: string): Promise<ManusTaskResult> {
  const apiKey = getManusApiKey();
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const options = buildRequestOptions('GET', `/tasks/${taskId}`, apiKey);

  const response = await makeHttpsRequest(options, undefined, 30000);

  if (response.statusCode !== 200) {
    throw new Error(`Failed to get task status: ${response.statusCode} - ${response.data}`);
  }

  const data = JSON.parse(response.data);

  // Extract text from the output messages array
  // Manus returns output as an array of message objects with content arrays
  let outputText = '';
  if (Array.isArray(data.output)) {
    const assistantMessages = data.output.filter((msg: any) => msg.role === 'assistant');
    outputText = assistantMessages
      .flatMap((msg: any) => (msg.content || []))
      .filter((c: any) => c.type === 'output_text' && c.text)
      .map((c: any) => c.text)
      .join('\n\n');
  } else if (typeof data.output === 'string') {
    outputText = data.output;
  } else if (typeof data.result === 'string') {
    outputText = data.result;
  }

  return {
    taskId,
    status: data.status || 'pending',
    output: outputText,
    files: data.files,
    creditsUsed: data.credit_usage ?? data.credits_used ?? data.creditsUsed,
  };
}

export async function waitForCompletion(
  taskId: string,
  timeoutMs: number = 15 * 60 * 1000
): Promise<ManusTaskResult> {
  const pollInterval = 10000; // 10 seconds
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await getTaskStatus(taskId);
      consecutiveErrors = 0; // reset on success

      if (result.status === 'completed') {
        console.log(`[Manus] Task ${taskId} completed (attempt ${attempt + 1}/${maxAttempts})`);
        return result;
      }

      if (result.status === 'failed') {
        console.error(`[Manus] Task ${taskId} failed:`, result.output);
        return result;
      }

      console.log(`[Manus] Task ${taskId} status: ${result.status} (attempt ${attempt + 1}/${maxAttempts})`);
    } catch (error: any) {
      consecutiveErrors++;
      console.warn(`[Manus] Error polling task ${taskId} (attempt ${attempt + 1}): ${error.message}`);

      // Give up after 5 consecutive errors
      if (consecutiveErrors >= 5) {
        throw new Error(`Manus task ${taskId} polling failed after ${consecutiveErrors} consecutive errors: ${error.message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Manus task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

export async function getTaskFiles(taskId: string): Promise<ManusFile[]> {
  const result = await getTaskStatus(taskId);
  return result.files || [];
}

export interface GetTaskMessagesResult {
  messages: ManusMessage[];
  status: string;
  stopReason?: string;
  taskUrl?: string;
  files?: ManusFile[];
  creditsUsed?: number;
}

function guessFileType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel', json: 'application/json', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain',
    md: 'text/markdown', html: 'text/html', zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

// Patterns in assistant messages that indicate Manus needs user to take browser control
const VERIFICATION_PATTERNS = [
  /press\s*&?\s*hold/i,
  /captcha/i,
  /verification/i,
  /solve\s+this/i,
  /complete\s+(this|the)\s+(verification|captcha|challenge)/i,
  /help\s+me\s+complete/i,
  /bypass\s+it/i,
  /bot\s+detection/i,
];

function detectVerificationRequest(messages: ManusMessage[]): boolean {
  // Check the last 2 assistant messages for verification language
  const recentAssistant = messages
    .filter(m => m.role === 'assistant')
    .slice(-2);

  for (const msg of recentAssistant) {
    for (const block of msg.content) {
      if (block.text) {
        for (const pattern of VERIFICATION_PATTERNS) {
          if (pattern.test(block.text)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Returns raw ManusMessage[] from data.output array,
 * preserving all roles and content types.
 * Also extracts task_url from metadata and detects verification requests.
 */
export async function getTaskMessages(taskId: string): Promise<GetTaskMessagesResult> {
  const apiKey = getManusApiKey();
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const options = buildRequestOptions('GET', `/tasks/${taskId}`, apiKey);
  const response = await makeHttpsRequest(options, undefined, 30000);

  if (response.statusCode !== 200) {
    throw new Error(`Failed to get task messages: ${response.statusCode} - ${response.data}`);
  }

  const data = JSON.parse(response.data);

  // Log raw response structure
  const topLevelKeys = Object.keys(data);
  console.log(`[Manus RAW] Task ${taskId} keys: ${JSON.stringify(topLevelKeys)}, status=${data.status}`);

  // task_url lives inside metadata
  const taskUrl = data.metadata?.task_url || data.task_url;
  const stopReason = data.stop_reason;

  if (Array.isArray(data.output)) {
    console.log(`[Manus RAW] Task ${taskId} output: ${data.output.length} messages`);
    // Log last message for debugging
    const lastMsg = data.output[data.output.length - 1];
    if (lastMsg) {
      console.log(`[Manus RAW] Last msg role=${lastMsg.role}, content: ${JSON.stringify(lastMsg.content).slice(0, 300)}`);
    }
  }

  // Log metadata fully (contains task_url, possibly attachments)
  if (data.metadata) {
    console.log(`[Manus RAW] metadata: ${JSON.stringify(data.metadata).slice(0, 500)}`);
  }

  // Log all output message content block types when completed (to find file references)
  if (data.status === 'completed' && Array.isArray(data.output)) {
    for (const msg of data.output) {
      for (const block of (msg.content || [])) {
        if (block.type !== 'output_text') {
          console.log(`[Manus RAW] Non-text content block: ${JSON.stringify(block).slice(0, 500)}`);
        }
      }
    }
  }

  const messages: ManusMessage[] = [];
  if (Array.isArray(data.output)) {
    for (const msg of data.output) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: String(msg.content || '') }];
      messages.push({
        role: msg.role || 'system',
        content,
        timestamp: msg.timestamp,
      });
    }
  }

  // Detect if Manus is asking the user for browser verification
  // The API doesn't set stop_reason during polling — detection is content-based
  const needsVerification = detectVerificationRequest(messages);
  const effectiveStopReason = stopReason || (needsVerification ? 'ask' : undefined);

  if (needsVerification) {
    console.log(`[Manus] Task ${taskId} detected verification request, taskUrl=${taskUrl}`);
  }

  // Extract file attachments from all possible locations:
  // 1. Content blocks with fileUrl/fileName (primary — from GET /v1/tasks/:id docs)
  // 2. Top-level data.files or data.attachments (webhook format)
  // 3. metadata.attachments
  const files: ManusFile[] = [];

  // Scan all message content blocks for file attachments
  if (Array.isArray(data.output)) {
    for (const msg of data.output) {
      for (const block of (msg.content || [])) {
        if (block.fileUrl) {
          console.log(`[Manus RAW] Found file in content: name=${block.fileName}, url=${block.fileUrl}, mime=${block.mimeType}`);
          files.push({
            name: block.fileName || 'file',
            url: block.fileUrl,
            type: block.mimeType || guessFileType(block.fileName || ''),
            size: block.size || block.size_bytes,
          });
        }
      }
    }
  }

  // Also check top-level and metadata for webhook-style attachments
  const rawAttachments: any[] = data.files || data.attachments || data.metadata?.attachments || [];
  for (const a of rawAttachments) {
    if (a.url && !files.some(f => f.url === a.url)) {
      files.push({
        name: a.file_name || a.name || 'file',
        url: a.url,
        type: a.type || guessFileType(a.file_name || a.name || ''),
        size: a.size_bytes || a.size,
      });
    }
  }

  if (files.length > 0) {
    console.log(`[Manus RAW] Total files found: ${files.length}`);
  }

  return {
    messages,
    status: data.status || 'pending',
    stopReason: effectiveStopReason,
    taskUrl,
    files: files.length > 0 ? files : undefined,
    creditsUsed: data.credit_usage ?? data.credits_used ?? data.creditsUsed,
  };
}

/**
 * Send a user reply to an existing Manus task.
 */
export async function sendMessage(taskId: string, message: string): Promise<void> {
  const apiKey = getManusApiKey();
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const body = JSON.stringify({ message });
  const options = buildRequestOptions('POST', `/tasks/${taskId}/messages`, apiKey, body);
  const response = await makeHttpsRequest(options, body);

  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`Failed to send message to Manus task: ${response.statusCode} - ${response.data}`);
  }

  console.log(`[Manus] Message sent to task ${taskId}`);
}
