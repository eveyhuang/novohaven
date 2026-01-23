import { queries } from '../models/database';
import { CompanyStandard, StepExecution, ImageData } from '../types';

// Regex to match variables in format {{variable_name}}
const VARIABLE_REGEX = /\{\{([^}]+)\}\}/g;

// Variable types
export interface ParsedVariable {
  name: string;
  fullMatch: string;
  type: 'user_input' | 'previous_step' | 'company_standard' | 'unknown';
  stepNumber?: number;
  standardName?: string;
}

// Extract all variables from a prompt template
export function extractVariables(promptTemplate: string): ParsedVariable[] {
  const variables: ParsedVariable[] = [];
  let match;

  while ((match = VARIABLE_REGEX.exec(promptTemplate)) !== null) {
    const varName = match[1].trim();
    const fullMatch = match[0];

    const parsedVar: ParsedVariable = {
      name: varName,
      fullMatch,
      type: 'unknown',
    };

    // Check if it's a step output reference (e.g., step_1_output, step_2_output)
    const stepMatch = varName.match(/^step_(\d+)_output$/);
    if (stepMatch) {
      parsedVar.type = 'previous_step';
      parsedVar.stepNumber = parseInt(stepMatch[1], 10);
    }
    // Check if it's a company standard reference (common names)
    else if (isCompanyStandardVariable(varName)) {
      parsedVar.type = 'company_standard';
      parsedVar.standardName = varName;
    }
    // Otherwise, it's a user input variable
    else {
      parsedVar.type = 'user_input';
    }

    variables.push(parsedVar);
  }

  return variables;
}

// Common company standard variable names
const COMPANY_STANDARD_VARIABLES = [
  'brand_voice',
  'amazon_requirements',
  'social_media_guidelines',
  'image_style_guidelines',
  'platform_requirements',
  'tone_guidelines',
  'content_guidelines',
];

function isCompanyStandardVariable(varName: string): boolean {
  return COMPANY_STANDARD_VARIABLES.some(
    standard => varName.toLowerCase().includes(standard.toLowerCase().replace(/_/g, ''))
      || varName.toLowerCase() === standard.toLowerCase()
      || varName.toLowerCase().replace(/_/g, '') === standard.toLowerCase().replace(/_/g, '')
  );
}

// Get user input variables (those that need to be provided by the user)
export function getUserInputVariables(promptTemplate: string): string[] {
  const variables = extractVariables(promptTemplate);
  return variables
    .filter(v => v.type === 'user_input')
    .map(v => v.name);
}

// Resolve company standard variables
function resolveCompanyStandard(varName: string, userId: number): string {
  // Map variable names to standard types and names
  const standardMappings: Record<string, { type: string; keywords: string[] }> = {
    brand_voice: { type: 'voice', keywords: ['voice', 'brand', 'tone'] },
    amazon_requirements: { type: 'platform', keywords: ['amazon'] },
    social_media_guidelines: { type: 'platform', keywords: ['social', 'media', 'instagram', 'tiktok', 'facebook'] },
    image_style_guidelines: { type: 'image', keywords: ['image', 'photo', 'style'] },
    platform_requirements: { type: 'platform', keywords: ['platform'] },
  };

  // Find matching standard
  let matchedType: string | null = null;
  let matchedKeywords: string[] = [];

  for (const [key, mapping] of Object.entries(standardMappings)) {
    if (varName.toLowerCase().includes(key.replace(/_/g, '')) ||
        varName.toLowerCase().replace(/_/g, '') === key.replace(/_/g, '')) {
      matchedType = mapping.type;
      matchedKeywords = mapping.keywords;
      break;
    }
  }

  if (!matchedType) {
    return `[Company standard "${varName}" not found]`;
  }

  // Get standards of the matched type
  const standards = queries.getStandardsByType(userId, matchedType) as CompanyStandard[];

  if (standards.length === 0) {
    return `[No ${matchedType} standards configured]`;
  }

  // Find the best matching standard by keywords in name
  let bestMatch = standards[0];
  for (const standard of standards) {
    for (const keyword of matchedKeywords) {
      if (standard.name.toLowerCase().includes(keyword)) {
        bestMatch = standard;
        break;
      }
    }
  }

  // Parse and format the standard content
  try {
    const content = JSON.parse(bestMatch.content);
    return formatStandardContent(content, matchedType);
  } catch {
    return bestMatch.content;
  }
}

// Format standard content for injection into prompts
function formatStandardContent(content: any, type: string): string {
  const lines: string[] = [];

  switch (type) {
    case 'voice':
      if (content.tone) lines.push(`Tone: ${content.tone}`);
      if (content.style) lines.push(`Style: ${content.style}`);
      if (content.guidelines && content.guidelines.length > 0) {
        lines.push('Guidelines:');
        content.guidelines.forEach((g: string) => lines.push(`- ${g}`));
      }
      break;

    case 'platform':
      if (content.platform) lines.push(`Platform: ${content.platform}`);
      if (content.requirements && content.requirements.length > 0) {
        lines.push('Requirements:');
        content.requirements.forEach((r: string) => lines.push(`- ${r}`));
      }
      if (content.characterLimits) {
        lines.push('Character Limits:');
        Object.entries(content.characterLimits).forEach(([key, value]) => {
          lines.push(`- ${key}: ${value}`);
        });
      }
      break;

    case 'image':
      if (content.style) lines.push(`Style: ${content.style}`);
      if (content.dimensions) lines.push(`Dimensions: ${content.dimensions}`);
      if (content.guidelines && content.guidelines.length > 0) {
        lines.push('Guidelines:');
        content.guidelines.forEach((g: string) => lines.push(`- ${g}`));
      }
      break;
  }

  return lines.join('\n');
}

// Resolve previous step output
function resolvePreviousStepOutput(
  stepNumber: number,
  stepExecutions: StepExecution[]
): string {
  const stepExecution = stepExecutions.find(se => se.step_order === stepNumber);

  if (!stepExecution) {
    return `[Output from step ${stepNumber} not found]`;
  }

  if (stepExecution.status !== 'completed') {
    return `[Step ${stepNumber} has not completed yet]`;
  }

  if (!stepExecution.output_data) {
    return `[Step ${stepNumber} produced no output]`;
  }

  // Try to parse as JSON and extract content
  try {
    const outputData = JSON.parse(stepExecution.output_data);
    return outputData.content || outputData.output || stepExecution.output_data;
  } catch {
    return stepExecution.output_data;
  }
}

// Main function to compile a prompt with all variables resolved
export interface CompilePromptContext {
  userId: number;
  userInputs: Record<string, any>;
  stepExecutions: StepExecution[];
}

export interface CompilePromptResult {
  compiledPrompt: string;
  unresolvedVariables: string[];
  images: ImageData[];
}

// Check if a value is base64 image data
function isBase64Image(value: any): boolean {
  if (typeof value !== 'string') return false;
  return value.startsWith('data:image/') ||
         (value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value.substring(0, 100)));
}

// Extract media type from base64 data URL
function extractMediaType(base64: string): ImageData['mediaType'] {
  if (base64.startsWith('data:image/jpeg')) return 'image/jpeg';
  if (base64.startsWith('data:image/png')) return 'image/png';
  if (base64.startsWith('data:image/gif')) return 'image/gif';
  if (base64.startsWith('data:image/webp')) return 'image/webp';
  // Default to jpeg if can't determine
  return 'image/jpeg';
}

export function compilePrompt(
  promptTemplate: string,
  context: CompilePromptContext
): CompilePromptResult {
  const variables = extractVariables(promptTemplate);
  let compiledPrompt = promptTemplate;
  const unresolvedVariables: string[] = [];
  const images: ImageData[] = [];

  for (const variable of variables) {
    let resolvedValue: string;

    switch (variable.type) {
      case 'user_input':
        const inputValue = context.userInputs[variable.name];

        // Check if this is image data
        if (isBase64Image(inputValue)) {
          // Extract the image and add to images array
          images.push({
            base64: inputValue,
            mediaType: extractMediaType(inputValue),
          });
          // Replace the variable with a reference to the attached image
          resolvedValue = `[See attached image: ${variable.name}]`;
        } else if (inputValue === undefined || inputValue === '') {
          unresolvedVariables.push(variable.name);
          resolvedValue = `[User input "${variable.name}" required]`;
        } else {
          resolvedValue = String(inputValue);
        }
        break;

      case 'previous_step':
        if (variable.stepNumber !== undefined) {
          resolvedValue = resolvePreviousStepOutput(
            variable.stepNumber,
            context.stepExecutions
          );
        } else {
          unresolvedVariables.push(variable.name);
          resolvedValue = `[Invalid step reference: ${variable.name}]`;
        }
        break;

      case 'company_standard':
        resolvedValue = resolveCompanyStandard(variable.name, context.userId);
        break;

      default:
        unresolvedVariables.push(variable.name);
        resolvedValue = `[Unknown variable: ${variable.name}]`;
    }

    compiledPrompt = compiledPrompt.replace(variable.fullMatch, resolvedValue);
  }

  return { compiledPrompt, unresolvedVariables, images };
}

// Get all required user inputs for a recipe
export function getRequiredInputsForRecipe(recipeId: number): string[] {
  const steps = queries.getStepsByRecipeId(recipeId) as any[];
  const allInputs = new Set<string>();

  for (const step of steps) {
    const userInputs = getUserInputVariables(step.prompt_template);
    userInputs.forEach(input => allInputs.add(input));
  }

  return Array.from(allInputs);
}

// Validate that all required inputs are provided
export function validateInputs(
  recipeId: number,
  providedInputs: Record<string, string>
): { valid: boolean; missing: string[] } {
  const required = getRequiredInputsForRecipe(recipeId);
  const missing = required.filter(
    input => !providedInputs[input] || providedInputs[input].trim() === ''
  );

  return {
    valid: missing.length === 0,
    missing,
  };
}
