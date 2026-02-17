import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDatabase } from '../models/database';

const router = Router();
router.use(authMiddleware);

// GET /api/skills/drafts — list pending drafts
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const drafts = db.prepare(
      "SELECT * FROM skill_drafts WHERE status = 'pending' ORDER BY created_at DESC"
    ).all();
    res.json(drafts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/skills/drafts/:id — get draft with diff info
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const draft = db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(req.params.id) as any;

    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }

    // If editing an existing skill, include original for comparison
    let original = null;
    if (draft.original_skill_id) {
      const table = draft.skill_type === 'skill' ? 'skills' : 'workflows';
      original = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(draft.original_skill_id);

      if (original) {
        const steps = db.prepare(
          'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
        ).all(draft.original_skill_id, draft.skill_type);
        (original as any).steps = steps;
      }
    }

    res.json({
      draft: {
        ...draft,
        steps: JSON.parse(draft.steps || '[]'),
      },
      original,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/skills/drafts/:id/approve — approve and apply draft
router.post('/:id/approve', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const draft = db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(req.params.id) as any;

    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }

    if (draft.status !== 'pending') {
      res.status(400).json({ error: `Draft is already ${draft.status}` });
      return;
    }

    const steps = JSON.parse(draft.steps || '[]');
    const table = draft.skill_type === 'skill' ? 'skills' : 'workflows';

    db.transaction(() => {
      if (draft.original_skill_id) {
        // Update existing skill/workflow
        db.prepare(`UPDATE ${table} SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(draft.name, draft.description, draft.original_skill_id);

        // Replace steps
        db.prepare('DELETE FROM skill_steps WHERE parent_id = ? AND parent_type = ?')
          .run(draft.original_skill_id, draft.skill_type);

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          db.prepare(`
            INSERT INTO skill_steps (parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            draft.original_skill_id, draft.skill_type, i + 1,
            step.step_name || `Step ${i + 1}`, step.step_type || 'ai',
            step.ai_model || null, step.prompt_template || '',
            step.input_config || '{}', step.output_format || 'text',
            step.model_config || '{}', step.executor_config || '{}'
          );
        }
      } else {
        // Create new skill/workflow
        const result = db.prepare(
          `INSERT INTO ${table} (name, description, created_by, status) VALUES (?, ?, 1, 'active')`
        ).run(draft.name, draft.description);

        const newId = Number(result.lastInsertRowid);

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          db.prepare(`
            INSERT INTO skill_steps (parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newId, draft.skill_type, i + 1,
            step.step_name || `Step ${i + 1}`, step.step_type || 'ai',
            step.ai_model || null, step.prompt_template || '',
            step.input_config || '{}', step.output_format || 'text',
            step.model_config || '{}', step.executor_config || '{}'
          );
        }
      }

      // Mark draft as approved
      db.prepare("UPDATE skill_drafts SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(draft.id);
    })();

    res.json({ success: true, message: 'Draft approved and applied' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/skills/drafts/:id/reject — reject draft
router.post('/:id/reject', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const draft = db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(req.params.id) as any;

    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }

    if (draft.status !== 'pending') {
      res.status(400).json({ error: `Draft is already ${draft.status}` });
      return;
    }

    db.prepare("UPDATE skill_drafts SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(draft.id);

    res.json({ success: true, message: 'Draft rejected' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
