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
}

// Preferred models for the assistant (in order of preference)
const PREFERRED_MODELS = [
  'claude-opus-4-5',
  'gpt-4o',
  'gemini-2.5-pro',
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

function buildSystemPrompt(): string {
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

## Instructions

1. **Respond in the user's language.** If they write in Chinese, respond in Chinese. If English, respond in English.

2. **When the user describes a goal**, analyze it and either:
   - Ask clarifying questions if the goal is too vague
   - Generate a complete workflow if you have enough information

3. **When generating a workflow**, respond with BOTH:
   - A conversational explanation of what you've created
   - A JSON workflow block wrapped in \`\`\`workflow-json ... \`\`\` fences

4. **Choose the right step type for each task:**
   - Use "ai" for text generation, analysis, summarization, translation
   - Use "scraping" for fetching product reviews from URLs
   - Use "http" for calling external APIs
   - Use "script" for custom data processing or calculations
   - Use "transform" for format conversion (CSV/JSON), field mapping, filtering

5. **For AI steps**, write focused prompt templates. Include:
   - Clear instructions for the AI
   - Variable placeholders where needed (\`{{variable}}\` or \`{{step_N_output}}\`)
   - Output format instructions if specific formatting is needed
   - Keep prompts concise — avoid lengthy examples or verbose formatting guidelines that inflate the JSON size

6. **For non-AI steps**, provide complete executor_config with all required fields.

7. **When suggesting refinements**, offer 2-3 specific ideas the user might want.

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
  messages: ConversationMessage[]
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
  const systemPrompt = buildSystemPrompt();

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

  if (!parsed.workflow) {
    console.warn('[WorkflowAssistant] No workflow JSON extracted from AI response. Response length:', response.content.length,
      '| Has workflow-json fence:', /```workflow-json/.test(response.content),
      '| Has json fence:', /```json/.test(response.content));
  }

  return parsed;
}

export async function saveWorkflowAsRecipe(
  workflow: GeneratedWorkflow,
  userId: number,
  isTemplate: boolean = false
): Promise<{ recipeId: number }> {
  // Import database queries lazily to avoid circular dependencies
  const { queries } = await import('../models/database');

  // Create the recipe (positional args: name, description, createdBy, isTemplate)
  const result = queries.createRecipe(
    workflow.name,
    workflow.description || null,
    userId,
    isTemplate
  );

  const recipeId = result.lastInsertRowid;

  // Create steps
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];

    // Build input_config from requiredInputs that are referenced in this step's prompt
    const stepVars = workflow.requiredInputs.filter(input =>
      step.prompt_template.includes(`{{${input.name}}}`)
    );

    const inputConfig = stepVars.length > 0
      ? JSON.stringify({
          variables: stepVars.reduce((acc, v) => {
            acc[v.name] = { type: v.type, description: v.description };
            return acc;
          }, {} as Record<string, any>),
        })
      : null;

    queries.createStep(
      recipeId,
      i + 1,
      step.step_name,
      step.ai_model || null,
      step.prompt_template || null,
      inputConfig,
      step.output_format || 'text',
      null, // model_config
      step.step_type || 'ai',
      null, // api_config
      step.executor_config ? JSON.stringify(step.executor_config) : null
    );
  }

  return { recipeId };
}
