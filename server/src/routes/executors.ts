import { Router } from 'express';
import { getAllExecutors } from '../executors/registry';

const router = Router();

// GET /api/executors - List all available step executor types with their config schemas
router.get('/', (req, res) => {
  const executors = getAllExecutors().map(e => ({
    type: e.type,
    displayName: e.displayName,
    icon: e.icon,
    description: e.description,
    configSchema: e.getConfigSchema(),
  }));
  res.json(executors);
});

export default router;
