import { exec } from 'child_process';
import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';

const DEFAULT_DENIED = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb', 'shutdown', 'reboot', 'halt'];

class BashToolPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private allowedCommands: string[] = [];
  private deniedCommands: string[] = DEFAULT_DENIED;
  private workingDirectory: string = process.cwd();
  private timeoutMs: number = 30000;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    if (config.allowedCommands) this.allowedCommands = config.allowedCommands;
    if (config.deniedCommands) this.deniedCommands = [...DEFAULT_DENIED, ...config.deniedCommands];
    if (config.workingDirectory) this.workingDirectory = config.workingDirectory;
    if (config.timeoutMs) this.timeoutMs = config.timeoutMs;
  }

  async shutdown(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'bash:execute',
        description: 'Execute a shell command and return stdout/stderr. Use for system commands, data processing, or running scripts.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            workingDirectory: { type: 'string', description: 'Override working directory' },
            timeoutMs: { type: 'number', description: 'Override timeout in ms' },
          },
          required: ['command'],
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const command = args.command;
    if (!command) {
      return { success: false, output: 'No command provided' };
    }

    // Security checks
    const denied = this.deniedCommands.find(d => command.toLowerCase().includes(d.toLowerCase()));
    if (denied) {
      return { success: false, output: `Command denied: matches blocked pattern "${denied}"` };
    }

    if (this.allowedCommands.length > 0) {
      const allowed = this.allowedCommands.some(a => command.startsWith(a));
      if (!allowed) {
        return { success: false, output: `Command not in allowlist. Allowed prefixes: ${this.allowedCommands.join(', ')}` };
      }
    }

    const cwd = args.workingDirectory || this.workingDirectory;
    const timeout = args.timeoutMs || this.timeoutMs;

    return new Promise((resolve) => {
      exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const output = [
            stderr ? `stderr: ${stderr.substring(0, 2000)}` : '',
            stdout ? `stdout: ${stdout.substring(0, 2000)}` : '',
            `Exit code: ${error.code || 'unknown'}`,
          ].filter(Boolean).join('\n');

          resolve({
            success: false,
            output: output || error.message,
            metadata: { exitCode: error.code },
          });
          return;
        }

        const output = [
          stdout ? stdout.substring(0, 4000) : '',
          stderr ? `(stderr: ${stderr.substring(0, 500)})` : '',
        ].filter(Boolean).join('\n');

        resolve({
          success: true,
          output: output || '(no output)',
          metadata: { exitCode: 0 },
        });
      });
    });
  }
}

export default BashToolPlugin;
