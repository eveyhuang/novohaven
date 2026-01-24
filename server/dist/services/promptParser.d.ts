import { StepExecution, ImageData } from '../types';
export interface ParsedVariable {
    name: string;
    fullMatch: string;
    type: 'user_input' | 'previous_step' | 'company_standard' | 'unknown';
    stepNumber?: number;
    standardName?: string;
}
export declare function extractVariables(promptTemplate: string): ParsedVariable[];
export declare function getUserInputVariables(promptTemplate: string): string[];
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
export declare function compilePrompt(promptTemplate: string, context: CompilePromptContext): CompilePromptResult;
export declare function getRequiredInputsForRecipe(recipeId: number): string[];
export declare function validateInputs(recipeId: number, providedInputs: Record<string, string>): {
    valid: boolean;
    missing: string[];
};
//# sourceMappingURL=promptParser.d.ts.map