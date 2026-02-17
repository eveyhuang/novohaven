import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { pluginRegistry } from '../plugins/registry';
import { getDatabase } from '../models/database';

const router = Router();
router.use(authMiddleware);

// List all plugins with their status
router.get('/', (req, res) => {
  const manifests = pluginRegistry.getAllManifests();
  const db = getDatabase();
  const dbConfigs = db.prepare('SELECT * FROM plugin_configs').all() as any[];
  const configMap = new Map(dbConfigs.map((c: any) => [c.plugin_name, c]));

  const plugins = Array.from(manifests.entries()).map(([name, manifest]) => {
    const dbConfig = configMap.get(name);
    return {
      name: manifest.name,
      type: manifest.type,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      enabled: dbConfig ? !!dbConfig.enabled : true,
      config: dbConfig ? JSON.parse(dbConfig.config) : {},
      configSchema: manifest.config || null,
    };
  });

  res.json(plugins);
});

// Update plugin config
router.put('/:name', (req, res) => {
  const { name } = req.params;
  const { enabled, config } = req.body;
  const db = getDatabase();

  const existing = db.prepare('SELECT id FROM plugin_configs WHERE plugin_name = ?').get(name) as any;
  if (existing) {
    db.prepare(
      'UPDATE plugin_configs SET enabled = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE plugin_name = ?'
    ).run(enabled ? 1 : 0, JSON.stringify(config || {}), name);
  } else {
    const manifest = pluginRegistry.getAllManifests().get(name);
    if (!manifest) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    db.prepare(
      'INSERT INTO plugin_configs (plugin_name, plugin_type, enabled, config) VALUES (?, ?, ?, ?)'
    ).run(name, manifest.type, enabled ? 1 : 0, JSON.stringify(config || {}));
  }

  res.json({ success: true });
});

export default router;
