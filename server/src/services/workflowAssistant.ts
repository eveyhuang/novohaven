import { callAIByModel, getAvailableModels } from './aiService';
import { getAllExecutors } from '../executors/registry';
import { AI_MODELS } from '../types';

// Types for the assistant
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GeneratedStep {
  step_name: string;
  step_type: string;
  ai_model: string;
  prompt_template: string;
  output_format: 'text' | 'json' | 'markdown' | 'image';
  executor_config?: Record<string, any>;
  // Skill sourcing
  from_skill_id?: number;
  // Backward compatibility
  from_template_id?: number;
  from_step_order?: number;
  override_fields?: string[];  // which fields the AI explicitly changed
}

export interface GeneratedWorkflow {
  name: string;
  description: string;
  steps: GeneratedStep[];
  requiredInputs: { name: string; type: string; description: string }[];
}

export interface AssistantResponse {
  message: string;
  workflow?: GeneratedWorkflow;
  suggestions?: string[];
  skillRequest?: number[];  // skill IDs the AI wants details for
  // Backward compatibility
  templateRequest?: number[];
}

// Preferred models for the assistant (in order of preference)
const PREFERRED_MODELS = [
  'gemini-3-pro-preview',
  'claude-opus-4-5',
  'gpt-4o',
  'gemini-2.5-flash',
];

function selectAssistantModel(): string {
  const available = getAvailableModels();
  const availableIds = available.map(m => m.id);

  for (const preferred of PREFERRED_MODELS) {
    if (availableIds.includes(preferred)) {
      return preferred;
    }
  }

  // Fall back to any available non-image-generation model
  const textModel = available.find(m => !m.supportsImageGeneration);
  if (textModel) return textModel.id;

  throw new Error('No AI models available. Please configure at least one AI provider.');
}

async function buildSystemPrompt(userId: number): Promise<string> {
  // Gather available skills
  const { getDatabase } = await import('../models/database');
  const db = getDatabase();
  const skills = db.prepare(
    'SELECT id, name, description FROM skills WHERE created_by = ? ORDER BY updated_at DESC'
  ).all(userId) as Array<{ id: number; name: string; description?: string | null }>;

  let skillSection = '';
  if (skills.length > 0) {
    const skillSummaries: string[] = [];
    for (const skill of skills) {
      const steps = db.prepare(
        "SELECT step_type FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order"
      ).all(skill.id) as Array<{ step_type: string }>;
      const stepTypes = steps.map((s) => s.step_type);
      skillSummaries.push(`- ID ${skill.id}: "${skill.name}" — ${skill.description || 'No description'}. Steps: [${stepTypes.join(', ')}]`);
    }

    skillSection = `
## Available Skills

You have access to pre-built skills. When a user's request matches or partially matches a skill, reference it instead of generating from scratch.

Skills:
${skillSummaries.join('\n')}

### When to use skills:
- **Exact match**: Recommend as-is, ask if user wants to run it directly
- **Partial match**: Suggest customizing (add/remove/modify steps)
- **Building blocks**: Pull specific steps from multiple skills, combine with new ones

### How to get skill details:
If you need the full configuration of a skill before generating the workflow, include a \`\`\`skill-request block with skill IDs as a JSON array. Example:
\`\`\`skill-request
[3, 4]
\`\`\`

### How to use a skill step:
In your workflow-json, mark the step with "from_skill_id" and "from_step_order".
You can override specific fields by listing them in "override_fields".
Example:
{
  "step_name": "Custom Name",
  "step_type": "scraping",
  "from_skill_id": 3,
  "from_step_order": 1,
  "override_fields": ["step_name"]
}
`;
  }

  // Gather available executors
  const executors = getAllExecutors();
  const executorDescriptions = executors.map(e => {
    const schema = e.getConfigSchema();
    const fields = schema.fields.map(f =>
      `    - ${f.name} (${f.type}${f.required ? ', required' : ''}): ${f.helpText || f.label}`
    ).join('\n');
    return `  - **${e.displayName}** (type: "${e.type}", icon: ${e.icon}): ${e.description}\n    Config fields:\n${fields}`;
  }).join('\n\n');

  // Gather available AI models
  const availableModels = getAvailableModels();
  const modelList = availableModels
    .filter(m => !m.supportsImageGeneration)
    .map(m => `  - ${m.id} (${m.name}, ${m.provider}, max ${m.maxTokens} tokens${m.supportsVision ? ', supports vision' : ''})`)
    .join('\n');

  const imageModels = availableModels
    .filter(m => m.supportsImageGeneration)
    .map(m => `  - ${m.id} (${m.name})`)
    .join('\n');

  return `You are an AI Workflow Builder assistant. You help users create multi-step workflows by understanding their goals and generating structured workflow configurations.

## Your Capabilities

You can create workflows using these step types:

${executorDescriptions}

## Available AI Models

Text/Analysis models:
${modelList}

${imageModels.length > 0 ? `Image generation models:\n${imageModels}` : ''}

## Variable System

Workflows support variables for data flow between steps:
- **User inputs**: \`{{variable_name}}\` — prompts the user for input when running the workflow
- **Step outputs**: \`{{step_N_output}}\` — references the output of step N (1-indexed)
- **Company standards**: \`{{company_voice}}\`, \`{{company_platform}}\`, \`{{company_image}}\` — auto-resolved from the user's saved standards

${skillSection}
## Instructions

1. **Respond in the user's language.** If they write in Chinese, respond in Chinese. If English, respond in English.

2. **ALWAYS check skills first — this is MANDATORY.** Before generating ANY step from scratch, compare the user's request against the Available Skills above. Skills contain carefully configured settings (API endpoints, scripts, model configs) that you CANNOT reliably reproduce.
   - If ANY skill is relevant (even partially), you MUST emit a \`\`\`skill-request block with those skill IDs and STOP. Do NOT generate a workflow-json in the same response. Wait for the skill details to be provided, then use \`from_skill_id\` to reference those steps.
   - Only generate steps from scratch when NO skill covers that specific functionality.
   - NEVER regenerate what a skill already provides — always reference it with \`from_skill_id\`.

3. **When the user describes a goal**, analyze it and either:
   - Ask clarifying questions if the goal is too vague
   - Generate a complete workflow if you have enough information

4. **When generating a workflow**, respond with BOTH:
   - A conversational explanation of what you've created
   - A JSON workflow block wrapped in \`\`\`workflow-json ... \`\`\` fences

5. **Choose the right step type for each task:**
   - Use "ai" for text generation, analysis, summarization, translation
   - Use "scraping" for fetching product reviews from URLs
   - Use "http" for calling external APIs
   - Use "script" for custom data processing or calculations
   - Use "transform" for format conversion (CSV/JSON), field mapping, filtering

6. **For AI steps**, write focused prompt templates. Include:
   - Clear instructions for the AI
   - Variable placeholders where needed (\`{{variable}}\` or \`{{step_N_output}}\`)
   - Output format instructions if specific formatting is needed
   - Keep prompts concise — avoid lengthy examples or verbose formatting guidelines that inflate the JSON size

7. **For non-AI steps**, provide complete executor_config with all required fields.

8. **When suggesting refinements**, offer 2-3 specific ideas the user might want.

## Workflow JSON Format

\`\`\`workflow-json
{
  "name": "Workflow Name",
  "description": "Brief description",
  "steps": [
    {
      "step_name": "Step Name",
      "step_type": "ai",
      "ai_model": "model-id",
      "prompt_template": "Complete prompt with {{variables}}",
      "output_format": "text",
      "executor_config": {}
    }
  ],
  "requiredInputs": [
    { "name": "variable_name", "type": "text", "description": "What this input is for" }
  ]
}
\`\`\`

Input types for requiredInputs: "text", "textarea", "url_list", "image", "file"

Always ensure step outputs chain correctly — if step 2 needs step 1's output, use \`{{step_1_output}}\` in step 2's prompt.

CRITICAL: When you generate a workflow, you MUST include a \`\`\`workflow-json code block with the complete JSON. Without this block, the workflow cannot be displayed to the user. NEVER skip the JSON block when generating a workflow.`;
}


function tryParseWorkflow(jsonStr: string): GeneratedWorkflow | null {
  try {
    const workflow = JSON.parse(jsonStr) as GeneratedWorkflow;
    if (workflow.name && workflow.steps && Array.isArray(workflow.steps)) {
      workflow.steps = workflow.steps.map((step, i) => ({
        step_name: step.step_name || `Step ${i + 1}`,
        step_type: step.step_type || 'ai',
        ai_model: step.ai_model || '',
        prompt_template: step.prompt_template || '',
        output_format: step.output_format || 'text',
        executor_config: step.executor_config,
        from_skill_id: step.from_skill_id || step.from_template_id,
        from_template_id: step.from_template_id || step.from_skill_id,
        from_step_order: step.from_step_order,
        override_fields: step.override_fields,
      }));
      workflow.requiredInputs = workflow.requiredInputs || [];
      return workflow;
    }
  } catch (e) {
    // JSON parse failed
  }
  return null;
}

function parseAssistantResponse(content: string): AssistantResponse {
  const result: AssistantResponse = {
    message: content,
  };

  // Strategy 1: Look for ```workflow-json fences (preferred)
  let match = content.match(/```workflow-json\s*\n?([\s\S]*?)\n?\s*```/);
  if (match) {
    const workflow = tryParseWorkflow(match[1]);
    if (workflow) {
      result.workflow = workflow;
      result.message = content.replace(/```workflow-json\s*\n?[\s\S]*?\n?\s*```/, '').trim();
    }
  }

  // Strategy 2: Fall back to ```json fences
  if (!result.workflow) {
    match = content.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) {
      const workflow = tryParseWorkflow(match[1]);
      if (workflow) {
        result.workflow = workflow;
        result.message = content.replace(/```json\s*\n?[\s\S]*?\n?\s*```/, '').trim();
      }
    }
  }

  // Strategy 3: Fall back to raw JSON with "name" + "steps" keys
  if (!result.workflow) {
    const rawMatch = content.match(/(\{[\s\S]*"name"\s*:[\s\S]*"steps"\s*:\s*\[[\s\S]*\][\s\S]*\})/);
    if (rawMatch) {
      const workflow = tryParseWorkflow(rawMatch[1]);
      if (workflow) {
        result.workflow = workflow;
        // Don't strip raw JSON from message — it might remove meaningful content
      }
    }
  }

  // Extract skill-request block if present
  const skillMatch = content.match(/```skill-request\s*\n?([\s\S]*?)\n?\s*```/);
  if (skillMatch) {
    try {
      const ids = JSON.parse(skillMatch[1]);
      if (Array.isArray(ids) && ids.every((id: any) => typeof id === 'number')) {
        result.skillRequest = ids;
        result.templateRequest = ids;
        result.message = result.message.replace(/```skill-request\s*\n?[\s\S]*?\n?\s*```/, '').trim();
      }
    } catch (e) {
      // Invalid JSON in skill-request block — ignore
    }
  }

  // Extract suggestions if present (look for numbered lists at the end)
  const suggestionsMatch = result.message.match(/(?:suggestions?|refinements?|ideas?|建议|优化)[:\s：]*\n((?:\s*[-\d.]+[.、)）]\s*.+\n?)+)/i);
  if (suggestionsMatch) {
    const lines = suggestionsMatch[1].split('\n')
      .map(line => line.replace(/^\s*[-\d.]+[.、)）]\s*/, '').trim())
      .filter(line => line.length > 0);
    if (lines.length > 0) {
      result.suggestions = lines;
    }
  }

  return result;
}

export async function generateWorkflow(
  messages: ConversationMessage[],
  userId: number
): Promise<AssistantResponse> {
  if (!messages.length) {
    return {
      message: 'Please describe the workflow you want to create.',
      suggestions: [
        'Analyze product reviews from Amazon and generate improvement suggestions',
        'Research competitors and create a comparison report',
        'Scrape reviews, clean the data, and generate marketing copy',
      ],
    };
  }

  const modelId = selectAssistantModel();
  const systemPrompt = await buildSystemPrompt(userId);

  // Build multi-turn messages, with a format reminder on the last user message
  const apiMessages = messages.map((msg, i) => {
    if (i === messages.length - 1 && msg.role === 'user') {
      return {
        role: msg.role,
        content: msg.content +
          '\n\n[IMPORTANT: If you generate a workflow, you MUST include a ```workflow-json code block with the complete JSON structure. Do not omit it.]',
      };
    }
    return { role: msg.role, content: msg.content };
  });

  const response = await callAIByModel(modelId, '', {
    temperature: 0.7,
    maxTokens: 16000,
    systemMessage: systemPrompt,
    messages: apiMessages,
  });

  if (!response.success) {
    throw new Error(response.error || 'AI generation failed');
  }

  const parsed = parseAssistantResponse(response.content);

  // Two-pass: if the AI requested skill details, fetch them and do a second call
  if (parsed.skillRequest && parsed.skillRequest.length > 0) {
    const { getDatabase } = await import('../models/database');
    const db = getDatabase();
    const skillDetails: string[] = [];

    for (const skillId of parsed.skillRequest) {
      const steps = db.prepare(
        "SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order"
      ).all(skillId) as any[];
      if (steps.length === 0) continue;

      const stepDescriptions = steps.map((s: any) => {
        const details: Record<string, any> = {
          step_order: s.step_order,
          step_name: s.step_name,
          step_type: s.step_type,
          ai_model: s.ai_model,
          prompt_template: s.prompt_template,
          output_format: s.output_format,
        };
        if (s.api_config) details.api_config = JSON.parse(s.api_config);
        if (s.executor_config) details.executor_config = JSON.parse(s.executor_config);
        if (s.input_config) details.input_config = JSON.parse(s.input_config);
        if (s.model_config) details.model_config = JSON.parse(s.model_config);
        return details;
      });

      skillDetails.push(`Skill ID ${skillId}:\n${JSON.stringify(stepDescriptions, null, 2)}`);
    }

    if (skillDetails.length > 0) {
      // Inject skill details as a follow-up and do a second AI call
      const followUpMessages: { role: 'user' | 'assistant'; content: string }[] = [
        ...apiMessages,
        { role: 'assistant' as const, content: response.content },
        {
          role: 'user' as const,
          content: `Here are the full skill details you requested:\n\n${skillDetails.join('\n\n')}\n\nReference these steps using from_skill_id and from_step_order rather than regenerating the config. Only include fields in override_fields if you explicitly changed them. Now generate the workflow-json.`,
        },
      ];

      const secondResponse = await callAIByModel(modelId, '', {
        temperature: 0.7,
        maxTokens: 16000,
        systemMessage: systemPrompt,
        messages: followUpMessages,
      });

      if (!secondResponse.success) {
        throw new Error(secondResponse.error || 'AI generation failed (second pass)');
      }

      const secondParsed = parseAssistantResponse(secondResponse.content);

      if (!secondParsed.workflow) {
        console.warn('[WorkflowAssistant] No workflow JSON extracted from second-pass AI response.');
      }

      return secondParsed;
    }
  }

  if (!parsed.workflow) {
    console.warn('[WorkflowAssistant] No workflow JSON extracted from AI response. Response length:', response.content.length,
      '| Has workflow-json fence:', /```workflow-json/.test(response.content),
      '| Has json fence:', /```json/.test(response.content));
  }

  return parsed;
}

export async function saveWorkflowGraph(
  workflow: GeneratedWorkflow,
  userId: number,
  asSkill: boolean = false
): Promise<{ entityType: 'skill' | 'workflow'; skillId?: number; workflowId?: number }> {
  const { getDatabase } = await import('../models/database');
  const db = getDatabase();

  const parentType: 'skill' | 'workflow' = asSkill ? 'skill' : 'workflow';
  const parentTable = asSkill ? 'skills' : 'workflows';
  const parentInsert = db.prepare(
    `INSERT INTO ${parentTable} (name, description, created_by, tags) VALUES (?, ?, ?, ?)`
  );
  const parentResult = parentInsert.run(
    workflow.name,
    workflow.description || null,
    userId,
    JSON.stringify([])
  );
  const parentId = Number(parentResult.lastInsertRowid);

  const getSkillStep = db.prepare(
    "SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' AND step_order = ?"
  );
  const insertStep = db.prepare(`
    INSERT INTO skill_steps (
      parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];

    let mergedPrompt = step.prompt_template || '';
    let mergedAiModel = step.ai_model || null;
    let mergedOutputFormat = step.output_format || 'text';
    let mergedStepType = step.step_type || 'ai';
    let mergedExecutorConfig: string = step.executor_config ? JSON.stringify(step.executor_config) : '{}';
    let mergedModelConfig: string = '{}';
    let mergedInputConfig: string = '{}';

    const sourceSkillId = step.from_skill_id || step.from_template_id;
    if (sourceSkillId && step.from_step_order) {
      const sourceStep = getSkillStep.get(sourceSkillId, step.from_step_order) as any;
      if (sourceStep) {
        mergedPrompt = sourceStep.prompt_template || '';
        mergedAiModel = sourceStep.ai_model || null;
        mergedOutputFormat = sourceStep.output_format || 'text';
        mergedStepType = sourceStep.step_type || 'ai';
        mergedExecutorConfig = sourceStep.executor_config || '{}';
        mergedModelConfig = sourceStep.model_config || '{}';
        mergedInputConfig = sourceStep.input_config || '{}';

        const overrides = step.override_fields || [];
        if (overrides.includes('prompt_template')) mergedPrompt = step.prompt_template || '';
        if (overrides.includes('ai_model')) mergedAiModel = step.ai_model || null;
        if (overrides.includes('output_format')) mergedOutputFormat = step.output_format || 'text';
        if (overrides.includes('step_type')) mergedStepType = step.step_type || 'ai';
        if (overrides.includes('executor_config') && step.executor_config) {
          mergedExecutorConfig = JSON.stringify(step.executor_config);
        }
      }
    }

    if (!mergedInputConfig || mergedInputConfig === '{}' || mergedInputConfig === '') {
      const stepVars = workflow.requiredInputs.filter((input) => {
        if (mergedPrompt.includes(`{{${input.name}}}`)) return true;
        if (mergedExecutorConfig.includes(`{{${input.name}}}`)) return true;
        if (mergedStepType === 'scraping' && input.type === 'url_list') return true;
        return false;
      });

      mergedInputConfig = stepVars.length > 0
        ? JSON.stringify({
            variables: stepVars.reduce((acc, v) => {
              acc[v.name] = { type: v.type, description: v.description };
              return acc;
            }, {} as Record<string, any>),
          })
        : '{}';
    }

    insertStep.run(
      parentId,
      parentType,
      i + 1,
      step.step_name,
      mergedStepType,
      mergedAiModel,
      mergedPrompt,
      mergedInputConfig,
      mergedOutputFormat,
      mergedModelConfig,
      mergedExecutorConfig
    );
  }

  if (asSkill) {
    return { entityType: 'skill', skillId: parentId };
  }
  return { entityType: 'workflow', workflowId: parentId };
}

// Backward-compatible alias used by older tests and callers.
export async function saveWorkflowAsRecipe(
  workflow: GeneratedWorkflow,
  userId: number,
  isTemplate: boolean = false
): Promise<{ recipeId: number }> {
  const result = await saveWorkflowGraph(workflow, userId, isTemplate);
  return { recipeId: Number(result.workflowId || result.skillId || 0) };
}
