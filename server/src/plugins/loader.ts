import fs from 'fs';
import path from 'path';
import { PluginManifest } from './types';
import { pluginRegistry } from './registry';

const BUILTIN_DIR = path.join(__dirname, 'builtin');
const COMMUNITY_DIR = path.join(__dirname, 'community');

export async function loadAllPlugins(): Promise<void> {
  console.log('[PluginLoader] Loading plugins...');

  for (const dir of [BUILTIN_DIR, COMMUNITY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = path.join(dir, entry.name);
      try {
        await loadPlugin(pluginPath);
      } catch (err) {
        console.error(`[PluginLoader] Failed to load plugin at ${pluginPath}:`, err);
      }
    }
  }

  console.log('[PluginLoader] All plugins loaded.');
}

async function loadPlugin(pluginPath: string): Promise<void> {
  const manifestPath = path.join(pluginPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`[PluginLoader] No manifest.json in ${pluginPath}, skipping`);
    return;
  }

  const manifest: PluginManifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8')
  );

  // Check if plugin is enabled in DB (default: enabled)
  // Import lazily to avoid circular dependency issues at module load time
  const { getDatabase } = require('../models/database');
  let dbConfig: any = null;
  try {
    const db = getDatabase();
    dbConfig = db.prepare(
      'SELECT enabled, config FROM plugin_configs WHERE plugin_name = ?'
    ).get(manifest.name);
  } catch {
    // DB may not have plugin_configs table yet during initial setup
  }

  if (dbConfig && !dbConfig.enabled) {
    console.log(`[PluginLoader] Plugin ${manifest.name} is disabled, skipping`);
    return;
  }

  const config = dbConfig ? JSON.parse(dbConfig.config) : {};

  // Load entry point
  const entryPath = path.join(pluginPath, manifest.entry);
  const PluginModule = require(entryPath);
  const PluginClass = PluginModule.default || PluginModule;

  const plugin = new PluginClass(manifest);
  await plugin.initialize(config);

  pluginRegistry.register(manifest.type, manifest.name, plugin);
}
