import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../models/database';
import { Session, SessionMessage } from '../types';

export class SessionManager {
  /**
   * Find or create a session for the given channel/user/thread combination.
   */
  resolveSession(
    channelType: string,
    channelId: string,
    userId: string,
    threadId?: string
  ): Session {
    const db = getDatabase();

    // Look for an existing active session matching these coordinates
    const query = threadId
      ? 'SELECT * FROM sessions WHERE channel_type = ? AND channel_id = ? AND thread_id = ? AND status != ?'
      : 'SELECT * FROM sessions WHERE channel_type = ? AND channel_id = ? AND thread_id IS NULL AND status != ?';

    const params = threadId
      ? [channelType, channelId, threadId, 'closed']
      : [channelType, channelId, 'closed'];

    const existing = db.prepare(query).get(...params) as Session | undefined;

    if (existing) {
      // Touch last_active_at
      db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(existing.id);
      return { ...existing, last_active_at: new Date().toISOString() };
    }

    // Create new session
    const id = uuidv4();

    // Resolve platform userId to DB user_id (best-effort: look up by email or default to 1)
    let dbUserId = 1;
    const user = db.prepare('SELECT id FROM users WHERE id = ? OR email = ?').get(userId, userId) as any;
    if (user) dbUserId = user.id;

    db.prepare(`
      INSERT INTO sessions (id, channel_type, channel_id, user_id, thread_id, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(id, channelType, channelId, dbUserId, threadId || null);

    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
  }

  getSession(sessionId: string): Session | undefined {
    const db = getDatabase();
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  }

  appendMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    opts?: {
      toolCalls?: string;
      toolResults?: string;
      metadata?: Record<string, any>;
    }
  ): number {
    const db = getDatabase();
    const result = db.prepare(`
      INSERT INTO session_messages (session_id, role, content, tool_calls, tool_results, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      role,
      content,
      opts?.toolCalls || null,
      opts?.toolResults || null,
      JSON.stringify(opts?.metadata || {})
    );

    // Touch session last_active_at
    db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(sessionId);

    return Number(result.lastInsertRowid);
  }

  getHistory(sessionId: string, limit: number = 50): SessionMessage[] {
    const db = getDatabase();
    return db.prepare(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, limit).reverse() as SessionMessage[];
  }

  closeSession(sessionId: string): void {
    const db = getDatabase();
    db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(sessionId);
  }

  setActiveExecution(sessionId: string, executionId: number | null): void {
    const db = getDatabase();
    db.prepare('UPDATE sessions SET active_execution_id = ? WHERE id = ?')
      .run(executionId, sessionId);
  }

  setAgentPid(sessionId: string, pid: number | null): void {
    const db = getDatabase();
    db.prepare('UPDATE sessions SET agent_pid = ? WHERE id = ?')
      .run(pid, sessionId);
  }

  getActiveSessions(): Session[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_active_at DESC")
      .all() as Session[];
  }
}
