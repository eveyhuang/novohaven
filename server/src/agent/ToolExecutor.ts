/**
 * ToolExecutor — bridges LLM tool calls to tool plugins and built-in tools.
 *
 * Aggregates tool definitions from:
 * - All registered tool plugins (via getTools())
 * - Built-in agent tools: skill:search, skill:execute, skill:test, skill:edit, skill:create, skill:validate, approval:request
 *
 * Routes tool calls to the appropriate handler:
 * - skill:* and approval:* → internal handlers
 * - Everything else → delegate to matching tool plugin
 */
import { ToolDefinition, ToolPlugin, ToolResult, ToolContext } from '../plugins/types';

export class ToolExecutor {
  private toolPlugins: Map<string, ToolPlugin>;
  private context: ToolContext;

  constructor(toolPlugins: Map<string, ToolPlugin>, context: ToolContext) {
    this.toolPlugins = toolPlugins;
    this.context = context;
  }

  /**
   * Get all available tool definitions (plugin tools + built-in).
   */
  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];

    // Gather from all registered tool plugins
    for (const [, plugin] of this.toolPlugins) {
      defs.push(...plugin.getTools());
    }

    // Add built-in agent tools, skipping any already provided by plugins
    const existingNames = new Set(defs.map(d => d.name));
    for (const builtin of this.getBuiltInToolDefinitions()) {
      if (!existingNames.has(builtin.name)) {
        defs.push(builtin);
      }
    }

    return defs;
  }

  /**
   * Execute a tool call by name.
   */
  async execute(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    // Check built-in tools first (names use _ but accept : for back-compat)
    const normalized = toolName.replace(':', '_');
    if (normalized.startsWith('skill_') || normalized.startsWith('approval_')) {
      return this.executeBuiltIn(normalized, args);
    }

    // Find the plugin that owns this tool
    for (const [, plugin] of this.toolPlugins) {
      const tools = plugin.getTools();
      if (tools.some(t => t.name === toolName)) {
        return plugin.execute(toolName, args, this.context);
      }
    }

    return { success: false, output: `Unknown tool: ${toolName}` };
  }

  /**
   * Execute a built-in agent tool.
   * These are stubs that delegate to the tool-skill-manager plugin
   * or internal approval logic. The actual implementations live in the
   * tool-skill-manager plugin (Task 6.1).
   */
  private async executeBuiltIn(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    // Delegate skill_* tools to the skill manager plugin if registered
    const skillManager = this.toolPlugins.get('tool-skill-manager');
    if (skillManager) {
      const tools = skillManager.getTools();
      if (tools.some(t => t.name === toolName)) {
        return skillManager.execute(toolName, args, this.context);
      }
    }

    // Handle approval_request internally
    if (toolName === 'approval_request') {
      return this.handleApprovalRequest(args);
    }

    return { success: false, output: `Built-in tool not available: ${toolName}` };
  }

  /**
   * Request human approval via the gateway.
   */
  private async handleApprovalRequest(args: Record<string, any>): Promise<ToolResult> {
    const requestId = `approval-${Date.now()}`;

    // Send approval request to gateway via IPC
    process.send!({
      type: 'approval_request',
      sessionId: this.context.sessionId,
      requestId,
      description: args.description || 'Agent requests approval',
      data: args.data || {},
    });

    return {
      success: true,
      output: `Approval request sent (id: ${requestId}). Waiting for human response.`,
      metadata: { requestId },
    };
  }

  /**
   * Built-in tool definitions that are always available to the agent.
   */
  private getBuiltInToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'skill_search',
        description: 'Search for skills and workflows by name or description. Returns matching skills with IDs.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            type: { type: 'string', enum: ['skill', 'workflow', 'all'], description: 'Filter by type' },
            limit: { type: 'number', description: 'Max results (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'skill_execute',
        description: 'Execute a skill or workflow by ID with the given inputs. Creates a workflow execution.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill or workflow ID' },
            skillType: { type: 'string', enum: ['skill', 'workflow'], description: 'Type of skill' },
            inputs: { type: 'object', description: 'Input variables for the skill' },
          },
          required: ['skillId', 'skillType'],
        },
      },
      {
        name: 'skill_test',
        description: 'Test a skill with inputs without saving results. Returns the output for preview.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to test' },
            inputs: { type: 'object', description: 'Test input variables' },
          },
          required: ['skillId'],
        },
      },
      {
        name: 'skill_edit',
        description: 'Propose edits to an existing skill. Creates a draft that appears on the Skill Draft Review page for human approval. Use this to fix or improve broken skills.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to edit' },
            name: { type: 'string', description: 'New name (optional)' },
            description: { type: 'string', description: 'New description (optional)' },
            steps: {
              type: 'array',
              description: 'Updated steps array',
              items: {
                type: 'object',
                properties: {
                  step_name: { type: 'string' },
                  step_type: { type: 'string' },
                  prompt_template: { type: 'string' },
                  ai_model: { type: 'string' },
                },
              },
            },
            changeSummary: { type: 'string', description: 'Summary of what changed and why' },
          },
          required: ['skillId', 'changeSummary'],
        },
      },
      {
        name: 'skill_create',
        description: 'Create a new skill draft. Requires human approval before becoming active.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name' },
            description: { type: 'string', description: 'Skill description' },
            skillType: { type: 'string', enum: ['skill', 'workflow'], description: 'Type' },
            steps: {
              type: 'array',
              description: 'Skill steps',
              items: {
                type: 'object',
                properties: {
                  step_name: { type: 'string' },
                  step_type: { type: 'string' },
                  prompt_template: { type: 'string' },
                  ai_model: { type: 'string' },
                },
                required: ['step_name', 'prompt_template'],
              },
            },
          },
          required: ['name', 'description', 'steps'],
        },
      },
      {
        name: 'skill_validate',
        description: 'Validate a skill for missing variables, invalid configs, or other issues.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to validate' },
          },
          required: ['skillId'],
        },
      },
      // approval_request removed — IPC handler not wired up yet.
      // Agent should use skill_edit/skill_create which create drafts
      // that go through the Skill Draft Review page.
    ];
  }
}
