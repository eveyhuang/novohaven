import { RecipeStep, ExecutionStatus, StepExecutionStatus } from '../types';
export interface ExecutionResult {
    success: boolean;
    executionId: number;
    status: ExecutionStatus;
    currentStep: number;
    stepResults: StepExecutionResult[];
    error?: string;
}
export interface StepExecutionResult {
    stepId: number;
    stepOrder: number;
    stepName: string;
    status: StepExecutionStatus;
    output?: string;
    error?: string;
}
export declare function startExecution(recipeId: number, userId: number, inputData: Record<string, any>, customSteps?: RecipeStep[]): Promise<ExecutionResult>;
export declare function approveStep(executionId: number, stepExecutionId: number, userId: number): Promise<ExecutionResult>;
export declare function rejectStep(executionId: number, stepExecutionId: number): {
    success: boolean;
    error?: string;
};
export declare function retryStep(executionId: number, stepExecutionId: number, userId: number, modifiedPrompt?: string, modifiedInput?: Record<string, any>): Promise<ExecutionResult>;
export declare function getExecutionStatus(executionId: number): ExecutionResult | null;
//# sourceMappingURL=workflowEngine.d.ts.map