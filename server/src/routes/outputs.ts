import { Router, Request, Response } from 'express';
import { queries } from '../models/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

interface OutputRecord {
  id: number;
  execution_id: number;
  step_id: number;
  step_order: number;
  output_data: string;
  ai_model_used: string;
  executed_at: string;
  recipe_id: number;
  recipe_name: string;
  step_name: string;
  output_format: string;
}

interface ParsedOutput {
  id: number;
  executionId: number;
  stepId: number;
  recipeName: string;
  stepName: string;
  outputFormat: string;
  aiModel: string;
  executedAt: string;
  content: string;
  generatedImages?: Array<{
    base64: string;
    mimeType: string;
  }>;
}

// GET /api/outputs - Get all outputs for the current user
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const outputs = queries.getAllOutputsByUser(userId) as OutputRecord[];

    // Parse and categorize outputs
    const parsedOutputs: ParsedOutput[] = outputs.map((output) => {
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(output.output_data);
      } catch {
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/outputs/:id - Get a specific output
router.get('/:id', (req: Request, res: Response) => {
  try {
    const outputId = parseInt(req.params.id, 10);
    const output = queries.getStepExecutionById(outputId) as any;

    if (!output) {
      res.status(404).json({ error: 'Output not found' });
      return;
    }

    let parsedData: any = {};
    try {
      parsedData = JSON.parse(output.output_data);
    } catch {
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
