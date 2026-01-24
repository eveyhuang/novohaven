"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../models/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Apply auth middleware to all routes
router.use(auth_1.authMiddleware);
// GET /api/outputs - Get all outputs for the current user
router.get('/', (req, res) => {
    try {
        const userId = req.user.id;
        const outputs = database_1.queries.getAllOutputsByUser(userId);
        // Parse and categorize outputs
        const parsedOutputs = outputs.map((output) => {
            let parsedData = {};
            try {
                parsedData = JSON.parse(output.output_data);
            }
            catch {
                parsedData = { content: output.output_data };
            }
            return {
                id: output.id,
                executionId: output.execution_id,
                stepId: output.step_id,
                recipeName: output.recipe_name,
                stepName: output.step_name || 'Unknown Step',
                outputFormat: output.output_format || 'text',
                aiModel: output.ai_model_used,
                executedAt: output.executed_at,
                content: parsedData.content || '',
                generatedImages: parsedData.generatedImages,
            };
        });
        // Categorize by output type
        const categorized = {
            all: parsedOutputs,
            text: parsedOutputs.filter(o => o.outputFormat === 'text' && !o.generatedImages?.length),
            markdown: parsedOutputs.filter(o => o.outputFormat === 'markdown' && !o.generatedImages?.length),
            json: parsedOutputs.filter(o => o.outputFormat === 'json' && !o.generatedImages?.length),
            images: parsedOutputs.filter(o => o.generatedImages && o.generatedImages.length > 0),
        };
        res.json(categorized);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/outputs/:id - Get a specific output
router.get('/:id', (req, res) => {
    try {
        const outputId = parseInt(req.params.id, 10);
        const output = database_1.queries.getStepExecutionById(outputId);
        if (!output) {
            res.status(404).json({ error: 'Output not found' });
            return;
        }
        let parsedData = {};
        try {
            parsedData = JSON.parse(output.output_data);
        }
        catch {
            parsedData = { content: output.output_data };
        }
        res.json({
            id: output.id,
            executionId: output.execution_id,
            content: parsedData.content,
            generatedImages: parsedData.generatedImages,
            aiModel: output.ai_model_used,
            executedAt: output.executed_at,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=outputs.js.map