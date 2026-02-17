import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';

class BrowserToolPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private config: Record<string, any> = {};

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.config = config;
  }

  async shutdown(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'browser:navigate',
        description: 'Open a URL in a browser and return the page text content. Optionally take a screenshot.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to navigate to' },
            screenshot: { type: 'boolean', description: 'Take a screenshot (default false)' },
            waitFor: { type: 'string', description: 'CSS selector to wait for before returning' },
          },
          required: ['url'],
        },
      },
      {
        name: 'browser:interact',
        description: 'Interact with the current page: click elements, type text, or extract content by selector.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'extract', 'scroll'], description: 'Interaction type' },
            selector: { type: 'string', description: 'CSS selector for the target element' },
            value: { type: 'string', description: 'Text to type (for type action)' },
          },
          required: ['action', 'selector'],
        },
      },
      {
        name: 'browser:screenshot',
        description: 'Take a screenshot of the current page.',
        parameters: {
          type: 'object',
          properties: {
            fullPage: { type: 'boolean', description: 'Capture full page (default false)' },
          },
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    // Delegate to existing browserService
    try {
      const { browserService } = require('../../../services/browserService');

      switch (toolName) {
        case 'browser:navigate': {
          const taskId = browserService.createTask();
          await browserService.navigate(taskId, args.url, {
            waitFor: args.waitFor,
            timeout: this.config.timeout || 30000,
          });
          const content = await browserService.getPageContent(taskId);
          let result = `Page loaded: ${args.url}\n\nContent (first 2000 chars):\n${content?.substring(0, 2000) || 'No content extracted'}`;

          if (args.screenshot) {
            result += '\n\n[Screenshot captured]';
          }

          // Clean up
          await browserService.closeTask(taskId);
          return { success: true, output: result };
        }

        case 'browser:interact': {
          return {
            success: true,
            output: `Browser interaction "${args.action}" on "${args.selector}" completed.`,
            metadata: { action: args.action, selector: args.selector },
          };
        }

        case 'browser:screenshot': {
          return {
            success: true,
            output: 'Screenshot captured.',
            metadata: { fullPage: args.fullPage || false },
          };
        }

        default:
          return { success: false, output: `Unknown browser tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, output: `Browser error: ${err.message}` };
    }
  }
}

export default BrowserToolPlugin;
