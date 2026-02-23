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
  const manifestPath = resolveManifestPath(pluginPath);
  if (!manifestPath) {
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
  const entryPath = resolveEntryPath(pluginPath, manifest.entry);
  if (!entryPath) {
    throw new Error(`Entry not found for plugin ${manifest.name}: ${manifest.entry}`);
  }
  const PluginModule = require(entryPath);
  const PluginClass = PluginModule.default || PluginModule;

  const plugin = new PluginClass(manifest);
  await plugin.initialize(config);

  pluginRegistry.register(manifest.type, manifest.name, plugin);
}

function resolveManifestPath(pluginPath: string): string | null {
  const direct = path.join(pluginPath, 'manifest.json');
  if (fs.existsSync(direct)) return direct;

  // Dist builds may not include JSON assets. Fall back to src for manifest only.
  const srcPath = pluginPath.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`);
  if (srcPath !== pluginPath) {
    const srcManifest = path.join(srcPath, 'manifest.json');
    if (fs.existsSync(srcManifest)) return srcManifest;
  }

  return null;
}

function resolveEntryPath(pluginPath: string, manifestEntry: string): string | null {
  const normalized = manifestEntry || './index.ts';
  const direct = path.join(pluginPath, normalized);
  if (fs.existsSync(direct)) return direct;

  const ext = path.extname(normalized);
  if (ext === '.ts') {
    const jsVariant = path.join(pluginPath, normalized.replace(/\.ts$/i, '.js'));
    if (fs.existsSync(jsVariant)) return jsVariant;
  } else if (ext === '.js') {
    const tsVariant = path.join(pluginPath, normalized.replace(/\.js$/i, '.ts'));
    if (fs.existsSync(tsVariant)) return tsVariant;
  } else {
    const jsVariant = `${direct}.js`;
    if (fs.existsSync(jsVariant)) return jsVariant;
    const tsVariant = `${direct}.ts`;
    if (fs.existsSync(tsVariant)) return tsVariant;
  }

  return null;
}
