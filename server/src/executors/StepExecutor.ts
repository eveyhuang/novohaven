import { RecipeStep, StepExecution } from '../types';

/**
 * Context provided to each executor when executing a step.
 */
export interface StepExecutorContext {
  userId: number;
  executionId: number;
  stepExecution: StepExecution;
  userInputs: Record<string, any>;
  completedStepExecutions: StepExecution[];
}

/**
 * Result returned by an executor after executing a step.
 * The workflow engine handles status updates, pausing, etc.
 */
export interface StepExecutorResult {
  success: boolean;
  content: string;
  metadata?: Record<string, any>;
  error?: string;
  promptUsed?: string;
  modelUsed?: string;
}

/**
 * Schema for a single configuration field, used by the frontend
 * to dynamically render executor-specific config forms.
 */
export interface ExecutorConfigField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'json' | 'code';
  required?: boolean;
  defaultValue?: any;
  options?: { value: string; label: string }[];
  language?: string; // for 'code' type (e.g., 'python', 'javascript')
  helpText?: string;
}

/**
 * Schema describing the configuration form for an executor type.
 */
export interface ExecutorConfigSchema {
  fields: ExecutorConfigField[];
}

/**
 * Interface that all step executors must implement.
 */
export interface StepExecutor {
  /** Unique type identifier, matches step_type in recipe_steps */
  type: string;
  /** Human-readable name for display */
  displayName: string;
  /** Emoji icon for the step type */
  icon: string;
  /** Short description of what this executor does */
  description: string;

  /** Validate that a step's configuration is correct for this executor */
  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] };

  /** Execute the step and return the result */
  execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult>;

  /** Return the config schema for frontend form generation */
  getConfigSchema(): ExecutorConfigSchema;
}
