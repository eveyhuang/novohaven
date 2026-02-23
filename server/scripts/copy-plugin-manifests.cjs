const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const srcPluginsDir = path.join(repoRoot, 'src', 'plugins');
const distPluginsDir = path.join(repoRoot, 'dist', 'plugins');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name === 'manifest.json') {
      copyManifest(fullPath);
    }
  }
}

function copyManifest(srcManifestPath) {
  const relative = path.relative(path.join(repoRoot, 'src'), srcManifestPath);
  const targetPath = path.join(repoRoot, 'dist', relative);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(srcManifestPath, targetPath);
  console.log(`[build] copied ${relative}`);
}

if (!fs.existsSync(srcPluginsDir)) {
  console.log('[build] no src/plugins directory found, skipping manifest copy');
  process.exit(0);
}

fs.mkdirSync(distPluginsDir, { recursive: true });
walk(srcPluginsDir);
