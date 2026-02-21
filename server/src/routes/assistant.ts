import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { generateWorkflow, saveWorkflowGraph, ConversationMessage, GeneratedWorkflow } from '../services/workflowAssistant';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// POST /api/assistant/generate - Generate workflow from conversation
router.post('/generate', async (req: Request, res: Response) => {
  try {
    const { messages } = req.body as { messages: ConversationMessage[] };

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userId = req.user!.id;
    const result = await generateWorkflow(messages, userId);
    res.json(result);
  } catch (error: any) {
    console.error('Assistant generate error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate workflow' });
  }
});

// POST /api/assistant/save - Save a generated workflow as a workflow or skill
router.post('/save', async (req: Request, res: Response) => {
  try {
    const { workflow, asSkill } = req.body as {
      workflow: GeneratedWorkflow;
      asSkill?: boolean;
    };

    if (!workflow || !workflow.name || !workflow.steps || !Array.isArray(workflow.steps)) {
      return res.status(400).json({ error: 'Valid workflow object with name and steps is required' });
    }

    if (workflow.steps.length === 0) {
      return res.status(400).json({ error: 'Workflow must have at least one step' });
    }

    const userId = req.user!.id;
    const saveAsSkill = !!asSkill;
    const result = await saveWorkflowGraph(workflow, userId, saveAsSkill);

    res.json({
      success: true,
      entityType: result.entityType,
      skillId: result.skillId,
      workflowId: result.workflowId,
      createdSkillIds: result.createdSkillIds || [],
      message: `"${workflow.name}" saved successfully`,
    });
  } catch (error: any) {
    console.error('Assistant save error:', error);
    res.status(500).json({ error: error.message || 'Failed to save workflow' });
  }
});

export default router;
