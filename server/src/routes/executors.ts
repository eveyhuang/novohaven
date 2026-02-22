import { Router } from 'express';
import { getAllExecutors } from '../executors/registry';

const router = Router();
const BUSINESS_EXECUTOR_TYPES = new Set(['ai', 'manus', 'browser']);

// GET /api/executors - List all available step executor types with their config schemas
router.get('/', (req, res) => {
  const mode = String(req.query.mode || 'all').toLowerCase();
  const source = getAllExecutors();
  const filtered = mode === 'business'
    ? source.filter((e) => BUSINESS_EXECUTOR_TYPES.has(e.type))
    : source;

  const executors = filtered.map(e => ({
    type: e.type,
    displayName: e.displayName,
    icon: e.icon,
    description: e.description,
    configSchema: e.getConfigSchema(),
  }));
  res.json(executors);
});

export default router;
