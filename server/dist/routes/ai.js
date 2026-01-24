"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const aiService_1 = require("../services/aiService");
const types_1 = require("../types");
const router = (0, express_1.Router)();
// Apply auth middleware to all routes
router.use(auth_1.authMiddleware);
// GET /api/ai/models - Get available AI models
router.get('/models', (req, res) => {
    try {
        const availableModels = (0, aiService_1.getAvailableModels)();
        const allModels = types_1.AI_MODELS.map(model => ({
            ...model,
            available: (0, aiService_1.isProviderConfigured)(model.provider),
        }));
        res.json({
            available: availableModels,
            all: allModels,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/ai/providers - Get provider status
router.get('/providers', (req, res) => {
    try {
        const providers = [
            { id: 'openai', name: 'OpenAI', configured: (0, aiService_1.isProviderConfigured)('openai') },
            { id: 'anthropic', name: 'Anthropic', configured: (0, aiService_1.isProviderConfigured)('anthropic') },
            { id: 'google', name: 'Google', configured: (0, aiService_1.isProviderConfigured)('google') },
            { id: 'mock', name: 'Mock (Testing)', configured: true },
        ];
        res.json(providers);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/ai/test - Test AI prompt execution
router.post('/test', async (req, res) => {
    try {
        const { provider, model, prompt, config, images } = req.body;
        if (!provider || !model || !prompt) {
            res.status(400).json({ error: 'provider, model, and prompt are required' });
            return;
        }
        // Check if provider is configured
        if (!(0, aiService_1.isProviderConfigured)(provider)) {
            res.status(400).json({
                error: `${provider} is not configured. Please set the API key in environment variables.`,
            });
            return;
        }
        // Validate model belongs to provider
        const modelInfo = types_1.AI_MODELS.find(m => m.id === model && m.provider === provider);
        if (!modelInfo && provider !== 'mock') {
            res.status(400).json({
                error: `Model ${model} is not available for provider ${provider}`,
            });
            return;
        }
        // Merge images into config if provided
        const finalConfig = {
            ...(config || {}),
            ...(images && images.length > 0 ? { images } : {}),
        };
        const response = await (0, aiService_1.callAI)(provider, model, prompt, finalConfig);
        res.json(response);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/ai/validate - Validate prompt (check for variables, etc.)
router.post('/validate', (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            res.status(400).json({ error: 'prompt is required' });
            return;
        }
        // Find all variables in the prompt
        const variableRegex = /\{\{([^}]+)\}\}/g;
        const variables = [];
        let match;
        while ((match = variableRegex.exec(prompt)) !== null) {
            variables.push(match[1].trim());
        }
        // Categorize variables
        const userInputVars = [];
        const stepOutputVars = [];
        const standardVars = [];
        const standardNames = [
            'brand_voice', 'amazon_requirements', 'social_media_guidelines',
            'image_style_guidelines', 'platform_requirements', 'tone_guidelines',
        ];
        for (const varName of variables) {
            const stepMatch = varName.match(/^step_(\d+)_output$/);
            if (stepMatch) {
                stepOutputVars.push(varName);
            }
            else if (standardNames.some(s => varName.toLowerCase().includes(s.replace(/_/g, '')) ||
                varName.toLowerCase() === s.toLowerCase())) {
                standardVars.push(varName);
            }
            else {
                userInputVars.push(varName);
            }
        }
        res.json({
            valid: true,
            variables: {
                all: variables,
                user_input: userInputVars,
                step_output: stepOutputVars,
                company_standard: standardVars,
            },
            prompt_length: prompt.length,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=ai.js.map