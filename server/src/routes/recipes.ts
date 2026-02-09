import { Router, Request, Response } from 'express';
import { queries } from '../models/database';
import { authMiddleware } from '../middleware/auth';
import { getRequiredInputsForRecipe } from '../services/promptParser';
import {
  Recipe,
  RecipeStep,
  RecipeWithSteps,
  CreateRecipeRequest,
  UpdateRecipeRequest,
} from '../types';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/recipes - List all recipes
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const recipes = queries.getRecipesByUser(userId) as Recipe[];

    // Add step count to each recipe
    const recipesWithCounts = recipes.map(recipe => {
      const steps = queries.getStepsByRecipeId(recipe.id) as RecipeStep[];
      return {
        ...recipe,
        step_count: steps.length,
      };
    });

    res.json(recipesWithCounts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/recipes/:id - Get recipe with steps
router.get('/:id', (req: Request, res: Response) => {
  try {
    const recipeId = parseInt(req.params.id, 10);
    const recipe = queries.getRecipeById(recipeId) as Recipe | undefined;

    if (!recipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    const steps = queries.getStepsByRecipeId(recipeId) as RecipeStep[];
    const requiredInputs = getRequiredInputsForRecipe(recipeId);

    const recipeWithSteps: RecipeWithSteps & { required_inputs: string[] } = {
      ...recipe,
      steps,
      required_inputs: requiredInputs,
    };

    res.json(recipeWithSteps);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/recipes - Create recipe
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, description, steps, is_template } = req.body as CreateRecipeRequest;

    if (!name) {
      res.status(400).json({ error: 'Recipe name is required' });
      return;
    }

    // Create recipe (is_template defaults to false if not provided)
    const result = queries.createRecipe(name, description || null, userId, is_template || false);
    const recipeId = result.lastInsertRowid;

    // Create steps if provided
    if (steps && steps.length > 0) {
      steps.forEach((step, index) => {
        queries.createStep(
          recipeId,
          step.step_order || index + 1,
          step.step_name,
          step.ai_model,
          step.prompt_template,
          step.input_config || null,
          step.output_format || 'text',
          step.model_config || null,
          step.step_type || 'ai',
          step.api_config || null,
          step.executor_config || null
        );
      });
    }

    // Return created recipe with steps
    const createdRecipe = queries.getRecipeById(recipeId) as Recipe;
    const createdSteps = queries.getStepsByRecipeId(recipeId) as RecipeStep[];

    res.status(201).json({
      ...createdRecipe,
      steps: createdSteps,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/recipes/:id - Update recipe
router.put('/:id', (req: Request, res: Response) => {
  try {
    const recipeId = parseInt(req.params.id, 10);
    const { name, description, steps, is_template } = req.body as UpdateRecipeRequest;

    const existingRecipe = queries.getRecipeById(recipeId) as Recipe | undefined;
    if (!existingRecipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    // Update recipe with is_template support
    queries.updateRecipeWithTemplate(
      name || existingRecipe.name,
      description !== undefined ? description : existingRecipe.description || null,
      is_template !== undefined ? is_template : existingRecipe.is_template,
      recipeId
    );

    // Update steps if provided
    if (steps !== undefined) {
      // Delete existing steps
      queries.deleteStepsByRecipeId(recipeId);

      // Create new steps
      steps.forEach((step, index) => {
        queries.createStep(
          recipeId,
          step.step_order || index + 1,
          step.step_name,
          step.ai_model,
          step.prompt_template,
          step.input_config || null,
          step.output_format || 'text',
          step.model_config || null,
          step.step_type || 'ai',
          step.api_config || null,
          step.executor_config || null
        );
      });
    }

    // Return updated recipe with steps
    const updatedRecipe = queries.getRecipeById(recipeId) as Recipe;
    const updatedSteps = queries.getStepsByRecipeId(recipeId) as RecipeStep[];

    res.json({
      ...updatedRecipe,
      steps: updatedSteps,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/recipes/:id - Delete recipe
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const recipeId = parseInt(req.params.id, 10);

    const existingRecipe = queries.getRecipeById(recipeId) as Recipe | undefined;
    if (!existingRecipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    // Delete recipe (steps will cascade)
    queries.deleteRecipe(recipeId);

    res.json({ success: true, message: 'Recipe deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/recipes/:id/clone - Clone recipe
router.post('/:id/clone', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const recipeId = parseInt(req.params.id, 10);
    const { name } = req.body;

    const existingRecipe = queries.getRecipeById(recipeId) as Recipe | undefined;
    if (!existingRecipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    const existingSteps = queries.getStepsByRecipeId(recipeId) as RecipeStep[];

    // Create new recipe
    const newName = name || `${existingRecipe.name} (Copy)`;
    const result = queries.createRecipe(
      newName,
      existingRecipe.description || null,
      userId,
      false
    );
    const newRecipeId = result.lastInsertRowid;

    // Clone steps
    existingSteps.forEach(step => {
      queries.createStep(
        newRecipeId,
        step.step_order,
        step.step_name,
        step.ai_model,
        step.prompt_template,
        step.input_config || null,
        step.output_format,
        step.model_config || null,
        step.step_type || 'ai',
        step.api_config || null,
        step.executor_config || null
      );
    });

    // Return cloned recipe with steps
    const clonedRecipe = queries.getRecipeById(newRecipeId) as Recipe;
    const clonedSteps = queries.getStepsByRecipeId(newRecipeId) as RecipeStep[];

    res.status(201).json({
      ...clonedRecipe,
      steps: clonedSteps,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
