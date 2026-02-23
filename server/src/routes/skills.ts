import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDatabase } from '../models/database';

const router = Router();
router.use(authMiddleware);
const DISABLED_SKILL_STEP_TYPES = new Set(['manus']);

function findDisabledStepType(steps: any[] | undefined): string | null {
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const type = String(step?.step_type || 'ai').trim().toLowerCase();
    if (DISABLED_SKILL_STEP_TYPES.has(type)) return type;
  }
  return null;
}

// GET /api/skills — list all skills
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userId = req.user!.id;
    const skills = db.prepare(
      'SELECT * FROM skills WHERE created_by = ? ORDER BY updated_at DESC'
    ).all(userId) as any[];

    const withCounts = skills.map(skill => {
      const stepCount = (db.prepare(
        "SELECT COUNT(*) as count FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill'"
      ).get(skill.id) as any).count;
      return { ...skill, step_count: stepCount };
    });

    res.json(withCounts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/skills — create skill
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userId = req.user!.id;
    const { name, description, steps, tags } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Skill name is required' });
      return;
    }

    const disabledType = findDisabledStepType(steps);
    if (disabledType) {
      res.status(400).json({ error: `Step type "${disabledType}" is no longer supported for skills` });
      return;
    }

    const result = db.prepare(
      'INSERT INTO skills (name, description, created_by, tags) VALUES (?, ?, ?, ?)'
    ).run(name, description || null, userId, JSON.stringify(tags || []));

    const skillId = Number(result.lastInsertRowid);

    // Create steps if provided
    if (steps && steps.length > 0) {
      const insertStep = db.prepare(`
        INSERT INTO skill_steps (parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config)
        VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        insertStep.run(
          skillId, i + 1, step.step_name || `Step ${i + 1}`,
          step.step_type || 'ai', step.ai_model || null,
          step.prompt_template || '', step.input_config || '{}',
          step.output_format || 'text', step.model_config || '{}',
          step.executor_config || '{}'
        );
      }
    }

    const created = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
    res.status(201).json(created);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/skills/:id — get skill with steps
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id) as any;

    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const steps = db.prepare(
      "SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order"
    ).all(skill.id);

    res.json({ ...skill, steps });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/skills/:id — update skill
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const { name, description, status, tags, steps } = req.body;

    const disabledType = findDisabledStepType(steps);
    if (disabledType) {
      res.status(400).json({ error: `Step type "${disabledType}" is no longer supported for skills` });
      return;
    }

    db.prepare(`
      UPDATE skills SET name = ?, description = ?, status = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(
      name ?? existing.name,
      description ?? existing.description,
      status ?? existing.status,
      tags ? JSON.stringify(tags) : existing.tags,
      req.params.id
    );

    // Update steps if provided
    if (steps) {
      db.prepare("DELETE FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill'").run(req.params.id);
      const insertStep = db.prepare(`
        INSERT INTO skill_steps (parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config)
        VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        insertStep.run(
          req.params.id, i + 1, step.step_name || `Step ${i + 1}`,
          step.step_type || 'ai', step.ai_model || null,
          step.prompt_template || '', step.input_config || '{}',
          step.output_format || 'text', step.model_config || '{}',
          step.executor_config || '{}'
        );
      }
    }

    const updated = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/skills/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    db.prepare("DELETE FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill'").run(req.params.id);
    db.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/skills/:id/clone
router.post('/:id/clone', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userId = req.user!.id;
    const original = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id) as any;

    if (!original) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const newName = req.body.name || `${original.name} (Copy)`;
    // Clone steps
    const steps = db.prepare(
      "SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order"
    ).all(original.id) as any[];

    const disabledStep = steps.find((step) => DISABLED_SKILL_STEP_TYPES.has(String(step?.step_type || 'ai').trim().toLowerCase()));
    if (disabledStep) {
      res.status(400).json({ error: `Cannot clone skill with unsupported step type "${disabledStep.step_type}"` });
      return;
    }

    const result = db.prepare(
      'INSERT INTO skills (name, description, created_by, tags) VALUES (?, ?, ?, ?)'
    ).run(newName, original.description, userId, original.tags);

    const newId = Number(result.lastInsertRowid);

    const insertStep = db.prepare(`
      INSERT INTO skill_steps (parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config)
      VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const step of steps) {
      insertStep.run(
        newId, step.step_order, step.step_name, step.step_type,
        step.ai_model, step.prompt_template, step.input_config,
        step.output_format, step.model_config, step.executor_config
      );
    }

    const cloned = db.prepare('SELECT * FROM skills WHERE id = ?').get(newId);
    res.status(201).json(cloned);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
