import { StepExecutor } from './StepExecutor';
import { AIExecutor } from './AIExecutor';
import { ScrapingExecutor } from './ScrapingExecutor';
import { ScriptExecutor } from './ScriptExecutor';
import { HttpExecutor } from './HttpExecutor';
import { TransformExecutor } from './TransformExecutor';

const executors = new Map<string, StepExecutor>();

export function registerExecutor(executor: StepExecutor): void {
  executors.set(executor.type, executor);
}

export function getExecutor(stepType: string): StepExecutor | undefined {
  return executors.get(stepType);
}

export function getAllExecutors(): StepExecutor[] {
  return Array.from(executors.values());
}

// Register built-in executors
registerExecutor(new AIExecutor());
registerExecutor(new ScrapingExecutor());
registerExecutor(new ScriptExecutor());
registerExecutor(new HttpExecutor());
registerExecutor(new TransformExecutor());
