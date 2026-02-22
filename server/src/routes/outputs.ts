import { Router, Request, Response } from 'express';
import { queries } from '../models/database';
import { authMiddleware } from '../middleware/auth';
import { getDatabase } from '../models/database';

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

interface ManusFileOutput {
  name: string;
  url: string;
  type: string;
  size?: number;
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
  fileName?: string;
  fileExtension?: string;
  fileMimeType?: string;
  manusFiles?: ManusFileOutput[];
  manusTaskId?: string;
}

function looksLikeCsv(content: string): boolean {
  const text = String(content || '').trim();
  if (!text) return false;
  if (text.startsWith('{') || text.startsWith('[')) return false;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  const header = lines[0];
  const second = lines[1];
  const hasCommaHeader = header.includes(',');
  const hasCommaSecond = second.includes(',');
  return hasCommaHeader && hasCommaSecond;
}

function inferFileDetails(outputFormat: string, content: string, stepName: string, id: number): {
  fileName?: string;
  fileExtension?: string;
  fileMimeType?: string;
} {
  if (outputFormat !== 'file') return {};
  const baseName = String(stepName || 'output').replace(/[^\w\u4e00-\u9fff-]+/g, '_');
  if (looksLikeCsv(content)) {
    return {
      fileExtension: 'csv',
      fileMimeType: 'text/csv',
      fileName: `${baseName}_${id}.csv`,
    };
  }
  return {
    fileExtension: 'txt',
    fileMimeType: 'text/plain',
    fileName: `${baseName}_${id}.txt`,
  };
}

interface AgentFileRecord {
  id: number;
  content: string;
  metadata: string;
  created_at: string;
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

      const content = parsedData.content || '';
      const fileDetails = inferFileDetails(
        output.output_format || 'text',
        content,
        output.step_name || 'output',
        output.id
      );

      return {
        id: output.id,
        executionId: output.execution_id,
        stepId: output.step_id,
        recipeName: output.recipe_name,
        stepName: output.step_name || 'Unknown Step',
        outputFormat: output.output_format || 'text',
        aiModel: output.ai_model_used,
        executedAt: output.executed_at,
        content,
        generatedImages: parsedData.generatedImages,
        ...fileDetails,
      };
    });

    // Also fetch Manus standalone outputs
    const manusOutputs = queries.getManusOutputsByUser(userId) as any[];
    const parsedManusOutputs: ParsedOutput[] = manusOutputs.map((mo) => {
      let files: ManusFileOutput[] | undefined;
      try {
        if (mo.files) files = JSON.parse(mo.files);
      } catch { /* ignore */ }

      return {
        id: mo.id + 1000000, // offset to avoid ID collision with step_executions
        executionId: 0,
        stepId: 0,
        recipeName: 'Manus AI Agent',
        stepName: mo.prompt ? (mo.prompt.length > 60 ? mo.prompt.slice(0, 60) + '...' : mo.prompt) : 'Manus Task',
        outputFormat: files?.length ? 'files' : 'markdown',
        aiModel: 'Manus AI',
        executedAt: mo.created_at,
        content: mo.output_text || '',
        manusFiles: files,
        manusTaskId: mo.task_id,
      };
    });

    // Also fetch Agent Chat file artifacts from assistant message metadata
    const db = getDatabase();
    const agentFileRows = db.prepare(`
      SELECT sm.id, sm.content, sm.metadata, sm.created_at
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      WHERE s.user_id = ?
        AND sm.role = 'assistant'
        AND sm.metadata IS NOT NULL
        AND sm.metadata != ''
        AND sm.metadata != '{}'
      ORDER BY sm.created_at DESC
      LIMIT 500
    `).all(userId) as AgentFileRecord[];

    const parsedAgentFileOutputs: ParsedOutput[] = [];
    for (const row of agentFileRows) {
      let metadata: any = {};
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        metadata = {};
      }
      const generatedFiles = Array.isArray(metadata.generatedFiles) ? metadata.generatedFiles : [];
      if (!generatedFiles.length) continue;

      const files: ManusFileOutput[] = generatedFiles
        .filter((f: any) => f && typeof f.url === 'string' && f.url.length > 0)
        .map((f: any) => ({
          name: f.name || (typeof f.url === 'string' ? f.url.split('/').pop() : 'download'),
          url: f.url,
          type: f.mimeType || f.type || 'application/octet-stream',
          size: Number.isFinite(Number(f.size)) ? Number(f.size) : undefined,
        }));
      if (!files.length) continue;

      parsedAgentFileOutputs.push({
        id: 2000000 + row.id,
        executionId: 0,
        stepId: 0,
        recipeName: 'Agent Chat',
        stepName: files.length === 1 ? files[0].name : `${files.length} generated files`,
        outputFormat: 'files',
        aiModel: 'Agent Tool',
        executedAt: row.created_at,
        content: row.content || '',
        manusFiles: files,
      });
    }

    const allOutputs = [...parsedOutputs, ...parsedManusOutputs, ...parsedAgentFileOutputs]
      .sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime());

    // Categorize by output type
    const categorized = {
      all: allOutputs,
      text: allOutputs.filter(o => o.outputFormat === 'text' && !o.generatedImages?.length && !o.manusFiles?.length),
      markdown: allOutputs.filter(o => o.outputFormat === 'markdown' && !o.generatedImages?.length && !o.manusFiles?.length),
      json: allOutputs.filter(o => o.outputFormat === 'json' && !o.generatedImages?.length),
      images: allOutputs.filter(o => o.generatedImages && o.generatedImages.length > 0),
      files: allOutputs.filter(o => (o.manusFiles && o.manusFiles.length > 0) || o.outputFormat === 'file'),
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
