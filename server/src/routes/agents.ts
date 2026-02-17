import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDatabase } from '../models/database';

const router = Router();
router.use(authMiddleware);

// List agent configs
router.get('/', (req, res) => {
  const db = getDatabase();
  const configs = db.prepare('SELECT * FROM agent_configs ORDER BY id').all();
  res.json(configs);
});

// Create agent config
router.post('/', (req, res) => {
  const { name, description, default_model, system_prompt, allowed_tools, allowed_channels, max_turns_per_session } = req.body;
  if (!name || !default_model) {
    res.status(400).json({ error: 'name and default_model are required' });
    return;
  }

  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO agent_configs (name, description, default_model, system_prompt, allowed_tools, allowed_channels, max_turns_per_session)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    description || null,
    default_model,
    system_prompt || null,
    JSON.stringify(allowed_tools || []),
    JSON.stringify(allowed_channels || []),
    max_turns_per_session || 50
  );

  const created = db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(Number(result.lastInsertRowid));
  res.status(201).json(created);
});

// Get agent config
router.get('/:id', (req, res) => {
  const db = getDatabase();
  const config = db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(req.params.id);
  if (!config) {
    res.status(404).json({ error: 'Agent config not found' });
    return;
  }
  res.json(config);
});

// Update agent config
router.put('/:id', (req, res) => {
  const db = getDatabase();
  const existing = db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(req.params.id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Agent config not found' });
    return;
  }

  const { name, description, default_model, system_prompt, allowed_tools, allowed_channels, max_turns_per_session } = req.body;

  db.prepare(`
    UPDATE agent_configs
    SET name = ?, description = ?, default_model = ?, system_prompt = ?,
        allowed_tools = ?, allowed_channels = ?, max_turns_per_session = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    description ?? existing.description,
    default_model ?? existing.default_model,
    system_prompt ?? existing.system_prompt,
    allowed_tools ? JSON.stringify(allowed_tools) : existing.allowed_tools,
    allowed_channels ? JSON.stringify(allowed_channels) : existing.allowed_channels,
    max_turns_per_session ?? existing.max_turns_per_session,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete agent config
router.delete('/:id', (req, res) => {
  const db = getDatabase();
  const existing = db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Agent config not found' });
    return;
  }

  db.prepare('DELETE FROM agent_configs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
