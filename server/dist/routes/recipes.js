"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../models/database");
const auth_1 = require("../middleware/auth");
const promptParser_1 = require("../services/promptParser");
const router = (0, express_1.Router)();
// Apply auth middleware to all routes
router.use(auth_1.authMiddleware);
// GET /api/recipes - List all recipes
router.get('/', (req, res) => {
    try {
        const userId = req.user.id;
        const recipes = database_1.queries.getRecipesByUser(userId);
        // Add step count to each recipe
        const recipesWithCounts = recipes.map(recipe => {
            const steps = database_1.queries.getStepsByRecipeId(recipe.id);
            return {
                ...recipe,
                step_count: steps.length,
            };
        });
        res.json(recipesWithCounts);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/recipes/:id - Get recipe with steps
router.get('/:id', (req, res) => {
    try {
        const recipeId = parseInt(req.params.id, 10);
        const recipe = database_1.queries.getRecipeById(recipeId);
        if (!recipe) {
            res.status(404).json({ error: 'Recipe not found' });
            return;
        }
        const steps = database_1.queries.getStepsByRecipeId(recipeId);
        const requiredInputs = (0, promptParser_1.getRequiredInputsForRecipe)(recipeId);
        const recipeWithSteps = {
            ...recipe,
            steps,
            required_inputs: requiredInputs,
        };
        res.json(recipeWithSteps);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/recipes - Create recipe
router.post('/', (req, res) => {
    try {
        const userId = req.user.id;
        const { name, description, steps, is_template } = req.body;
        if (!name) {
            res.status(400).json({ error: 'Recipe name is required' });
            return;
        }
        // Create recipe (is_template defaults to false if not provided)
        const result = database_1.queries.createRecipe(name, description || null, userId, is_template || false);
        const recipeId = result.lastInsertRowid;
        // Create steps if provided
        if (steps && steps.length > 0) {
            steps.forEach((step, index) => {
                database_1.queries.createStep(recipeId, step.step_order || index + 1, step.step_name, step.ai_model, step.prompt_template, step.input_config || null, step.output_format || 'text', step.model_config || null);
            });
        }
        // Return created recipe with steps
        const createdRecipe = database_1.queries.getRecipeById(recipeId);
        const createdSteps = database_1.queries.getStepsByRecipeId(recipeId);
        res.status(201).json({
            ...createdRecipe,
            steps: createdSteps,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// PUT /api/recipes/:id - Update recipe
router.put('/:id', (req, res) => {
    try {
        const recipeId = parseInt(req.params.id, 10);
        const { name, description, steps, is_template } = req.body;
        const existingRecipe = database_1.queries.getRecipeById(recipeId);
        if (!existingRecipe) {
            res.status(404).json({ error: 'Recipe not found' });
            return;
        }
        // Update recipe with is_template support
        database_1.queries.updateRecipeWithTemplate(name || existingRecipe.name, description !== undefined ? description : existingRecipe.description || null, is_template !== undefined ? is_template : existingRecipe.is_template, recipeId);
        // Update steps if provided
        if (steps !== undefined) {
            // Delete existing steps
            database_1.queries.deleteStepsByRecipeId(recipeId);
            // Create new steps
            steps.forEach((step, index) => {
                database_1.queries.createStep(recipeId, step.step_order || index + 1, step.step_name, step.ai_model, step.prompt_template, step.input_config || null, step.output_format || 'text', step.model_config || null);
            });
        }
        // Return updated recipe with steps
        const updatedRecipe = database_1.queries.getRecipeById(recipeId);
        const updatedSteps = database_1.queries.getStepsByRecipeId(recipeId);
        res.json({
            ...updatedRecipe,
            steps: updatedSteps,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// DELETE /api/recipes/:id - Delete recipe
router.delete('/:id', (req, res) => {
    try {
        const recipeId = parseInt(req.params.id, 10);
        const existingRecipe = database_1.queries.getRecipeById(recipeId);
        if (!existingRecipe) {
            res.status(404).json({ error: 'Recipe not found' });
            return;
        }
        // Delete recipe (steps will cascade)
        database_1.queries.deleteRecipe(recipeId);
        res.json({ success: true, message: 'Recipe deleted' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/recipes/:id/clone - Clone recipe
router.post('/:id/clone', (req, res) => {
    try {
        const userId = req.user.id;
        const recipeId = parseInt(req.params.id, 10);
        const { name } = req.body;
        const existingRecipe = database_1.queries.getRecipeById(recipeId);
        if (!existingRecipe) {
            res.status(404).json({ error: 'Recipe not found' });
            return;
        }
        const existingSteps = database_1.queries.getStepsByRecipeId(recipeId);
        // Create new recipe
        const newName = name || `${existingRecipe.name} (Copy)`;
        const result = database_1.queries.createRecipe(newName, existingRecipe.description || null, userId, false);
        const newRecipeId = result.lastInsertRowid;
        // Clone steps
        existingSteps.forEach(step => {
            database_1.queries.createStep(newRecipeId, step.step_order, step.step_name, step.ai_model, step.prompt_template, step.input_config || null, step.output_format, step.model_config || null);
        });
        // Return cloned recipe with steps
        const clonedRecipe = database_1.queries.getRecipeById(newRecipeId);
        const clonedSteps = database_1.queries.getStepsByRecipeId(newRecipeId);
        res.status(201).json({
            ...clonedRecipe,
            steps: clonedSteps,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=recipes.js.map