import fs from 'fs';
import path from 'path';
import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';

class FileOpsPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private allowedPaths: string[] = [];
  private maxFileSize: number = 1048576; // 1MB

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    if (config.allowedPaths) this.allowedPaths = config.allowedPaths.map((p: string) => path.resolve(p));
    if (config.maxFileSize) this.maxFileSize = config.maxFileSize;
  }

  async shutdown(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'file:read',
        description: 'Read the contents of a file. Returns text content.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the file' },
            encoding: { type: 'string', description: 'File encoding (default utf-8)' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'file:write',
        description: 'Write content to a file. Creates the file if it does not exist.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to write to' },
            content: { type: 'string', description: 'Content to write' },
            append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
          },
          required: ['filePath', 'content'],
        },
      },
      {
        name: 'file:list',
        description: 'List files and directories at a path.',
        parameters: {
          type: 'object',
          properties: {
            dirPath: { type: 'string', description: 'Directory path to list' },
            recursive: { type: 'boolean', description: 'List recursively (default false)' },
          },
          required: ['dirPath'],
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    switch (toolName) {
      case 'file:read': return this.readFile(args);
      case 'file:write': return this.writeFile(args);
      case 'file:list': return this.listDir(args);
      default: return { success: false, output: `Unknown tool: ${toolName}` };
    }
  }

  private isPathAllowed(targetPath: string): boolean {
    if (this.allowedPaths.length === 0) return true;
    const resolved = path.resolve(targetPath);
    return this.allowedPaths.some(allowed => resolved.startsWith(allowed));
  }

  private async readFile(args: Record<string, any>): Promise<ToolResult> {
    const filePath = args.filePath;
    if (!this.isPathAllowed(filePath)) {
      return { success: false, output: `Access denied: ${filePath} is outside allowed paths` };
    }

    try {
      const stats = fs.statSync(filePath);
      if (stats.size > this.maxFileSize) {
        return { success: false, output: `File too large: ${stats.size} bytes (max: ${this.maxFileSize})` };
      }
      const content = fs.readFileSync(filePath, { encoding: args.encoding || 'utf-8' });
      return { success: true, output: content.toString() };
    } catch (err: any) {
      return { success: false, output: `Read error: ${err.message}` };
    }
  }

  private async writeFile(args: Record<string, any>): Promise<ToolResult> {
    const filePath = args.filePath;
    if (!this.isPathAllowed(filePath)) {
      return { success: false, output: `Access denied: ${filePath} is outside allowed paths` };
    }

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (args.append) {
        fs.appendFileSync(filePath, args.content);
      } else {
        fs.writeFileSync(filePath, args.content);
      }
      return { success: true, output: `Written to ${filePath} (${args.content.length} chars)` };
    } catch (err: any) {
      return { success: false, output: `Write error: ${err.message}` };
    }
  }

  private async listDir(args: Record<string, any>): Promise<ToolResult> {
    const dirPath = args.dirPath;
    if (!this.isPathAllowed(dirPath)) {
      return { success: false, output: `Access denied: ${dirPath} is outside allowed paths` };
    }

    try {
      if (args.recursive) {
        const entries = this.listRecursive(dirPath, '', 3); // max 3 levels
        return { success: true, output: entries.join('\n') || '(empty)' };
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines = entries.map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`);
      return { success: true, output: lines.join('\n') || '(empty directory)' };
    } catch (err: any) {
      return { success: false, output: `List error: ${err.message}` };
    }
  }

  private listRecursive(dir: string, prefix: string, maxDepth: number): string[] {
    if (maxDepth <= 0) return [`${prefix}...`];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(`${prefix}[dir] ${entry.name}/`);
        results.push(...this.listRecursive(fullPath, prefix + '  ', maxDepth - 1));
      } else {
        results.push(`${prefix}[file] ${entry.name}`);
      }
    }
    return results;
  }
}

export default FileOpsPlugin;
