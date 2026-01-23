import { Router, Request, Response } from 'express';
import { queries } from '../models/database';
import { authMiddleware } from '../middleware/auth';
import { CompanyStandard, CreateStandardRequest } from '../types';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/standards - List all standards
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const standards = queries.getStandardsByUser(userId) as CompanyStandard[];

    // Parse content for each standard
    const parsedStandards = standards.map(standard => {
      let parsedContent = {};
      try {
        parsedContent = JSON.parse(standard.content);
      } catch {
        parsedContent = { raw: standard.content };
      }

      return {
        ...standard,
        content: parsedContent,
      };
    });

    res.json(parsedStandards);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/standards/:id - Get single standard
router.get('/:id', (req: Request, res: Response) => {
  try {
    const standardId = parseInt(req.params.id, 10);
    const standard = queries.getStandardById(standardId) as CompanyStandard | undefined;

    if (!standard) {
      res.status(404).json({ error: 'Standard not found' });
      return;
    }

    let parsedContent = {};
    try {
      parsedContent = JSON.parse(standard.content);
    } catch {
      parsedContent = { raw: standard.content };
    }

    res.json({
      ...standard,
      content: parsedContent,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/standards/type/:type - Get standards by type
router.get('/type/:type', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const standardType = req.params.type;

    if (!['voice', 'platform', 'image'].includes(standardType)) {
      res.status(400).json({ error: 'Invalid standard type. Must be voice, platform, or image.' });
      return;
    }

    const standards = queries.getStandardsByType(userId, standardType) as CompanyStandard[];

    const parsedStandards = standards.map(standard => {
      let parsedContent = {};
      try {
        parsedContent = JSON.parse(standard.content);
      } catch {
        parsedContent = { raw: standard.content };
      }

      return {
        ...standard,
        content: parsedContent,
      };
    });

    res.json(parsedStandards);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/standards - Create standard
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { standard_type, name, content } = req.body as CreateStandardRequest;

    if (!standard_type || !name || !content) {
      res.status(400).json({ error: 'standard_type, name, and content are required' });
      return;
    }

    if (!['voice', 'platform', 'image'].includes(standard_type)) {
      res.status(400).json({ error: 'Invalid standard type. Must be voice, platform, or image.' });
      return;
    }

    // Stringify content if it's an object
    const contentStr = typeof content === 'object' ? JSON.stringify(content) : content;

    const result = queries.createStandard(userId, standard_type, name, contentStr);
    const standardId = result.lastInsertRowid;

    const createdStandard = queries.getStandardById(standardId) as CompanyStandard;

    let parsedContent = {};
    try {
      parsedContent = JSON.parse(createdStandard.content);
    } catch {
      parsedContent = { raw: createdStandard.content };
    }

    res.status(201).json({
      ...createdStandard,
      content: parsedContent,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/standards/:id - Update standard
router.put('/:id', (req: Request, res: Response) => {
  try {
    const standardId = parseInt(req.params.id, 10);
    const { name, content } = req.body;

    const existingStandard = queries.getStandardById(standardId) as CompanyStandard | undefined;
    if (!existingStandard) {
      res.status(404).json({ error: 'Standard not found' });
      return;
    }

    // Stringify content if it's an object
    const contentStr = content
      ? (typeof content === 'object' ? JSON.stringify(content) : content)
      : existingStandard.content;

    queries.updateStandard(
      name || existingStandard.name,
      contentStr,
      standardId
    );

    const updatedStandard = queries.getStandardById(standardId) as CompanyStandard;

    let parsedContent = {};
    try {
      parsedContent = JSON.parse(updatedStandard.content);
    } catch {
      parsedContent = { raw: updatedStandard.content };
    }

    res.json({
      ...updatedStandard,
      content: parsedContent,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/standards/:id - Delete standard
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const standardId = parseInt(req.params.id, 10);

    const existingStandard = queries.getStandardById(standardId) as CompanyStandard | undefined;
    if (!existingStandard) {
      res.status(404).json({ error: 'Standard not found' });
      return;
    }

    queries.deleteStandard(standardId);

    res.json({ success: true, message: 'Standard deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/standards/preview/:id - Preview how standard will be injected
router.get('/preview/:id', (req: Request, res: Response) => {
  try {
    const standardId = parseInt(req.params.id, 10);
    const standard = queries.getStandardById(standardId) as CompanyStandard | undefined;

    if (!standard) {
      res.status(404).json({ error: 'Standard not found' });
      return;
    }

    let parsedContent: any = {};
    try {
      parsedContent = JSON.parse(standard.content);
    } catch {
      parsedContent = { raw: standard.content };
    }

    // Generate preview of how it will appear in prompts
    let preview = '';
    switch (standard.standard_type) {
      case 'voice':
        if (parsedContent.tone) preview += `Tone: ${parsedContent.tone}\n`;
        if (parsedContent.style) preview += `Style: ${parsedContent.style}\n`;
        if (parsedContent.guidelines?.length) {
          preview += 'Guidelines:\n';
          parsedContent.guidelines.forEach((g: string) => {
            preview += `- ${g}\n`;
          });
        }
        break;

      case 'platform':
        if (parsedContent.platform) preview += `Platform: ${parsedContent.platform}\n`;
        if (parsedContent.requirements?.length) {
          preview += 'Requirements:\n';
          parsedContent.requirements.forEach((r: string) => {
            preview += `- ${r}\n`;
          });
        }
        if (parsedContent.characterLimits) {
          preview += 'Character Limits:\n';
          Object.entries(parsedContent.characterLimits).forEach(([key, value]) => {
            preview += `- ${key}: ${value}\n`;
          });
        }
        break;

      case 'image':
        if (parsedContent.style) preview += `Style: ${parsedContent.style}\n`;
        if (parsedContent.dimensions) preview += `Dimensions: ${parsedContent.dimensions}\n`;
        if (parsedContent.guidelines?.length) {
          preview += 'Guidelines:\n';
          parsedContent.guidelines.forEach((g: string) => {
            preview += `- ${g}\n`;
          });
        }
        break;

      default:
        preview = standard.content;
    }

    res.json({
      standard_id: standard.id,
      standard_name: standard.name,
      standard_type: standard.standard_type,
      preview: preview.trim(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
