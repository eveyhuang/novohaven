import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Recipe, RecipeStep, AIModel, InputType, InputTypeConfig, TemplateInputConfig, GeneratedImage, StepType } from '../../types';
import api, { ExecutorInfo } from '../../services/api';
import { Button, Input, TextArea, Select, Card, CardBody, CardHeader, Modal, DynamicInput } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { TranslationKey } from '../../i18n/translations';
import ReactMarkdown from 'react-markdown';

// System variables that shouldn't be treated as user inputs
const SYSTEM_VARIABLES = [
  'brand_voice', 'amazon_requirements', 'image_style_guidelines',
  'social_media_guidelines', 'platform_requirements', 'tone_guidelines'
];

// Extract user input variables from prompt template
function extractInputsFromPrompt(promptTemplate: string): string[] {
  const variables: string[] = [];
  const matches = promptTemplate.match(/\{\{([^}]+)\}\}/g) || [];
  matches.forEach((match) => {
    const varName = match.replace(/\{\{|\}\}/g, '').trim();
    if (!varName.match(/^step_\d+_output$/) && !SYSTEM_VARIABLES.includes(varName)) {
      if (!variables.includes(varName)) {
        variables.push(varName);
      }
    }
  });
  return variables;
}

const INPUT_TYPE_OPTIONS: { value: InputType; labelKey: TranslationKey; icon: string }[] = [
  { value: 'text', labelKey: 'inputTypeText', icon: '📝' },
  { value: 'textarea', labelKey: 'inputTypeTextarea', icon: '📄' },
  { value: 'image', labelKey: 'inputTypeImage', icon: '🖼️' },
  { value: 'url_list', labelKey: 'inputTypeUrlList', icon: '🔗' },
  { value: 'file', labelKey: 'inputTypeFile', icon: '📁' },
];

const DEFAULT_INPUT_CONFIG: InputTypeConfig = {
  type: 'text',
  placeholder: '',
  description: '',
};

export function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const isNew = !id || id === 'new';
  const promptTextAreaRef = useRef<HTMLTextAreaElement>(null);

  const [template, setTemplate] = useState<{
    name: string;
    description: string;
    step_name: string;
    step_type: StepType;
    ai_model: string;
    prompt_template: string;
    output_format: 'text' | 'json' | 'markdown' | 'image';
    model_config: string;
    input_config: string;
    api_config: string;
    executor_config: string;
  }>({
    name: '',
    description: '',
    step_name: '',
    step_type: 'ai',
    ai_model: 'mock',
    prompt_template: '',
    output_format: 'text',
    model_config: JSON.stringify({ temperature: 0.7, maxTokens: 2000 }),
    input_config: JSON.stringify({ variables: {} }),
    api_config: '',
    executor_config: '',
  });

  const [models, setModels] = useState<AIModel[]>([]);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [isLoading, setIsLoading] = useState(!isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showVariableHelp, setShowVariableHelp] = useState(false);
  const [expandedVariable, setExpandedVariable] = useState<string | null>(null);
  const [showAddVariable, setShowAddVariable] = useState(false);
  const [newVariableName, setNewVariableName] = useState('');
  const [newVariableType, setNewVariableType] = useState<InputType>('text');
  const [editingVariableName, setEditingVariableName] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');

  // Test mode state
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [testInputValues, setTestInputValues] = useState<Record<string, any>>({});
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testGeneratedImages, setTestGeneratedImages] = useState<GeneratedImage[]>([]);
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    loadModels();
    loadExecutors();
    if (!isNew && id) {
      loadTemplate(parseInt(id));
    }
  }, [id, isNew]);

  const loadModels = async () => {
    try {
      const { all } = await api.getAIModels();
      setModels(all);
    } catch (err: any) {
      console.error('Failed to load models:', err);
    }
  };

  const loadExecutors = async () => {
    try {
      const data = await api.getExecutors();
      setExecutors(data);
    } catch (err: any) {
      console.error('Failed to load executors:', err);
    }
  };

  const loadTemplate = async (templateId: number) => {
    setIsLoading(true);
    try {
      const data = await api.getRecipe(templateId);
      const step = data.steps?.[0];
      console.log('DEBUG TemplateEditor - Full API response:', data);
      console.log('DEBUG TemplateEditor - First step:', step);
      console.log('DEBUG TemplateEditor - step_type value:', step?.step_type);
      setTemplate({
        name: data.name,
        description: data.description || '',
        step_name: step?.step_name || data.name,
        step_type: (step?.step_type as StepType) || 'ai',
        ai_model: step?.ai_model || 'mock',
        prompt_template: step?.prompt_template || '',
        output_format: step?.output_format || 'text',
        model_config: step?.model_config || JSON.stringify({ temperature: 0.7, maxTokens: 2000 }),
        input_config: step?.input_config || JSON.stringify({ variables: {} }),
        api_config: step?.api_config || '',
        executor_config: step?.executor_config || '',
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Get input config for a variable
  const getInputConfig = (varName: string): InputTypeConfig => {
    try {
      const config: TemplateInputConfig = JSON.parse(template.input_config);
      return config.variables?.[varName] || { ...DEFAULT_INPUT_CONFIG };
    } catch {
      return { ...DEFAULT_INPUT_CONFIG };
    }
  };

  // Update input config for a variable
  const updateInputConfig = (varName: string, updates: Partial<InputTypeConfig>) => {
    try {
      const config: TemplateInputConfig = JSON.parse(template.input_config);
      if (!config.variables) config.variables = {};
      config.variables[varName] = { ...getInputConfig(varName), ...updates };
      setTemplate({ ...template, input_config: JSON.stringify(config) });
    } catch {
      const config: TemplateInputConfig = { variables: { [varName]: { ...DEFAULT_INPUT_CONFIG, ...updates } } };
      setTemplate({ ...template, input_config: JSON.stringify(config) });
    }
  };

  // Get all configured variables (including those not in prompt)
  const getConfiguredVariables = (): string[] => {
    try {
      const config: TemplateInputConfig = JSON.parse(template.input_config);
      return Object.keys(config.variables || {});
    } catch {
      return [];
    }
  };

  // Add a new variable
  const addVariable = () => {
    if (!newVariableName.trim()) return;
    const varName = newVariableName.trim().replace(/\s+/g, '_').toLowerCase();

    // Check if variable already exists
    const allVars = [...new Set([...promptVariables, ...getConfiguredVariables()])];
    if (allVars.includes(varName)) {
      setError(t('variableAlreadyExists'));
      return;
    }

    updateInputConfig(varName, { type: newVariableType });
    setNewVariableName('');
    setNewVariableType('text');
    setShowAddVariable(false);
    setExpandedVariable(varName);
  };

  // Delete a variable from config
  const deleteVariable = (varName: string) => {
    try {
      const config: TemplateInputConfig = JSON.parse(template.input_config);
      if (config.variables?.[varName]) {
        delete config.variables[varName];
        setTemplate({ ...template, input_config: JSON.stringify(config) });
      }
    } catch {
      // Ignore
    }
    if (expandedVariable === varName) {
      setExpandedVariable(null);
    }
  };

  // Rename a variable
  const renameVariable = (oldName: string, newName: string) => {
    if (!newName.trim() || oldName === newName) {
      setEditingVariableName(null);
      return;
    }

    const formattedName = newName.trim().replace(/\s+/g, '_').toLowerCase();

    // Update config
    try {
      const config: TemplateInputConfig = JSON.parse(template.input_config);
      if (config.variables?.[oldName]) {
        config.variables[formattedName] = config.variables[oldName];
        delete config.variables[oldName];
      }

      // Update prompt template - replace old variable with new one
      const updatedPrompt = template.prompt_template.replace(
        new RegExp(`\\{\\{\\s*${oldName}\\s*\\}\\}`, 'g'),
        `{{${formattedName}}}`
      );

      setTemplate({
        ...template,
        input_config: JSON.stringify(config),
        prompt_template: updatedPrompt
      });
    } catch {
      // Ignore
    }

    setEditingVariableName(null);
    if (expandedVariable === oldName) {
      setExpandedVariable(formattedName);
    }
  };

  // Insert variable into prompt at cursor position
  const insertVariableIntoPrompt = (varName: string) => {
    const textarea = promptTextAreaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = template.prompt_template;
    const variableText = `{{${varName}}}`;

    const newText = text.substring(0, start) + variableText + text.substring(end);
    setTemplate({ ...template, prompt_template: newText });

    // Focus and set cursor position after the inserted variable
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + variableText.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  // Initialize test input values when test panel opens
  const openTestPanel = () => {
    const initialValues: Record<string, any> = {};
    allVariables.forEach((varName) => {
      const config = getInputConfig(varName);
      if (config.type === 'url_list') {
        initialValues[varName] = [''];
      } else if (config.type === 'image' || config.type === 'file') {
        initialValues[varName] = null;
      } else {
        initialValues[varName] = '';
      }
    });
    setTestInputValues(initialValues);
    setTestOutput(null);
    setTestGeneratedImages([]);
    setTestError(null);
    setShowTestPanel(true);
  };

  // Run test execution
  const runTest = async () => {
    // Validate required inputs
    const missingInputs = allVariables.filter((varName) => {
      const value = testInputValues[varName];
      const config = getInputConfig(varName);
      if (config.type === 'image' || config.type === 'file') {
        return !value;
      } else if (config.type === 'url_list') {
        return !Array.isArray(value) || value.filter((u: string) => u.trim()).length === 0;
      }
      return !value || (typeof value === 'string' && !value.trim());
    });

    if (missingInputs.length > 0) {
      setTestError(`${t('fillRequiredFields')}: ${missingInputs.map(v => getInputConfig(v).label || v).join(', ')}`);
      return;
    }

    // Only require prompt_template for AI templates
    if (template.step_type === 'ai' && !template.prompt_template.trim()) {
      setTestError(t('promptTemplateRequired'));
      return;
    }

    // Non-AI templates can't be tested in the same way
    if (template.step_type !== 'ai') {
      setTestError('Only AI templates can be tested directly. Please run the template in a workflow to test.');
      return;
    }

    setIsTestRunning(true);
    setTestError(null);
    setTestOutput(null);
    setTestGeneratedImages([]);

    try {
      // Compile prompt by replacing variables
      let compiledPrompt = template.prompt_template;
      const images: Array<{ base64: string; mediaType: string }> = [];

      for (const varName of allVariables) {
        const value = testInputValues[varName];
        const config = getInputConfig(varName);
        let replacementValue = '';

        if (config.type === 'image' && value?.base64) {
          // Extract image for vision models
          images.push({
            base64: value.base64,
            mediaType: value.type || 'image/jpeg',
          });
          replacementValue = `[See attached image: ${varName}]`;
        } else if (config.type === 'file' && value?.content) {
          replacementValue = value.content;
        } else if (config.type === 'url_list' && Array.isArray(value)) {
          replacementValue = value.filter((u: string) => u.trim()).join('\n');
        } else {
          replacementValue = String(value || '');
        }

        compiledPrompt = compiledPrompt.replace(
          new RegExp(`\\{\\{\\s*${varName}\\s*\\}\\}`, 'g'),
          replacementValue
        );
      }

      // Get model config
      const modelConfig = JSON.parse(template.model_config || '{}');
      const modelInfo = models.find(m => m.id === template.ai_model);
      const provider = modelInfo?.provider || 'mock';

      // Call AI test endpoint
      const response = await api.testAI(
        provider,
        template.ai_model,
        compiledPrompt,
        {
          temperature: modelConfig.temperature,
          maxTokens: modelConfig.maxTokens,
        },
        images.length > 0 ? images : undefined
      );

      if (response.success) {
        setTestOutput(response.content);
        if (response.generatedImages && response.generatedImages.length > 0) {
          setTestGeneratedImages(response.generatedImages);
        }
      } else {
        setTestError(response.error || t('testFailed'));
      }
    } catch (err: any) {
      setTestError(err.message || t('testFailed'));
    } finally {
      setIsTestRunning(false);
    }
  };

  const handleSave = async () => {
    if (!template.name) {
      setError(t('templateNameRequired'));
      return;
    }
    // Only require prompt_template for AI templates
    if (template.step_type === 'ai' && !template.prompt_template) {
      setError(t('promptTemplateRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const step: any = {
        step_order: 1,
        step_name: template.step_name || template.name,
        step_type: template.step_type,
        ai_model: template.ai_model,
        prompt_template: template.prompt_template,
        output_format: template.output_format,
        model_config: template.model_config,
        input_config: template.input_config,
      };

      // Include api_config for scraping templates
      if (template.step_type === 'scraping' && template.api_config) {
        step.api_config = template.api_config;
      }

      // Include executor_config for non-AI/scraping types
      if (template.executor_config) {
        step.executor_config = template.executor_config;
      }

      if (isNew) {
        await api.createRecipe({
          name: template.name,
          description: template.description,
          steps: [step],
          is_template: true,
        });
        navigate('/');
      } else if (id) {
        await api.updateRecipe(parseInt(id), {
          name: template.name,
          description: template.description,
          steps: [step],
          is_template: true,
        });
        navigate('/');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !window.confirm(t('confirmDeleteTemplate'))) return;
    try {
      await api.deleteRecipe(parseInt(id));
      navigate('/');
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Variables extracted from prompt
  const promptVariables = useMemo(() => extractInputsFromPrompt(template.prompt_template), [template.prompt_template]);

  // All variables (from prompt + configured)
  const allVariables = useMemo(() => {
    const configured = getConfiguredVariables();
    return [...new Set([...promptVariables, ...configured])];
  }, [promptVariables, template.input_config]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">
            {isNew ? t('createNewTemplate') : t('editTemplate')}
          </h1>
          <p className="text-secondary-600 mt-1">
            {t('templateEditorSubtitle')}
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t('cancel')}
          </Button>
          {!isNew && (
            <Button variant="ghost" onClick={handleDelete} className="text-red-600 hover:text-red-700">
              {t('delete')}
            </Button>
          )}
          {template.step_type === 'ai' ? (
            /* For AI templates, show Test Template button */
            <Button variant="secondary" onClick={openTestPanel}>
              <PlayIcon className="w-4 h-4 mr-2" />
              {t('testTemplate')}
            </Button>
          ) : (
            /* For non-AI templates, show Run Workflow button */
            !isNew && (
              <Button variant="secondary" onClick={() => navigate(`/recipes/${id}/run`)}>
                <PlayIcon className="w-4 h-4 mr-2" />
                {t('run')}
              </Button>
            )
          )}
          <Button onClick={handleSave} isLoading={isSaving}>
            {isNew ? t('createTemplate') : t('saveChanges')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Template Info */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-secondary-900">{t('templateDetails')}</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            label={t('templateName')}
            value={template.name}
            onChange={(e) => setTemplate({ ...template, name: e.target.value })}
            placeholder={t('templateNamePlaceholder')}
          />
          <TextArea
            label={t('description')}
            value={template.description}
            onChange={(e) => setTemplate({ ...template, description: e.target.value })}
            placeholder={t('templateDescriptionPlaceholder')}
            rows={2}
          />
        </CardBody>
      </Card>

      {/* Step Type Selector */}
      {executors.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-secondary-900">{t('stepType')}</h2>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              {executors.map((exec) => (
                <button
                  key={exec.type}
                  onClick={() => setTemplate({ ...template, step_type: exec.type as StepType })}
                  className={`flex flex-col items-center p-4 rounded-lg border-2 transition-colors ${
                    template.step_type === exec.type
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-secondary-200 hover:border-secondary-300'
                  }`}
                >
                  <span className="text-2xl mb-1">{exec.icon}</span>
                  <span className="text-sm font-medium text-secondary-900">{exec.displayName}</span>
                  <span className="text-xs text-secondary-500 mt-0.5 text-center">{exec.description.slice(0, 50)}</span>
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Configuration - Dynamic based on step type */}
      {template.step_type === 'scraping' ? (
        /* Scraping Configuration */
        <Card>
          <CardHeader>
            <div className="flex items-center space-x-2">
              <span className="text-2xl">🔍</span>
              <h2 className="font-semibold text-secondary-900">{t('scrapingConfiguration')}</h2>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-700">
                {t('scrapingStepDescription')}
              </p>
              {template.api_config && (() => {
                try {
                  const apiConfig = JSON.parse(template.api_config);
                  return (
                    <div className="mt-3 text-sm">
                      <span className="text-blue-600 font-medium">{t('service')}:</span>
                      <span className="ml-2 text-blue-800">{apiConfig.service}</span>
                      <span className="ml-4 text-blue-600 font-medium">{t('endpoint')}:</span>
                      <span className="ml-2 text-blue-800">{apiConfig.endpoint}</span>
                    </div>
                  );
                } catch {
                  return null;
                }
              })()}
            </div>

            <div className="bg-secondary-50 rounded-lg p-4">
              <h5 className="text-sm font-medium text-secondary-700 mb-2">{t('supportedPlatforms')}</h5>
              <div className="flex space-x-2">
                <span className="px-3 py-1.5 bg-orange-100 text-orange-800 text-sm rounded border border-orange-200">
                  📦 Amazon
                </span>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h5 className="text-sm font-medium text-yellow-800 mb-2">{t('howItWorks')}</h5>
              <ul className="text-sm text-yellow-700 space-y-1">
                <li>• {t('scrapingHowItWorks1')}</li>
                <li>• {t('scrapingHowItWorks2')}</li>
                <li>• {t('scrapingHowItWorks3')}</li>
              </ul>
            </div>

            <Select
              label={t('outputFormat')}
              value={template.output_format}
              onChange={(e) => setTemplate({ ...template, output_format: e.target.value as any })}
              options={[
                { value: 'json', label: t('json') },
                { value: 'text', label: t('plainText') },
              ]}
            />

            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <h5 className="text-sm font-medium text-green-800 mb-2">{t('usageTracking')}</h5>
              <p className="text-sm text-green-700">
                {t('usageTrackingDescription')}
              </p>
            </div>
          </CardBody>
        </Card>
      ) : template.step_type === 'ai' ? (
        /* AI Configuration */
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-secondary-900">{t('aiConfiguration')}</h2>
          </CardHeader>
          <CardBody className="space-y-4">
            <Select
              label={t('aiModel')}
              value={template.ai_model}
              onChange={(e) => setTemplate({ ...template, ai_model: e.target.value })}
              options={models.map(m => ({
                value: m.id,
                label: `${m.name}${m.available ? '' : ` (${t('notConfigured')})`}`,
              }))}
            />

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-secondary-700">
                  {t('promptTemplate')}
                </label>
                <button
                  onClick={() => setShowVariableHelp(true)}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  {t('variableHelp')}
                </button>
              </div>
              <textarea
                ref={promptTextAreaRef}
                value={template.prompt_template}
                onChange={(e) => setTemplate({ ...template, prompt_template: e.target.value })}
                placeholder={t('promptTemplatePlaceholder')}
                rows={12}
                className="w-full px-3 py-2 border border-secondary-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm"
              />
              <p className="mt-1 text-sm text-secondary-500">
                {t('templatePromptHelp')}
              </p>
            </div>

            <Select
              label={t('outputFormat')}
              value={template.output_format}
              onChange={(e) => setTemplate({ ...template, output_format: e.target.value as any })}
              options={[
                { value: 'text', label: t('plainText') },
                { value: 'markdown', label: t('markdown') },
                { value: 'json', label: t('json') },
                { value: 'image', label: t('generatedImages') },
              ]}
            />

            {/* Model Settings */}
            <div className="border-t border-secondary-200 pt-4">
              <h3 className="text-sm font-medium text-secondary-700 mb-3">{t('modelSettings')}</h3>
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t('temperature')}
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={JSON.parse(template.model_config || '{}').temperature || 0.7}
                  onChange={(e) => {
                    const config = JSON.parse(template.model_config || '{}');
                    config.temperature = parseFloat(e.target.value);
                    setTemplate({ ...template, model_config: JSON.stringify(config) });
                  }}
                />
                <Input
                  label={t('maxTokens')}
                  type="number"
                  min="100"
                  max="100000"
                  step="100"
                  value={JSON.parse(template.model_config || '{}').maxTokens || 2000}
                  onChange={(e) => {
                    const config = JSON.parse(template.model_config || '{}');
                    config.maxTokens = parseInt(e.target.value);
                    setTemplate({ ...template, model_config: JSON.stringify(config) });
                  }}
                />
              </div>
            </div>
          </CardBody>
        </Card>
      ) : (
        /* Dynamic Executor Configuration (script, http, transform, etc.) */
        <ExecutorConfigForm
          stepType={template.step_type}
          executors={executors}
          executorConfig={template.executor_config}
          onConfigChange={(config) => setTemplate({ ...template, executor_config: config })}
        />
      )}

      {/* Input Variables */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-secondary-900">{t('inputVariables')}</h2>
              <p className="text-sm text-secondary-500 mt-1">{t('inputVariablesDesc')}</p>
            </div>
            <Button size="sm" onClick={() => setShowAddVariable(true)}>
              + {t('addVariable')}
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {allVariables.length === 0 ? (
            <div className="text-center py-8 text-secondary-500">
              <div className="text-4xl mb-2">📥</div>
              <p>{t('noVariablesYet')}</p>
              <p className="text-sm mt-1">{t('addVariablesHint')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {allVariables.map((varName) => {
                const config = getInputConfig(varName);
                const isExpanded = expandedVariable === varName;
                const typeOption = INPUT_TYPE_OPTIONS.find(o => o.value === config.type);
                const isInPrompt = promptVariables.includes(varName);
                const isEditing = editingVariableName === varName;

                return (
                  <div
                    key={varName}
                    className="border border-secondary-200 rounded-lg overflow-hidden"
                  >
                    <div
                      className="flex items-center justify-between px-4 py-3 bg-secondary-50"
                    >
                      <div
                        className="flex items-center gap-3 flex-1 cursor-pointer"
                        onClick={() => setExpandedVariable(isExpanded ? null : varName)}
                      >
                        <span className="text-lg">{typeOption?.icon || '📝'}</span>
                        <div className="flex items-center gap-2">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editedName}
                              onChange={(e) => setEditedName(e.target.value)}
                              onBlur={() => renameVariable(varName, editedName)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') renameVariable(varName, editedName);
                                if (e.key === 'Escape') setEditingVariableName(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="px-2 py-1 border border-primary-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                              autoFocus
                            />
                          ) : (
                            <code className="font-semibold text-secondary-900">{varName}</code>
                          )}
                          <span className="text-sm text-secondary-500">
                            {typeOption ? t(typeOption.labelKey) : t('inputTypeText')}
                          </span>
                          {isInPrompt ? (
                            <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">
                              {t('inPrompt')}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700 rounded">
                              {t('notInPrompt')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {!isInPrompt && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              insertVariableIntoPrompt(varName);
                            }}
                            className="p-1.5 text-primary-600 hover:bg-primary-50 rounded"
                            title={t('insertIntoPrompt')}
                          >
                            <InsertIcon className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditedName(varName);
                            setEditingVariableName(varName);
                          }}
                          className="p-1.5 text-secondary-500 hover:bg-secondary-100 rounded"
                          title={t('rename')}
                        >
                          <EditIcon className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isInPrompt) {
                              if (window.confirm(t('confirmDeleteVariableInPrompt'))) {
                                deleteVariable(varName);
                              }
                            } else {
                              deleteVariable(varName);
                            }
                          }}
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                          title={t('delete')}
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setExpandedVariable(isExpanded ? null : varName)}
                          className="p-1.5 text-secondary-400 hover:bg-secondary-100 rounded"
                        >
                          <ChevronIcon className={`w-5 h-5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-4 py-4 space-y-4 border-t border-secondary-200">
                        <div>
                          <label className="block text-sm font-medium text-secondary-700 mb-2">
                            {t('inputType')}
                          </label>
                          <div className="grid grid-cols-5 gap-2">
                            {INPUT_TYPE_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                onClick={() => updateInputConfig(varName, { type: option.value })}
                                className={`flex flex-col items-center p-3 rounded-lg border-2 transition-colors ${
                                  config.type === option.value
                                    ? 'border-primary-500 bg-primary-50'
                                    : 'border-secondary-200 hover:border-secondary-300'
                                }`}
                              >
                                <span className="text-2xl mb-1">{option.icon}</span>
                                <span className="text-xs text-secondary-700">{t(option.labelKey)}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        <Input
                          label={t('fieldLabel')}
                          value={config.label || ''}
                          onChange={(e) => updateInputConfig(varName, { label: e.target.value })}
                          placeholder={varName}
                        />

                        <Input
                          label={t('placeholderText')}
                          value={config.placeholder || ''}
                          onChange={(e) => updateInputConfig(varName, { placeholder: e.target.value })}
                          placeholder={t('placeholderExample')}
                        />

                        <TextArea
                          label={t('helpText')}
                          value={config.description || ''}
                          onChange={(e) => updateInputConfig(varName, { description: e.target.value })}
                          placeholder={t('helpTextExample')}
                          rows={2}
                        />

                        {/* Type-specific options */}
                        {config.type === 'file' && (
                          <Input
                            label={t('acceptedFileTypes')}
                            value={(config.acceptedFileTypes || []).join(', ')}
                            onChange={(e) => updateInputConfig(varName, {
                              acceptedFileTypes: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                            })}
                            placeholder=".csv, .xlsx, .json"
                          />
                        )}

                        {config.type === 'url_list' && (
                          <div className="grid grid-cols-2 gap-4">
                            <Input
                              label={t('minUrls')}
                              type="number"
                              min="1"
                              value={config.minUrls || 1}
                              onChange={(e) => updateInputConfig(varName, { minUrls: parseInt(e.target.value) })}
                            />
                            <Input
                              label={t('maxUrls')}
                              type="number"
                              min="1"
                              value={config.maxUrls || 10}
                              onChange={(e) => updateInputConfig(varName, { maxUrls: parseInt(e.target.value) })}
                            />
                          </div>
                        )}

                        {config.type === 'image' && (
                          <Input
                            label={t('maxImageSizeMB')}
                            type="number"
                            min="1"
                            max="50"
                            value={config.maxImageSize || 10}
                            onChange={(e) => updateInputConfig(varName, { maxImageSize: parseInt(e.target.value) })}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Add Variable Modal */}
      <Modal
        isOpen={showAddVariable}
        onClose={() => {
          setShowAddVariable(false);
          setNewVariableName('');
          setNewVariableType('text');
        }}
        title={t('addNewVariable')}
      >
        <div className="space-y-4">
          <Input
            label={t('variableName')}
            value={newVariableName}
            onChange={(e) => setNewVariableName(e.target.value)}
            placeholder={t('variableNamePlaceholder')}
          />
          <p className="text-xs text-secondary-500 -mt-2">
            {t('variableNameHint')}
          </p>

          <div>
            <label className="block text-sm font-medium text-secondary-700 mb-2">
              {t('inputType')}
            </label>
            <div className="grid grid-cols-5 gap-2">
              {INPUT_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setNewVariableType(option.value)}
                  className={`flex flex-col items-center p-3 rounded-lg border-2 transition-colors ${
                    newVariableType === option.value
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-secondary-200 hover:border-secondary-300'
                  }`}
                >
                  <span className="text-2xl mb-1">{option.icon}</span>
                  <span className="text-xs text-secondary-700">{t(option.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="ghost" onClick={() => setShowAddVariable(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={addVariable} disabled={!newVariableName.trim()}>
              {t('addVariable')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Variable Help Modal */}
      <Modal
        isOpen={showVariableHelp}
        onClose={() => setShowVariableHelp(false)}
        title={t('variableReference')}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <h3 className="font-semibold text-secondary-900">{t('supportedInputTypes')}</h3>
            <div className="mt-2 space-y-2">
              {INPUT_TYPE_OPTIONS.map((option) => (
                <div key={option.value} className="flex items-center gap-2 text-sm">
                  <span>{option.icon}</span>
                  <span className="font-medium">{t(option.labelKey)}</span>
                  <span className="text-secondary-500">- {t(`inputType_${option.value}_desc`)}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-semibold text-secondary-900">{t('variableSyntax')}</h3>
            <p className="text-sm text-secondary-600 mt-1">
              <code className="bg-secondary-100 px-1 rounded">{'{{variable_name}}'}</code> {t('templateVariableDesc')}
            </p>
            <div className="mt-2 bg-secondary-50 p-3 rounded text-sm font-mono">
              {'{{product_image}}'} - {t('forImageUpload')}<br/>
              {'{{product_urls}}'} - {t('forUrlList')}<br/>
              {'{{sales_data}}'} - {t('forFileUpload')}
            </div>
          </div>
          <div>
            <h3 className="font-semibold text-secondary-900">{t('companyStandards')}</h3>
            <p className="text-sm text-secondary-600 mt-1">
              {t('companyStandardsDesc')}
            </p>
            <div className="mt-2 bg-secondary-50 p-3 rounded text-sm font-mono">
              {'{{brand_voice}}'}<br/>
              {'{{amazon_requirements}}'}<br/>
              {'{{image_style_guidelines}}'}
            </div>
          </div>
        </div>
      </Modal>

      {/* Test Template Panel */}
      <Modal
        isOpen={showTestPanel}
        onClose={() => setShowTestPanel(false)}
        title={t('testTemplate')}
        size="xl"
      >
        <div className="space-y-6">
          {/* Template Info */}
          <div className="bg-secondary-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-secondary-900">{template.name || t('untitledTemplate')}</h3>
                <p className="text-sm text-secondary-500 mt-1">
                  {t('model')}: {models.find(m => m.id === template.ai_model)?.name || template.ai_model}
                </p>
              </div>
              <span className="px-2 py-1 text-xs font-medium bg-primary-100 text-primary-700 rounded">
                {template.output_format}
              </span>
            </div>
          </div>

          {/* Input Fields */}
          {allVariables.length > 0 ? (
            <div>
              <h3 className="font-medium text-secondary-900 mb-3">{t('inputValues')}</h3>
              <div className="space-y-4">
                {allVariables.map((varName) => {
                  const config = getInputConfig(varName);
                  const displayConfig = {
                    ...config,
                    label: config.label || varName,
                  };

                  return (
                    <DynamicInput
                      key={varName}
                      name={varName}
                      config={displayConfig}
                      value={testInputValues[varName]}
                      onChange={(value) =>
                        setTestInputValues({ ...testInputValues, [varName]: value })
                      }
                      t={t}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-secondary-500">
              <p>{t('noInputVariables')}</p>
            </div>
          )}

          {/* Error Display */}
          {testError && (
            <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
              {testError}
            </div>
          )}

          {/* Output Display */}
          {(testOutput || testGeneratedImages.length > 0) && (
            <div>
              <h3 className="font-medium text-secondary-900 mb-3">{t('output')}</h3>

              {/* Generated Images Display */}
              {testGeneratedImages.length > 0 && (
                <div className="mb-4">
                  <div className="grid grid-cols-2 gap-4">
                    {testGeneratedImages.map((image, index) => (
                      <div key={index} className="relative group">
                        <div className="bg-secondary-100 rounded-lg overflow-hidden">
                          <img
                            src={`data:${image.mimeType};base64,${image.base64}`}
                            alt={`Generated image ${index + 1}`}
                            className="w-full h-auto object-contain"
                          />
                        </div>
                        <div className="absolute bottom-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => {
                              // Open image in new tab for full size view
                              const win = window.open();
                              if (win) {
                                win.document.write(`
                                  <html>
                                    <head><title>Generated Image ${index + 1}</title></head>
                                    <body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;">
                                      <img src="data:${image.mimeType};base64,${image.base64}" style="max-width:100%;max-height:100vh;" />
                                    </body>
                                  </html>
                                `);
                              }
                            }}
                            className="px-3 py-1.5 bg-white/90 hover:bg-white text-secondary-700 text-sm rounded-lg shadow-sm"
                            title={t('viewFullSize')}
                          >
                            <ExpandIcon className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              // Download image
                              const link = document.createElement('a');
                              link.href = `data:${image.mimeType};base64,${image.base64}`;
                              link.download = `generated-image-${index + 1}.${image.mimeType.split('/')[1] || 'png'}`;
                              document.body.appendChild(link);
                              link.click();
                              document.body.removeChild(link);
                            }}
                            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg shadow-sm"
                            title={t('downloadImage')}
                          >
                            <DownloadIcon className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="absolute top-2 left-2">
                          <span className="px-2 py-1 bg-black/50 text-white text-xs rounded">
                            {t('image')} {index + 1}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Text Output Display */}
              {testOutput && (
                <div className="bg-secondary-50 rounded-lg p-4 max-h-96 overflow-auto">
                  {template.output_format === 'markdown' ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown>{testOutput}</ReactMarkdown>
                    </div>
                  ) : template.output_format === 'json' ? (
                    <pre className="text-sm font-mono whitespace-pre-wrap">
                      {(() => {
                        try {
                          return JSON.stringify(JSON.parse(testOutput), null, 2);
                        } catch {
                          return testOutput;
                        }
                      })()}
                    </pre>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{testOutput}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-between items-center pt-4 border-t border-secondary-200">
            <Button variant="ghost" onClick={() => setShowTestPanel(false)}>
              {t('close')}
            </Button>
            <div className="flex gap-3">
              {(testOutput || testGeneratedImages.length > 0) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTestOutput(null);
                    setTestGeneratedImages([]);
                    setTestError(null);
                  }}
                >
                  {t('clearOutput')}
                </Button>
              )}
              <Button onClick={runTest} isLoading={isTestRunning}>
                <PlayIcon className="w-4 h-4 mr-2" />
                {t('runTest')}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Dynamic config form for executor types (script, http, transform, etc.)
 * Renders form fields based on the executor's config schema.
 */
function ExecutorConfigForm({
  stepType,
  executors,
  executorConfig,
  onConfigChange,
}: {
  stepType: string;
  executors: ExecutorInfo[];
  executorConfig: string;
  onConfigChange: (config: string) => void;
}) {
  const executor = executors.find(e => e.type === stepType);
  if (!executor) return null;

  let config: Record<string, any> = {};
  try {
    config = executorConfig ? JSON.parse(executorConfig) : {};
  } catch {
    config = {};
  }

  const updateField = (name: string, value: any) => {
    const updated = { ...config, [name]: value };
    onConfigChange(JSON.stringify(updated));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2">
          <span className="text-2xl">{executor.icon}</span>
          <div>
            <h2 className="font-semibold text-secondary-900">{executor.displayName} Configuration</h2>
            <p className="text-sm text-secondary-500">{executor.description}</p>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {executor.configSchema.fields.map((field) => {
          const value = config[field.name] ?? field.defaultValue ?? '';

          switch (field.type) {
            case 'select':
              return (
                <Select
                  key={field.name}
                  label={field.label}
                  value={value}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  options={field.options || []}
                />
              );

            case 'textarea':
              return (
                <div key={field.name}>
                  <TextArea
                    label={field.label}
                    value={value}
                    onChange={(e) => updateField(field.name, e.target.value)}
                    rows={6}
                    className="font-mono text-sm"
                  />
                  {field.helpText && (
                    <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                  )}
                </div>
              );

            case 'code':
              return (
                <div key={field.name}>
                  <label className="block text-sm font-medium text-secondary-700 mb-1">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <textarea
                    value={value}
                    onChange={(e) => updateField(field.name, e.target.value)}
                    rows={12}
                    className="w-full px-3 py-2 border border-secondary-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm bg-secondary-50"
                    placeholder={`Enter ${field.language || 'code'} here...`}
                  />
                  {field.helpText && (
                    <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                  )}
                </div>
              );

            case 'number':
              return (
                <Input
                  key={field.name}
                  label={field.label}
                  type="number"
                  value={value}
                  onChange={(e) => updateField(field.name, parseInt(e.target.value) || 0)}
                />
              );

            case 'json':
              return (
                <div key={field.name}>
                  <label className="block text-sm font-medium text-secondary-700 mb-1">
                    {field.label}
                  </label>
                  <textarea
                    value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                    onChange={(e) => {
                      try {
                        updateField(field.name, JSON.parse(e.target.value));
                      } catch {
                        // Allow invalid JSON while typing
                        const updated = { ...config, [field.name]: e.target.value };
                        onConfigChange(JSON.stringify(updated));
                      }
                    }}
                    rows={4}
                    className="w-full px-3 py-2 border border-secondary-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm"
                    placeholder='{"key": "value"}'
                  />
                  {field.helpText && (
                    <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                  )}
                </div>
              );

            case 'boolean':
              return (
                <div key={field.name} className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    checked={!!value}
                    onChange={(e) => updateField(field.name, e.target.checked)}
                    className="rounded border-secondary-300 text-primary-600 focus:ring-primary-500"
                  />
                  <label className="text-sm font-medium text-secondary-700">{field.label}</label>
                </div>
              );

            default: // 'text'
              return (
                <div key={field.name}>
                  <Input
                    label={field.label}
                    value={value}
                    onChange={(e) => updateField(field.name, e.target.value)}
                    placeholder={field.helpText || ''}
                  />
                  {field.helpText && (
                    <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                  )}
                </div>
              );
          }
        })}
      </CardBody>
    </Card>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function InsertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ExpandIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}
