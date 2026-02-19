import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDatabase } from '../models/database';

const router = Router();
router.use(authMiddleware);

// List active sessions
router.get('/', (req, res) => {
  const db = getDatabase();
  const sessions = db.prepare(`
    SELECT s.*, u.email as user_email
    FROM sessions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.status != 'closed'
    ORDER BY s.last_active_at DESC
  `).all();
  res.json(sessions);
});

// Get session detail with recent messages
router.get('/:id', (req, res) => {
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const messages = db.prepare(
    'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.params.id);

  res.json({ session, messages: messages.reverse() });
});

// Delete a session and its messages
router.delete('/:id', (req, res) => {
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Delete all sessions and their messages
router.delete('/', (req, res) => {
  const db = getDatabase();
  db.prepare('DELETE FROM session_messages').run();
  db.prepare('DELETE FROM sessions').run();
  res.json({ success: true });
});

// Close a session
router.post('/:id/close', (req, res) => {
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

export default router;
