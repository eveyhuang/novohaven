"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../models/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Apply auth middleware to all routes
router.use(auth_1.authMiddleware);
// GET /api/standards - List all standards
router.get('/', (req, res) => {
    try {
        const userId = req.user.id;
        const standards = database_1.queries.getStandardsByUser(userId);
        // Parse content for each standard
        const parsedStandards = standards.map(standard => {
            let parsedContent = {};
            try {
                parsedContent = JSON.parse(standard.content);
            }
            catch {
                parsedContent = { raw: standard.content };
            }
            return {
                ...standard,
                content: parsedContent,
            };
        });
        res.json(parsedStandards);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/standards/:id - Get single standard
router.get('/:id', (req, res) => {
    try {
        const standardId = parseInt(req.params.id, 10);
        const standard = database_1.queries.getStandardById(standardId);
        if (!standard) {
            res.status(404).json({ error: 'Standard not found' });
            return;
        }
        let parsedContent = {};
        try {
            parsedContent = JSON.parse(standard.content);
        }
        catch {
            parsedContent = { raw: standard.content };
        }
        res.json({
            ...standard,
            content: parsedContent,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/standards/type/:type - Get standards by type
router.get('/type/:type', (req, res) => {
    try {
        const userId = req.user.id;
        const standardType = req.params.type;
        if (!['voice', 'platform', 'image'].includes(standardType)) {
            res.status(400).json({ error: 'Invalid standard type. Must be voice, platform, or image.' });
            return;
        }
        const standards = database_1.queries.getStandardsByType(userId, standardType);
        const parsedStandards = standards.map(standard => {
            let parsedContent = {};
            try {
                parsedContent = JSON.parse(standard.content);
            }
            catch {
                parsedContent = { raw: standard.content };
            }
            return {
                ...standard,
                content: parsedContent,
            };
        });
        res.json(parsedStandards);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/standards - Create standard
router.post('/', (req, res) => {
    try {
        const userId = req.user.id;
        const { standard_type, name, content } = req.body;
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
        const result = database_1.queries.createStandard(userId, standard_type, name, contentStr);
        const standardId = result.lastInsertRowid;
        const createdStandard = database_1.queries.getStandardById(standardId);
        let parsedContent = {};
        try {
            parsedContent = JSON.parse(createdStandard.content);
        }
        catch {
            parsedContent = { raw: createdStandard.content };
        }
        res.status(201).json({
            ...createdStandard,
            content: parsedContent,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// PUT /api/standards/:id - Update standard
router.put('/:id', (req, res) => {
    try {
        const standardId = parseInt(req.params.id, 10);
        const { name, content } = req.body;
        const existingStandard = database_1.queries.getStandardById(standardId);
        if (!existingStandard) {
            res.status(404).json({ error: 'Standard not found' });
            return;
        }
        // Stringify content if it's an object
        const contentStr = content
            ? (typeof content === 'object' ? JSON.stringify(content) : content)
            : existingStandard.content;
        database_1.queries.updateStandard(name || existingStandard.name, contentStr, standardId);
        const updatedStandard = database_1.queries.getStandardById(standardId);
        let parsedContent = {};
        try {
            parsedContent = JSON.parse(updatedStandard.content);
        }
        catch {
            parsedContent = { raw: updatedStandard.content };
        }
        res.json({
            ...updatedStandard,
            content: parsedContent,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// DELETE /api/standards/:id - Delete standard
router.delete('/:id', (req, res) => {
    try {
        const standardId = parseInt(req.params.id, 10);
        const existingStandard = database_1.queries.getStandardById(standardId);
        if (!existingStandard) {
            res.status(404).json({ error: 'Standard not found' });
            return;
        }
        database_1.queries.deleteStandard(standardId);
        res.json({ success: true, message: 'Standard deleted' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/standards/preview/:id - Preview how standard will be injected
router.get('/preview/:id', (req, res) => {
    try {
        const standardId = parseInt(req.params.id, 10);
        const standard = database_1.queries.getStandardById(standardId);
        if (!standard) {
            res.status(404).json({ error: 'Standard not found' });
            return;
        }
        let parsedContent = {};
        try {
            parsedContent = JSON.parse(standard.content);
        }
        catch {
            parsedContent = { raw: standard.content };
        }
        // Generate preview of how it will appear in prompts
        let preview = '';
        switch (standard.standard_type) {
            case 'voice':
                if (parsedContent.tone)
                    preview += `Tone: ${parsedContent.tone}\n`;
                if (parsedContent.style)
                    preview += `Style: ${parsedContent.style}\n`;
                if (parsedContent.guidelines?.length) {
                    preview += 'Guidelines:\n';
                    parsedContent.guidelines.forEach((g) => {
                        preview += `- ${g}\n`;
                    });
                }
                break;
            case 'platform':
                if (parsedContent.platform)
                    preview += `Platform: ${parsedContent.platform}\n`;
                if (parsedContent.requirements?.length) {
                    preview += 'Requirements:\n';
                    parsedContent.requirements.forEach((r) => {
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
                if (parsedContent.style)
                    preview += `Style: ${parsedContent.style}\n`;
                if (parsedContent.dimensions)
                    preview += `Dimensions: ${parsedContent.dimensions}\n`;
                if (parsedContent.guidelines?.length) {
                    preview += 'Guidelines:\n';
                    parsedContent.guidelines.forEach((g) => {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=standards.js.map