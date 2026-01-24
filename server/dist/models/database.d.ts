import { Database as SqlJsDatabase } from 'sql.js';
declare let db: SqlJsDatabase | null;
export declare function initializeDatabase(): Promise<void>;
export declare const queries: {
    getUserById: (id: number) => any;
    getUserByEmail: (email: string) => any;
    createUser: (email: string, passwordHash: string, apiKeys?: string) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateUserApiKeys: (apiKeys: string, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    getAllRecipes: () => any[];
    getRecipesByUser: (userId: number) => any[];
    getRecipeById: (id: number) => any;
    createRecipe: (name: string, description: string | null, createdBy: number, isTemplate: boolean) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateRecipe: (name: string, description: string | null, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateRecipeWithTemplate: (name: string, description: string | null, isTemplate: boolean, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    deleteRecipe: (id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    getStepsByRecipeId: (recipeId: number) => any[];
    getStepById: (id: number) => any;
    createStep: (recipeId: number, stepOrder: number, stepName: string, aiModel: string | null, promptTemplate: string | null, inputConfig: string | null, outputFormat: string, modelConfig: string | null, stepType?: string, apiConfig?: string | null) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateStep: (stepName: string, aiModel: string, promptTemplate: string, inputConfig: string | null, outputFormat: string, modelConfig: string | null, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    deleteStep: (id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    deleteStepsByRecipeId: (recipeId: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    getStandardsByUser: (userId: number) => any[];
    getStandardById: (id: number) => any;
    getStandardsByType: (userId: number, standardType: string) => any[];
    createStandard: (userId: number, standardType: string, name: string, content: string) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateStandard: (name: string, content: string, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    deleteStandard: (id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    getExecutionsByUser: (userId: number) => any[];
    getExecutionById: (id: number) => any;
    getExecutionsByRecipe: (recipeId: number) => any[];
    createExecution: (recipeId: number, userId: number, inputData: string) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateExecutionStatus: (status: string, currentStep: number, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    completeExecution: (status: string, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    cancelExecution: (id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    deleteExecution: (id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    getStepExecutionsByExecutionId: (executionId: number) => any[];
    getStepExecutionById: (id: number) => any;
    createStepExecution: (executionId: number, stepId: number, stepOrder: number, inputData: string) => {
        lastInsertRowid: number;
        changes: number;
    };
    updateStepExecution: (status: string, outputData: string | null, aiModelUsed: string | null, promptUsed: string | null, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    approveStepExecution: (approved: boolean, status: string, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    setStepExecutionError: (status: string, errorMessage: string, id: number) => {
        lastInsertRowid: number;
        changes: number;
    };
    getAllOutputsByUser: (userId: number) => any[];
    logApiUsage: (userId: number, service: string, endpoint: string, requestCount: number, recordsFetched: number, metadata?: string) => {
        lastInsertRowid: number;
        changes: number;
    };
    getUsageByUser: (userId: number) => any[];
    getUsageByUserAndService: (userId: number, service: string) => any[];
    getUsageStats: (userId: number) => any;
    getUsageByService: (userId: number) => any[];
    getAllUsageAdmin: () => any[];
};
export default db;
//# sourceMappingURL=database.d.ts.map