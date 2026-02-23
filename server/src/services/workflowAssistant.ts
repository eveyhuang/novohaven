import { callAIByModel, getAvailableModels } from './aiService';
import { getAllExecutors } from '../executors/registry';

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
  output_format: 'text' | 'json' | 'markdown' | 'image' | 'file';
  executor_config?: Record<string, any>;
  // Skill sourcing
  from_skill_id?: number;
  from_skill_blueprint?: string;
  from_skill_name?: string;
  // Backward compatibility
  from_template_id?: number;
  from_step_order?: number;
  override_fields?: string[];  // which fields the AI explicitly changed
}

export interface GeneratedInputSpec {
  name: string;
  type: string;
  description: string;
}

export interface GeneratedSkillBlueprint {
  key?: string;
  name: string;
  description?: string;
  tags?: string[];
  requiredInputs?: GeneratedInputSpec[];
  steps: GeneratedStep[];
}

export interface GeneratedWorkflow {
  name: string;
  description: string;
  steps: GeneratedStep[];
  requiredInputs: GeneratedInputSpec[];
  skill_blueprints?: GeneratedSkillBlueprint[];
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
  'gpt-5',
  'gpt-5.2',
  'gpt-4o',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
];

type AssistantApiMessage = { role: 'user' | 'assistant'; content: string };

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
  "step_type": "browser",
  "from_skill_id": 3,
  "from_step_order": 1,
  "override_fields": ["step_name"]
}
`;
  }

  // Gather available executors
  const executors = getAllExecutors().filter((e) => e.type !== 'scraping' && e.type !== 'manus');
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

2. **Check skills first, then decide pragmatic reuse.**
   - If an existing skill clearly covers a sub-task, reference that sub-task with \`from_skill_id\`.
   - If a skill is only partially relevant, combine skill-derived steps with newly generated steps.
   - Do NOT force the whole workflow into one reused skill when multiple explicit sub-tasks are requested.

3. **When the user describes a goal**, analyze it and either:
   - Ask clarifying questions if the goal is too vague
   - Generate a complete workflow if you have enough information

4. **When generating a workflow**, respond with BOTH:
   - A conversational explanation of what you've created
   - A JSON workflow block wrapped in \`\`\`workflow-json ... \`\`\` fences
   - For repeatable sub-tasks, include reusable \`skill_blueprints\` and reference them from workflow steps.
   - Do not collapse an end-to-end workflow into a single blueprint unless the user explicitly asks for a single reusable block.

5. **Choose the right step type for each task:**
   - Use "ai" for text generation, analysis, summarization, translation
   - Use "browser" for any website navigation, search, extraction, or review collection
   - Use "http" for calling external APIs
   - Use "script" for custom data processing or calculations
   - Use "transform" for format conversion (CSV/JSON), field mapping, filtering

6. **For AI steps**, write focused prompt templates. Include:
   - Clear instructions for the AI
   - Variable placeholders where needed (\`{{variable}}\` or \`{{step_N_output}}\`)
   - Output format instructions if specific formatting is needed
   - Keep prompts concise — avoid lengthy examples or verbose formatting guidelines that inflate the JSON size

7. **For non-AI steps**, provide complete executor_config with all required fields.
   - For script steps that consume uploaded files, assume inputs are inline content (string) or arrays of objects like \`[{name, content}]\`, not local filesystem paths.
   - Parse CSV/JSON from content (for example using Python \`io.StringIO\`) and gracefully handle both single-file and multi-file input.

8. **Browser steps are stateless across workflow steps (CRITICAL).**
   - A browser step does NOT inherit page/session state from a previous browser step.
   - If the user describes "search" and "extract" separately, you should still produce executable config:
     - Prefer a small sequence of focused browser steps (typically 2-6), each with a clear purpose.
     - Only combine into one giant browser step when the user explicitly asks for a minimal single-step flow.
     - If you keep multiple browser steps, each must include a valid startUrl or navigate action.
   - Never emit a browser extraction step that starts from about:blank.
   - Do NOT add script steps only to prepend URL protocol. Browser executor already normalizes domain inputs such as \`www.amazon.com\`.
   - Prefer URL variables directly from user inputs (for example \`{{source_url}}\`), instead of fragile URL placeholders like \`{{step_1_output.formatted_source_url}}\`.

9. **For browser extraction**, prefer output_format = "json" so extracted values are preserved.

10. **When the user asks for a CSV or downloadable artifact**, set output_format = "file" on the producing step.

11. **When suggesting refinements**, offer 2-3 specific ideas the user might want.

## Workflow JSON Format

\`\`\`workflow-json
{
  "name": "Workflow Name",
  "description": "Brief description",
  "skill_blueprints": [
    {
      "key": "wayfair_keyword_scan",
      "name": "Wayfair Keyword Scanner",
      "description": "Extract top category and recommendation keywords from Wayfair",
      "requiredInputs": [
        { "name": "category", "type": "text", "description": "Target category name" }
      ],
      "steps": [
        {
          "step_name": "Extract Wayfair signals",
          "step_type": "browser",
          "output_format": "json",
          "executor_config": {}
        }
      ]
    }
  ],
  "steps": [
    {
      "step_name": "Use Wayfair skill",
      "from_skill_blueprint": "wayfair_keyword_scan",
      "from_step_order": 1
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

function normalizeGeneratedStep(step: any, index: number): GeneratedStep {
  const outputFormat = step?.output_format;
  const normalizedOutput: GeneratedStep['output_format'] =
    outputFormat === 'json' || outputFormat === 'markdown' || outputFormat === 'image' || outputFormat === 'file'
      ? outputFormat
      : 'text';

  const cfg = toExecutorConfigObject(step?.executor_config);
  const cfgModel = typeof cfg.ai_model === 'string' ? cfg.ai_model.trim() : '';
  const cfgPrompt = typeof cfg.prompt_template === 'string' ? cfg.prompt_template.trim() : '';

  return {
    step_name: step?.step_name || `Step ${index + 1}`,
    step_type: step?.step_type === 'scraping' ? 'browser' : (step?.step_type || 'ai'),
    ai_model: step?.ai_model || cfgModel || '',
    prompt_template: step?.prompt_template || cfgPrompt || '',
    output_format: normalizedOutput,
    executor_config: step?.executor_config,
    from_skill_id: step?.from_skill_id || step?.from_template_id,
    from_skill_blueprint: step?.from_skill_blueprint,
    from_skill_name: step?.from_skill_name,
    from_template_id: step?.from_template_id || step?.from_skill_id,
    from_step_order: step?.from_step_order,
    override_fields: step?.override_fields,
  };
}

function getDefaultAssistantAiModel(): string {
  try {
    const available = getAvailableModels().filter((m) => !m.supportsImageGeneration);
    if (available.length > 0) return available[0].id;
  } catch {
    // Ignore and fall back.
  }
  return 'gpt-4o';
}

function isLikelyChineseStepName(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function defaultAiPromptForStep(stepName: string): string {
  const name = String(stepName || 'AI Step').trim();
  if (isLikelyChineseStepName(name)) {
    return `请完成步骤「${name}」。基于已提供输入与前序步骤输出，进行结构化分析并输出清晰结论。`;
  }
  return `Complete step "${name}" using provided inputs and prior step outputs. Return structured, actionable analysis.`;
}

function normalizeInputSpecs(inputs: any): GeneratedInputSpec[] {
  if (!Array.isArray(inputs)) return [];
  const isStepOutputReference = (name: string): boolean => /^step_\d+_output(?:\..+)?$/i.test(String(name || '').trim());
  return inputs
    .map((input: any) => ({
      name: String(input?.name || '').trim(),
      type: String(input?.type || 'text').trim() || 'text',
      description: String(input?.description || '').trim(),
    }))
    .filter((input: GeneratedInputSpec) => input.name.length > 0 && !isStepOutputReference(input.name));
}

function normalizeSkillBlueprints(raw: any): GeneratedSkillBlueprint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any, idx: number) => ({
      key: item?.key ? String(item.key) : undefined,
      name: String(item?.name || '').trim() || `Skill Blueprint ${idx + 1}`,
      description: item?.description ? String(item.description) : '',
      tags: Array.isArray(item?.tags) ? item.tags.map((t: any) => String(t)) : [],
      requiredInputs: normalizeInputSpecs(item?.requiredInputs),
      steps: Array.isArray(item?.steps)
        ? item.steps.map((step: any, stepIdx: number) => normalizeGeneratedStep(step, stepIdx))
        : [],
    }))
    .filter((bp: GeneratedSkillBlueprint) => bp.steps.length > 0);
}

function hasSkillReference(step: GeneratedStep): boolean {
  return Boolean(
    step.from_skill_id ||
    step.from_skill_blueprint ||
    step.from_skill_name ||
    step.from_template_id
  );
}

function toExecutorConfigObject(config: any): Record<string, any> {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof config === 'object' && !Array.isArray(config)) {
    return { ...config };
  }
  return {};
}

function inferBrowserFallbackStartUrl(requiredInputs: GeneratedInputSpec[]): string | undefined {
  const preferredKeys = [
    'source_platform_url',
    'source_url',
    'target_url',
    'url',
    'website',
    'site_url',
    'start_url',
  ];
  const inputMap = new Map(requiredInputs.map((item) => [item.name.toLowerCase(), item.name]));

  for (const key of preferredKeys) {
    const exact = inputMap.get(key);
    if (exact) return `{{${exact}}}`;
  }

  const fuzzy = requiredInputs.find((item) => {
    const name = item.name.toLowerCase();
    return name.includes('url') || name.includes('website') || name.includes('site');
  });
  if (fuzzy) return `{{${fuzzy.name}}}`;

  return undefined;
}

function mergeConsecutiveBrowserSteps(steps: GeneratedStep[]): GeneratedStep[] {
  const merged: GeneratedStep[] = [];
  let i = 0;

  while (i < steps.length) {
    const current = steps[i];
    if (current.step_type !== 'browser' || hasSkillReference(current)) {
      merged.push(current);
      i += 1;
      continue;
    }

    const chain: GeneratedStep[] = [current];
    let j = i + 1;
    while (j < steps.length) {
      const candidate = steps[j];
      if (candidate.step_type !== 'browser' || hasSkillReference(candidate)) break;
      chain.push(candidate);
      j += 1;
    }

    if (chain.length === 1) {
      merged.push(current);
      i = j;
      continue;
    }

    const mergedConfig: Record<string, any> = toExecutorConfigObject(chain[0].executor_config);
    const combinedActions: any[] = [];
    const combinedExtractors: any[] = [];

    for (const step of chain) {
      const cfg = toExecutorConfigObject(step.executor_config);
      if (!mergedConfig.startUrl && typeof cfg.startUrl === 'string' && cfg.startUrl.trim()) {
        mergedConfig.startUrl = cfg.startUrl.trim();
      }
      if (mergedConfig.defaultWaitMs === undefined && cfg.defaultWaitMs !== undefined) {
        mergedConfig.defaultWaitMs = cfg.defaultWaitMs;
      }
      if (mergedConfig.defaultTimeoutMs === undefined && cfg.defaultTimeoutMs !== undefined) {
        mergedConfig.defaultTimeoutMs = cfg.defaultTimeoutMs;
      }
      if (cfg.maxItems !== undefined) {
        mergedConfig.maxItems = cfg.maxItems;
      }
      if (Array.isArray(cfg.actions)) combinedActions.push(...cfg.actions);
      if (Array.isArray(cfg.extractors)) combinedExtractors.push(...cfg.extractors);
    }

    mergedConfig.actions = combinedActions;
    mergedConfig.extractors = combinedExtractors;

    merged.push({
      ...chain[0],
      executor_config: mergedConfig,
      output_format: chain[chain.length - 1].output_format || chain[0].output_format,
      step_name: chain[0].step_name || 'Browser Automation',
    });

    i = j;
  }

  return merged;
}

function applyBrowserExecutionSafety(
  steps: GeneratedStep[],
  requiredInputs: GeneratedInputSpec[]
): GeneratedStep[] {
  const normalized = steps.map((step) => ({ ...step }));
  const fallbackStartUrl = inferBrowserFallbackStartUrl(requiredInputs);
  let lastKnownUrl: string | undefined;
  const stepFieldPattern = /\{\{\s*step_\d+_output\.[^}]+\s*\}\}/g;

  for (const step of normalized) {
    if (step.step_type !== 'browser' || hasSkillReference(step)) continue;

    const cfg = toExecutorConfigObject(step.executor_config);
    const extractors = Array.isArray(cfg.extractors) ? cfg.extractors : [];

    if (typeof cfg.startUrl === 'string' && fallbackStartUrl) {
      cfg.startUrl = cfg.startUrl.replace(stepFieldPattern, fallbackStartUrl);
    }
    if (fallbackStartUrl && Array.isArray(cfg.actions)) {
      cfg.actions = cfg.actions.map((action: any) => {
        if (action?.type === 'navigate' && typeof action?.url === 'string') {
          return {
            ...action,
            url: action.url.replace(stepFieldPattern, fallbackStartUrl),
          };
        }
        return action;
      });
    }

    const actions = Array.isArray(cfg.actions) ? cfg.actions : [];
    const hasNavigateAction = actions.some((action: any) =>
      action?.type === 'navigate' && typeof action?.url === 'string' && action.url.trim().length > 0
    );
    const startUrl = typeof cfg.startUrl === 'string' ? cfg.startUrl.trim() : '';

    if (!startUrl && !hasNavigateAction) {
      const injected = lastKnownUrl || fallbackStartUrl;
      if (injected) {
        cfg.startUrl = injected;
      }
    }

    // Browser extraction is more useful as JSON so the chat can show actual extracted values.
    const hasExtraction = actions.some((action: any) => action?.type === 'extract') || extractors.length > 0;
    if (hasExtraction && step.output_format === 'text') {
      step.output_format = 'json';
    }

    step.executor_config = cfg;

    if (typeof cfg.startUrl === 'string' && cfg.startUrl.trim()) {
      lastKnownUrl = cfg.startUrl.trim();
      continue;
    }
    const firstNavigate = actions.find((action: any) =>
      action?.type === 'navigate' && typeof action?.url === 'string' && action.url.trim().length > 0
    );
    if (firstNavigate) {
      lastKnownUrl = firstNavigate.url.trim();
    }
  }

  return normalized;
}

function applyFileOutputHints(steps: GeneratedStep[]): GeneratedStep[] {
  const csvPattern = /\bcsv\b|\.csv|comma[- ]separated/i;
  return steps.map((step) => {
    if (step.output_format === 'file') return step;
    const promptText = step.prompt_template || '';
    const configText = JSON.stringify(step.executor_config || {});
    const mentionsCsv = csvPattern.test(promptText) || csvPattern.test(configText);
    if (!mentionsCsv) return step;
    if (step.output_format === 'text' || step.output_format === 'markdown') {
      return { ...step, output_format: 'file' };
    }
    return step;
  });
}

function applyBlueprintReferenceHydration(workflow: GeneratedWorkflow): GeneratedStep[] {
  const blueprints = workflow.skill_blueprints || [];
  if (!blueprints.length) return workflow.steps || [];

  const byAlias = new Map<string, GeneratedSkillBlueprint>();
  for (const bp of blueprints) {
    const key = String(bp?.key || '').trim().toLowerCase();
    const name = String(bp?.name || '').trim().toLowerCase();
    if (key) byAlias.set(key, bp);
    if (name) byAlias.set(name, bp);
  }

  return (workflow.steps || []).map((step) => {
    const alias = String(step.from_skill_blueprint || step.from_skill_name || '').trim().toLowerCase();
    if (!alias) return step;
    const bp = byAlias.get(alias);
    if (!bp || !Array.isArray(bp.steps) || bp.steps.length === 0) return step;

    const sourceOrder = Number(step.from_step_order || 1);
    const sourceStep = bp.steps[sourceOrder - 1];
    if (!sourceStep) return step;

    const hydrated: GeneratedStep = { ...step };
    if (!String(hydrated.ai_model || '').trim() && String(sourceStep.ai_model || '').trim()) {
      hydrated.ai_model = sourceStep.ai_model;
    }
    if (!String(hydrated.prompt_template || '').trim() && String(sourceStep.prompt_template || '').trim()) {
      hydrated.prompt_template = sourceStep.prompt_template;
    }
    if ((!hydrated.executor_config || Object.keys(hydrated.executor_config).length === 0) && sourceStep.executor_config) {
      hydrated.executor_config = { ...sourceStep.executor_config };
    }
    return hydrated;
  });
}

function applyAiStepDefaults(steps: GeneratedStep[]): GeneratedStep[] {
  const defaultModel = getDefaultAssistantAiModel();
  return steps.map((step) => {
    if (step.step_type !== 'ai') return step;
    const cfg = toExecutorConfigObject(step.executor_config);
    const cfgModel = String(cfg.ai_model || '').trim();
    const cfgPrompt = String(cfg.prompt_template || '').trim();
    const fallbackPrompt = defaultAiPromptForStep(step.step_name || 'AI Step');
    const existingPrompt = String(step.prompt_template || '').trim();

    const aiModel = String(step.ai_model || '').trim() || cfgModel || defaultModel;
    const promptTemplate = (
      !existingPrompt
      || existingPrompt === fallbackPrompt
    )
      ? (cfgPrompt || existingPrompt || fallbackPrompt)
      : existingPrompt;

    return {
      ...step,
      ai_model: aiModel,
      prompt_template: promptTemplate,
    };
  });
}

function normalizeGeneratedWorkflowStructure(workflow: GeneratedWorkflow): GeneratedWorkflow {
  // Preserve explicit multi-step browser decompositions from the model.
  // Over-merging can hide intent and make iterative fixing harder in AI Workflow Builder.
  workflow.steps = applyBlueprintReferenceHydration(workflow);
  workflow.steps = applyAiStepDefaults(workflow.steps || []);
  workflow.steps = applyBrowserExecutionSafety(workflow.steps || [], workflow.requiredInputs || []);
  workflow.steps = applyFileOutputHints(workflow.steps || []);
  return workflow;
}


function tryParseWorkflow(jsonStr: string): GeneratedWorkflow | null {
  try {
    const raw = JSON.parse(jsonStr) as any;
    if (raw.name && raw.steps && Array.isArray(raw.steps)) {
      const workflow = raw as GeneratedWorkflow;
      workflow.steps = raw.steps.map((step: any, i: number) => normalizeGeneratedStep(step, i));
      workflow.requiredInputs = normalizeInputSpecs(raw.requiredInputs);
      workflow.skill_blueprints = normalizeSkillBlueprints(raw.skill_blueprints || raw.skills);
      return normalizeGeneratedWorkflowStructure(workflow);
    }
  } catch (e) {
    // JSON parse failed
  }
  return null;
}

function tryParseWorkflowFromEmbeddedJson(content: string): GeneratedWorkflow | null {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === '\\') {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const workflow = tryParseWorkflow(candidates[i]);
    if (workflow) return workflow;
  }

  return null;
}

function hasSkillRequest(parsed: AssistantResponse): boolean {
  return Array.isArray(parsed.skillRequest) && parsed.skillRequest.length > 0;
}

function isLikelyChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function buildEmergencyWorkflowMessages(messages: ConversationMessage[]): AssistantApiMessage[] {
  const userHistory = messages
    .filter((msg) => msg.role === 'user')
    .map((msg, idx) => `User request ${idx + 1}:\n${msg.content}`)
    .join('\n\n');

  return [{
    role: 'user',
    content: `Convert these requirements into a complete workflow JSON object:\n\n${userHistory}`,
  }];
}

async function forceGenerateWorkflowJson(
  messages: ConversationMessage[],
  modelId: string
): Promise<AssistantResponse | null> {
  const latestUserMessage = [...messages].reverse().find((msg) => msg.role === 'user')?.content || '';
  const chinese = isLikelyChinese(latestUserMessage);

  const emergencySystemPrompt = `You are a strict workflow JSON compiler.
Return ONLY a valid JSON object. No markdown fences. No explanation text.

Required top-level keys:
- name (string)
- description (string)
- steps (array)
- requiredInputs (array)

Each step must include:
- step_name (string)
- step_type (one of: ai, browser, transform, script, http)
- ai_model (string, can be empty for non-ai)
- prompt_template (string, can be empty for non-ai)
- output_format (one of: text, json, markdown, image, file)
- executor_config (object, required for non-ai)

Rules:
- Browser steps are stateless; each browser step must have startUrl or a navigate action.
- Do not add script steps only for URL protocol formatting.
- For browser extraction, prefer output_format "json".
- If the user requests CSV/downloadable output, prefer output_format "file" on the final producing step.
- For script runtime, use only "python3" or "node" (never "nodejs").
- Prefer URL variables directly from user inputs (for example {{source_url}}).
`;

  const forcedResponse = await callAIByModel(modelId, '', {
    temperature: 0.1,
    maxTokens: 12000,
    systemMessage: emergencySystemPrompt,
    messages: buildEmergencyWorkflowMessages(messages),
  });

  if (!forcedResponse.success) return null;

  const directWorkflow = tryParseWorkflow(forcedResponse.content);
  if (directWorkflow) {
    return {
      message: chinese
        ? '已基于你的描述生成可编辑工作流草稿。'
        : 'I generated an editable workflow draft from your requirements.',
      workflow: directWorkflow,
    };
  }

  const parsed = parseAssistantResponse(forcedResponse.content);
  if (parsed.workflow) {
    return {
      ...parsed,
      message: parsed.message?.trim() || (chinese
        ? '已基于你的描述生成可编辑工作流草稿。'
        : 'I generated an editable workflow draft from your requirements.'),
    };
  }

  return null;
}

function addMissingWorkflowHint(parsed: AssistantResponse, messages: ConversationMessage[]): AssistantResponse {
  const latestUserMessage = [...messages].reverse().find((msg) => msg.role === 'user')?.content || '';
  const chinese = isLikelyChinese(`${latestUserMessage}\n${parsed.message}`);

  const hint = chinese
    ? '未能从本次 AI 回复中提取有效的工作流 JSON，因此右侧预览暂时为空。请让我“直接输出 workflow-json 代码块（不要解释）”后重试。'
    : 'I could not extract a valid workflow JSON from this reply, so the workflow preview is still empty. Please ask me to "output only a workflow-json code block" and retry.';

  const retrySuggestion = chinese
    ? '请直接输出 workflow-json 代码块（不要解释）'
    : 'Output only a workflow-json code block (no extra text).';

  const mergedMessage = parsed.message?.trim()
    ? `${parsed.message.trim()}\n\n${hint}`
    : hint;

  return {
    ...parsed,
    message: mergedMessage,
    suggestions: parsed.suggestions && parsed.suggestions.length > 0
      ? parsed.suggestions
      : [retrySuggestion],
  };
}

async function resolveSkillRequestIfNeeded(
  parsed: AssistantResponse,
  apiMessages: AssistantApiMessage[],
  assistantContent: string,
  modelId: string,
  systemPrompt: string
): Promise<AssistantResponse> {
  if (!hasSkillRequest(parsed)) return parsed;

  const { getDatabase } = await import('../models/database');
  const db = getDatabase();
  const skillDetails: string[] = [];

  for (const skillId of parsed.skillRequest || []) {
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

  if (skillDetails.length === 0) return parsed;

  const followUpMessages: AssistantApiMessage[] = [
    ...apiMessages,
    { role: 'assistant', content: assistantContent },
    {
      role: 'user',
      content: `Here are the full skill details you requested:\n\n${skillDetails.join('\n\n')}\n\nReference these steps using from_skill_id and from_step_order rather than regenerating the config. If you design new reusable blocks, include them in skill_blueprints and reference them with from_skill_blueprint. Only include fields in override_fields if you explicitly changed them. Now generate the workflow-json.`,
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

  // Strategy 3: Scan for any embedded JSON object and parse the valid workflow object
  if (!result.workflow) {
    const workflow = tryParseWorkflowFromEmbeddedJson(content);
    if (workflow) {
      result.workflow = workflow;
    }
  }

  // Strategy 4: Fall back to raw JSON with "name" + "steps" keys
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
  const apiMessages: AssistantApiMessage[] = messages.map((msg, i) => {
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

  let parsed = parseAssistantResponse(response.content);
  const initialHadSkillRequest = hasSkillRequest(parsed);
  parsed = await resolveSkillRequestIfNeeded(parsed, apiMessages, response.content, modelId, systemPrompt);

  if (!parsed.workflow && !hasSkillRequest(parsed) && !initialHadSkillRequest) {
    console.warn('[WorkflowAssistant] No workflow JSON extracted from AI response. Response length:', response.content.length,
      '| Has workflow-json fence:', /```workflow-json/.test(response.content),
      '| Has json fence:', /```json/.test(response.content));

    // One repair pass: ask the model to restate as parseable workflow-json or skill-request.
    const repairPrompt = `Your previous response did not include parseable workflow JSON.
Return one of these formats only:
1) \`\`\`workflow-json ... \`\`\` with valid JSON, plus a short natural-language summary above it.
2) \`\`\`skill-request ... \`\`\` with a JSON array of skill IDs if you need skill details first.

Do NOT say "wait a moment" or "I will generate later". Produce the final result now.`;

    const repairMessages: AssistantApiMessage[] = [
      ...apiMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: repairPrompt },
    ];

    const repairResponse = await callAIByModel(modelId, '', {
      temperature: 0.2,
      maxTokens: 12000,
      systemMessage: systemPrompt,
      messages: repairMessages,
    });

    if (repairResponse.success) {
      let repaired = parseAssistantResponse(repairResponse.content);
      repaired = await resolveSkillRequestIfNeeded(repaired, repairMessages, repairResponse.content, modelId, systemPrompt);
      if (repaired.workflow || hasSkillRequest(repaired)) {
        return repaired;
      }
      parsed = repaired;
      console.warn('[WorkflowAssistant] Workflow repair pass also returned no parseable workflow JSON.');
    } else {
      console.warn('[WorkflowAssistant] Workflow repair pass failed:', repairResponse.error || 'unknown error');
    }

    const emergency = await forceGenerateWorkflowJson(messages, modelId);
    if (emergency?.workflow) {
      console.warn('[WorkflowAssistant] Recovered workflow JSON via emergency compiler pass.');
      return emergency;
    }
  }

  if (!parsed.workflow && !hasSkillRequest(parsed)) {
    return addMissingWorkflowHint(parsed, messages);
  }

  return parsed;
}

export async function saveWorkflowGraph(
  workflow: GeneratedWorkflow,
  userId: number,
  asSkill: boolean = false
): Promise<{ entityType: 'skill' | 'workflow'; skillId?: number; workflowId?: number; createdSkillIds?: number[] }> {
  if (asSkill) {
    const hasUnsupportedSkillStepType = (workflow.steps || []).some(
      (step) => String(step?.step_type || 'ai').trim().toLowerCase() === 'manus'
    );
    if (hasUnsupportedSkillStepType) {
      throw new Error('Step type "manus" is no longer supported for skills');
    }
  }

  const { getDatabase } = await import('../models/database');
  const db = getDatabase();

  const parentType: 'skill' | 'workflow' = asSkill ? 'skill' : 'workflow';
  const parentTable = asSkill ? 'skills' : 'workflows';
  const parentInsert = db.prepare(
    `INSERT INTO ${parentTable} (name, description, created_by, tags) VALUES (?, ?, ?, ?)`
  );
  const getSkillStep = db.prepare(
    "SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' AND step_order = ?"
  );
  const insertStep = db.prepare(`
    INSERT INTO skill_steps (
      parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, executor_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const createdSkillIds: number[] = [];
  const blueprintSkillIds = new Map<string, number>();

  const registerBlueprintAlias = (key: string | undefined, name: string | undefined, skillId: number) => {
    if (key && key.trim()) {
      blueprintSkillIds.set(key.trim(), skillId);
      blueprintSkillIds.set(key.trim().toLowerCase(), skillId);
    }
    if (name && name.trim()) {
      blueprintSkillIds.set(name.trim(), skillId);
      blueprintSkillIds.set(name.trim().toLowerCase(), skillId);
    }
  };

  const inferInputConfig = (
    prompt: string,
    executorConfig: string,
    stepType: string,
    candidates: GeneratedInputSpec[]
  ): string => {
    const stepVars = candidates.filter((input) => {
      if (prompt.includes(`{{${input.name}}}`)) return true;
      if (executorConfig.includes(`{{${input.name}}}`)) return true;
      if (stepType === 'browser' && input.type === 'url_list') return true;
      return false;
    });

    if (stepVars.length === 0) return '{}';
    return JSON.stringify({
      variables: stepVars.reduce((acc, v) => {
        acc[v.name] = { type: v.type, description: v.description };
        return acc;
      }, {} as Record<string, any>),
    });
  };

  const persistSteps = (
    parentId: number,
    targetType: 'skill' | 'workflow',
    steps: GeneratedStep[],
    inputCandidates: GeneratedInputSpec[]
  ) => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      let mergedPrompt = step.prompt_template || '';
      let mergedAiModel = step.ai_model || null;
      let mergedOutputFormat = step.output_format || 'text';
      let mergedStepType = step.step_type || 'ai';
      let mergedExecutorConfig: string = step.executor_config ? JSON.stringify(step.executor_config) : '{}';
      let mergedModelConfig: string = '{}';
      let mergedInputConfig: string = '{}';

      const sourceFromBlueprint = step.from_skill_blueprint
        ? (blueprintSkillIds.get(step.from_skill_blueprint)
          || blueprintSkillIds.get(step.from_skill_blueprint.toLowerCase()))
        : undefined;
      const sourceFromName = step.from_skill_name
        ? (blueprintSkillIds.get(step.from_skill_name)
          || blueprintSkillIds.get(step.from_skill_name.toLowerCase()))
        : undefined;

      const sourceSkillId = step.from_skill_id || step.from_template_id || sourceFromBlueprint || sourceFromName;
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

      if (mergedStepType === 'ai') {
        const execConfigObj = toExecutorConfigObject(mergedExecutorConfig);
        const cfgAiModel = String(execConfigObj.ai_model || '').trim();
        const cfgPrompt = String(execConfigObj.prompt_template || '').trim();
        const fallbackPrompt = defaultAiPromptForStep(step.step_name || 'AI Step');
        const normalizedMergedPrompt = String(mergedPrompt || '').trim();

        if (!String(mergedAiModel || '').trim() && cfgAiModel) {
          mergedAiModel = cfgAiModel;
        }
        if ((!normalizedMergedPrompt || normalizedMergedPrompt === fallbackPrompt) && cfgPrompt) {
          mergedPrompt = cfgPrompt;
        }

        let modelConfigObj: Record<string, any> = {};
        try {
          const parsed = JSON.parse(mergedModelConfig || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            modelConfigObj = parsed;
          }
        } catch {
          modelConfigObj = {};
        }

        const modelConfigKeys: Array<keyof Record<string, any>> = ['temperature', 'maxTokens', 'topP', 'systemMessage'];
        for (const key of modelConfigKeys) {
          if (modelConfigObj[key] === undefined && execConfigObj[key] !== undefined) {
            modelConfigObj[key] = execConfigObj[key];
          }
        }
        mergedModelConfig = JSON.stringify(modelConfigObj);
      }

      if (!mergedInputConfig || mergedInputConfig === '{}' || mergedInputConfig === '') {
        mergedInputConfig = inferInputConfig(mergedPrompt, mergedExecutorConfig, mergedStepType, inputCandidates);
      }

      insertStep.run(
        parentId,
        targetType,
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
  };

  const result = db.transaction(() => {
    if (!asSkill && workflow.skill_blueprints && workflow.skill_blueprints.length > 0) {
      for (let i = 0; i < workflow.skill_blueprints.length; i++) {
        const blueprint = workflow.skill_blueprints[i];
        if (!blueprint.steps || blueprint.steps.length === 0) continue;

        const skillInsert = db.prepare(
          'INSERT INTO skills (name, description, created_by, tags) VALUES (?, ?, ?, ?)'
        );
        const inserted = skillInsert.run(
          blueprint.name || `Generated Skill ${i + 1}`,
          blueprint.description || null,
          userId,
          JSON.stringify(blueprint.tags || [])
        );
        const createdSkillId = Number(inserted.lastInsertRowid);
        createdSkillIds.push(createdSkillId);
        registerBlueprintAlias(blueprint.key, blueprint.name, createdSkillId);
        persistSteps(createdSkillId, 'skill', blueprint.steps, blueprint.requiredInputs || workflow.requiredInputs || []);
      }
    }

    const parentResult = parentInsert.run(
      workflow.name,
      workflow.description || null,
      userId,
      JSON.stringify([])
    );
    const parentId = Number(parentResult.lastInsertRowid);
    persistSteps(parentId, parentType, workflow.steps, workflow.requiredInputs || []);

    if (asSkill) {
      return { entityType: 'skill' as const, skillId: parentId, createdSkillIds };
    }
    return { entityType: 'workflow' as const, workflowId: parentId, createdSkillIds };
  })();

  return result;
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
