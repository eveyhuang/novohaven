import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { WorkflowDefinition, WorkflowStep, AIModel, InputTypeConfig, TemplateInputConfig } from '../../types';
import api, { ExecutorInfo } from '../../services/api';
import { Button, Input, TextArea, Select, Card, CardBody, CardHeader, Modal, DynamicInput, TranslatedText, ExecutorConfigFields } from '../common';
import { useLanguage } from '../../context/LanguageContext';

const DEFAULT_STEP: Omit<WorkflowStep, 'id' | 'recipe_id' | 'created_at'> = {
  step_order: 1,
  step_name: 'New Step',
  ai_model: 'mock',
  prompt_template: '',
  output_format: 'text',
  model_config: JSON.stringify({ temperature: 0.7, maxTokens: 2000 }),
};

export function RecipeRunner() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [recipe, setRecipe] = useState<WorkflowDefinition | null>(null);
  const [localSteps, setLocalSteps] = useState<WorkflowStep[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, any>>({});
  const [inputConfigs, setInputConfigs] = useState<Record<string, InputTypeConfig>>({});
  const [models, setModels] = useState<AIModel[]>([]);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]));
  const [showVariableHelp, setShowVariableHelp] = useState(false);

  useEffect(() => {
    loadModels();
    loadExecutors();
    if (id) {
      loadWorkflow(parseInt(id));
    }
  }, [id]);

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

  const loadWorkflow = async (workflowId: number) => {
    setIsLoading(true);
    try {
      const data = await api.getWorkflow(workflowId);
      setRecipe(data);
      setLocalSteps(data.steps || []);

      // Initialize input values and configs from step input_config
      const initialValues: Record<string, any> = {};
      const configs: Record<string, InputTypeConfig> = {};

      // Collect input configs and default values from all steps
      (data.steps || []).forEach((step) => {
        if (step.input_config) {
          try {
            const config: TemplateInputConfig = JSON.parse(step.input_config);
            // Collect variable configurations
            if (config.variables) {
              Object.entries(config.variables).forEach(([key, varConfig]) => {
                configs[key] = varConfig;
                // Ensure url_list types have default array value
                if (varConfig.type === 'url_list' && !(key in initialValues)) {
                  initialValues[key] = [''];
                }
              });
            }
            // Collect default values (if any)
            if ((config as any).defaultValues) {
              Object.entries((config as any).defaultValues).forEach(([key, value]) => {
                if (value) {
                  initialValues[key] = value;
                }
              });
            }
          } catch {
            // Ignore parse errors
          }
        }
        
        // Fallback for scraping steps without input_config - add default URL input
        if (step.step_type === 'scraping' && !step.input_config) {
          configs['urls'] = {
            type: 'url_list',
            label: t('productUrls'),
            placeholder: t('productUrlsPlaceholder'),
          };
          if (!('urls' in initialValues)) {
            initialValues['urls'] = [''];
          }
        }
      });

      // Then ensure all required inputs have appropriate default values
      (data.required_inputs || []).forEach((input) => {
        if (!(input in initialValues)) {
          const inputConfig = configs[input];
          // Set appropriate default based on type
          if (inputConfig?.type === 'url_list') {
            initialValues[input] = [''];
          } else if (inputConfig?.type === 'image' || inputConfig?.type === 'file') {
            initialValues[input] = null;
          } else {
            initialValues[input] = '';
          }
        }
      });

      setInputValues(initialValues);
      setInputConfigs(configs);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Extract required inputs from current step prompts and input configs
  const extractRequiredInputs = (): string[] => {
    const inputs = new Set<string>();
    const optionalInputs = new Set<string>();
    const variableRegex = /\{\{([^}]+)\}\}/g;
    const isStepOutputReference = (value: string): boolean => /^step_\d+_output(?:\..+)?$/i.test(String(value || '').trim());

    const standardNames = [
      'brand_voice', 'amazon_requirements', 'social_media_guidelines',
      'image_style_guidelines', 'platform_requirements', 'tone_guidelines',
    ];

    // First pass: collect all optional fields from input_configs
    for (const step of localSteps) {
      if (step.input_config) {
        try {
          const config = JSON.parse(step.input_config);
          if (config.variables) {
            // Handle both array format and object format
            if (Array.isArray(config.variables)) {
              for (const variable of config.variables) {
                const source = String(variable?.source || '').trim();
                if (source && source !== 'user_input') continue;
                if (isStepOutputReference(source)) continue;
                if (variable.optional === true || variable.required === false) {
                  optionalInputs.add(variable.name);
                }
              }
            } else {
              for (const [varName, varConfig] of Object.entries(config.variables)) {
                const cfg = varConfig as any;
                const source = String(cfg?.source || '').trim();
                if (source && source !== 'user_input') continue;
                if (isStepOutputReference(source)) continue;
                if (cfg.optional === true) {
                  optionalInputs.add(varName);
                }
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Second pass: collect required inputs
    for (const step of localSteps) {
      // For non-AI steps (including scraping), get inputs from input_config
      if (step.step_type && step.step_type !== 'ai') {
        let foundInputs = false;
        if (step.input_config) {
          try {
            const config = JSON.parse(step.input_config);
            if (config.variables) {
              // Handle both array format and object format
              if (Array.isArray(config.variables)) {
                // Array format: [{ name: 'product_urls', source: 'user_input', ... }]
                for (const variable of config.variables) {
                  if (variable.source === 'user_input' && variable.required !== false && variable.optional !== true && !isStepOutputReference(variable.name)) {
                    inputs.add(variable.name);
                    foundInputs = true;
                  }
                }
              } else {
                // Object format: { product_urls: { type: 'url_list', ... } }
                for (const [varName, varConfig] of Object.entries(config.variables)) {
                  const cfg = varConfig as any;
                  const source = String(cfg?.source || '').trim();
                  if (source && source !== 'user_input') continue;
                  if (isStepOutputReference(source)) continue;
                  // Skip optional variables
                  if (cfg.optional !== true && !isStepOutputReference(varName)) {
                    inputs.add(varName);
                    foundInputs = true;
                  }
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
        
        // Fallback for scraping steps without input_config
        if (step.step_type === 'scraping' && !foundInputs) {
          inputs.add('urls');
        }
        continue;
      }

      // For AI steps (and fallback), get inputs from prompt_template
      let match;
      const template = step.prompt_template || '';
      while ((match = variableRegex.exec(template)) !== null) {
        const varName = match[1].trim();
        // Skip step outputs, company standards, and optional fields
        if (!isStepOutputReference(varName) &&
            !standardNames.some(s => varName.toLowerCase().includes(s.replace(/_/g, ''))) &&
            !optionalInputs.has(varName)) {
          inputs.add(varName);
        }
      }
    }
    return Array.from(inputs);
  };

  const requiredInputs = extractRequiredInputs();

  // Extract ALL inputs (both required and optional) for display
  const allInputs = useMemo(() => {
    const allVars = new Set<string>();
    const variableRegex = /\{\{([^}]+)\}\}/g;
    const isStepOutputReference = (value: string): boolean => /^step_\d+_output(?:\..+)?$/i.test(String(value || '').trim());

    const standardNames = [
      'brand_voice', 'amazon_requirements', 'social_media_guidelines',
      'image_style_guidelines', 'platform_requirements', 'tone_guidelines',
    ];

    for (const step of localSteps) {
      // Get inputs from input_config
      if (step.input_config) {
        try {
          const config = JSON.parse(step.input_config);
          if (config.variables) {
            if (Array.isArray(config.variables)) {
              for (const variable of config.variables) {
                if (variable.source === 'user_input' && !isStepOutputReference(variable.name)) {
                  allVars.add(variable.name);
                }
              }
            } else {
              for (const [varName, varConfig] of Object.entries(config.variables)) {
                const cfg = varConfig as any;
                const source = String(cfg?.source || '').trim();
                if (source && source !== 'user_input') continue;
                if (isStepOutputReference(source)) continue;
                if (!isStepOutputReference(varName)) {
                  allVars.add(varName);
                }
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      // For AI steps, also get from prompt template
      if (step.step_type === 'ai' || !step.step_type) {
        let match;
        const template = step.prompt_template || '';
        while ((match = variableRegex.exec(template)) !== null) {
          const varName = match[1].trim();
          if (!isStepOutputReference(varName) &&
              !standardNames.some(s => varName.toLowerCase().includes(s.replace(/_/g, '')))) {
            allVars.add(varName);
          }
        }
      }

      // Fallback for scraping steps
      if (step.step_type === 'scraping') {
        allVars.add('urls');
      }
    }
    return Array.from(allVars);
  }, [localSteps]);

  const updateStep = (index: number, updates: Partial<WorkflowStep>) => {
    const newSteps = [...localSteps];
    newSteps[index] = { ...newSteps[index], ...updates };
    setLocalSteps(newSteps);
  };

  const addStep = () => {
    const newStep: WorkflowStep = {
      ...DEFAULT_STEP,
      step_order: localSteps.length + 1,
      step_name: `Step ${localSteps.length + 1}`,
    } as WorkflowStep;
    setLocalSteps([...localSteps, newStep]);
    setExpandedSteps(new Set([...expandedSteps, localSteps.length]));
  };

  const removeStep = (index: number) => {
    if (localSteps.length <= 1) {
      setError(t('recipeMustHaveStep'));
      return;
    }
    const newSteps = localSteps.filter((_, i) => i !== index);
    // Renumber steps
    newSteps.forEach((step, i) => {
      step.step_order = i + 1;
    });
    setLocalSteps(newSteps);
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= localSteps.length) return;

    const newSteps = [...localSteps];
    [newSteps[index], newSteps[newIndex]] = [newSteps[newIndex], newSteps[index]];
    // Renumber steps
    newSteps.forEach((step, i) => {
      step.step_order = i + 1;
    });
    setLocalSteps(newSteps);
  };

  const toggleStepExpanded = (index: number) => {
    const newExpanded = new Set(expandedSteps);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedSteps(newExpanded);
  };

  const validateAndPrepareInputs = (): Record<string, string> | null => {
    // Check for missing required inputs based on their type
    const missingInputs = requiredInputs.filter((input) => {
      const value = inputValues[input];
      const config = inputConfigs[input];

      if (!config || config.type === 'text' || config.type === 'textarea') {
        return !value || (typeof value === 'string' && !value.trim());
      } else if (config.type === 'image' || config.type === 'file') {
        return !value;
      } else if (config.type === 'url_list') {
        return !Array.isArray(value) || value.filter((u: string) => u.trim()).length === 0;
      }
      return !value;
    });

    if (missingInputs.length > 0) {
      setError(`${t('fillRequiredFields')}: ${missingInputs.map(i => inputConfigs[i]?.label || formatLabel(i)).join(', ')}`);
      return null;
    }

    // Prepare input data - convert complex types to strings for prompt injection
    const processedInputs: Record<string, string> = {};
    const isOptionalInput = (key: string) => !requiredInputs.includes(key);
    
    for (const [key, value] of Object.entries(inputValues)) {
      const config = inputConfigs[key];

      // Skip empty optional fields
      if (isOptionalInput(key)) {
        const isEmpty = !value || 
          (typeof value === 'string' && !value.trim()) ||
          (Array.isArray(value) && value.filter((u: string) => u?.trim()).length === 0);
        if (isEmpty) {
          continue;
        }
      }

      if (config?.type === 'image' && value?.base64) {
        // For images, include the base64 data (will be used by vision models)
        processedInputs[key] = value.base64;
        processedInputs[`${key}_description`] = `[Image: ${value.name}]`;
      } else if (config?.type === 'file' && value?.content) {
        // For files, include the content
        processedInputs[key] = value.content;
      } else if (config?.type === 'url_list' && Array.isArray(value)) {
        // For URL lists, join them
        processedInputs[key] = value.filter((u: string) => u.trim()).join('\n');
      } else if (typeof value === 'string') {
        processedInputs[key] = value;
      } else {
        processedInputs[key] = String(value || '');
      }
    }

    // Check that all AI steps have prompts (non-AI steps use executor_config instead)
    const emptyPromptSteps = localSteps.filter(s =>
      (s.step_type === 'ai' || !s.step_type) && (!s.prompt_template || !s.prompt_template.trim())
    );
    if (emptyPromptSteps.length > 0) {
      setError(t('allStepsMustHavePrompt'));
      return null;
    }


    return processedInputs;
  };

  const handleStartExecution = async () => {
    if (!recipe) return;

    const processedInputs = validateAndPrepareInputs();
    if (!processedInputs) return;

    setIsStarting(true);
    setError(null);

    try {
      // Pass modified steps to the execution with processed inputs
      const result = await api.startWorkflowExecution(recipe.id, processedInputs, localSteps);
      console.log('[RecipeRunner] Execution started, executionId:', result.executionId);
      // Navigate directly to the execution chat view
      navigate(`/executions/${result.executionId}`);
    } catch (err: any) {
      console.error('[RecipeRunner] Execution failed:', err);
      setError(err.message);
      setIsStarting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!recipe) {
    return (
      <div className="text-center py-12">
        <p className="text-secondary-600">{t('recipeNotFound')}</p>
        <Button onClick={() => navigate('/')} className="mt-4">
          {t('goToDashboard')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-secondary-900">
              <TranslatedText text={recipe.name} />
            </h1>
          </div>
          {recipe.description && (
            <p className="text-secondary-600 mt-1">
              <TranslatedText text={recipe.description} />
            </p>
          )}
        </div>
        <div className="flex items-center space-x-3">
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t('cancel')}
          </Button>
          <Button onClick={handleStartExecution} isLoading={isStarting}>
            {t('startWorkflow')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Input Values */}
      {allInputs.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-secondary-900">{t('inputValues')}</h2>
            <p className="text-sm text-secondary-500 mt-1">
              {t('provideInputs')}
            </p>
          </CardHeader>
          <CardBody className="space-y-4">
            {allInputs.map((input) => {
              const config = inputConfigs[input] || {
                type: 'text' as const,
                label: formatLabel(input),
                placeholder: `Enter ${formatLabel(input).toLowerCase()}...`,
              };

              // Ensure label defaults to formatted input name
              if (!config.label) {
                config.label = formatLabel(input);
              }

              // Check if this input is optional
              const isOptional = !requiredInputs.includes(input);
              
              // Add "(Optional)" to label if field is optional
              const displayConfig = {
                ...config,
                label: isOptional && !config.label?.includes('Optional') 
                  ? `${config.label} (Optional)` 
                  : config.label,
              };

              return (
                <DynamicInput
                  key={input}
                  name={input}
                  config={displayConfig}
                  value={inputValues[input]}
                  onChange={(value) =>
                    setInputValues({ ...inputValues, [input]: value })
                  }
                  t={t}
                />
              );
            })}
          </CardBody>
        </Card>
      )}

      {/* Workflow Steps */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-secondary-900">{t('workflowSteps')}</h2>
            <p className="text-sm text-secondary-500">
              {t('customizePrompts')}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowVariableHelp(true)}
              className="text-sm text-primary-600 hover:text-primary-700"
            >
              {t('variableHelp')}
            </button>
            <Button size="sm" onClick={addStep}>
              {t('addStep')}
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {localSteps.map((step, index) => (
            <Card key={index}>
              <div
                className="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-secondary-50"
                onClick={() => toggleStepExpanded(index)}
              >
                <div className="flex items-center space-x-4">
                  <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-semibold ${
                    step.step_type === 'scraping'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-primary-100 text-primary-700'
                  }`}>
                    {step.step_type === 'scraping' ? '🔍' : index + 1}
                  </div>
                  <div>
                    <h4 className="font-medium text-secondary-900">
                      <TranslatedText text={step.step_name} />
                    </h4>
                    <p className="text-sm text-secondary-500">
                      {step.step_type === 'scraping'
                        ? t('browserScraping')
                        : models.find(m => m.id === step.ai_model)?.name || step.ai_model}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveStep(index, 'up'); }}
                    disabled={index === 0}
                    className="p-1 text-secondary-400 hover:text-secondary-600 disabled:opacity-30"
                  >
                    <ChevronUpIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); moveStep(index, 'down'); }}
                    disabled={index === localSteps.length - 1}
                    className="p-1 text-secondary-400 hover:text-secondary-600 disabled:opacity-30"
                  >
                    <ChevronDownIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeStep(index); }}
                    className="p-1 text-red-400 hover:text-red-600"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                  <ChevronIcon
                    className={`w-5 h-5 text-secondary-400 transition-transform ${
                      expandedSteps.has(index) ? 'transform rotate-180' : ''
                    }`}
                  />
                </div>
              </div>

              {expandedSteps.has(index) && (
                <CardBody className="border-t border-secondary-100 space-y-4">
                  <Input
                    label={t('stepName')}
                    value={step.step_name}
                    onChange={(e) => updateStep(index, { step_name: e.target.value })}
                    placeholder={t('stepNamePlaceholder')}
                  />

                  {/* Scraping Step UI */}
                  {step.step_type === 'scraping' ? (
                    <div className="space-y-4">
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div className="flex items-center space-x-2 mb-2">
                          <span className="text-2xl">🌐</span>
                          <h4 className="font-medium text-blue-800">{t('browserScraping')}</h4>
                        </div>
                        <p className="text-sm text-blue-700">
                          {t('browserScrapingDescription')}
                        </p>
                      </div>
                      <div className="bg-secondary-50 rounded-lg p-4">
                        <h5 className="text-sm font-medium text-secondary-700 mb-2">{t('supportedPlatforms')}</h5>
                        <div className="flex space-x-2">
                          <span className="px-2 py-1 bg-purple-100 text-purple-800 text-xs rounded border border-purple-200">
                            🛋️ Wayfair
                          </span>
                        </div>
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                        <div className="flex items-start space-x-2">
                          <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <div>
                            <h5 className="text-sm font-medium text-amber-800 mb-1">{t('requiredInput')}</h5>
                            <p className="text-sm text-amber-700">
                              {t('browserRequiredInputHintPrefix')} <strong>{t('productUrls')}</strong> {t('browserRequiredInputHintSuffix')}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : step.step_type === 'ai' || !step.step_type ? (
                    /* AI Step UI */
                    <>
                      <Select
                        label={t('aiModel')}
                        value={step.ai_model}
                        onChange={(e) => updateStep(index, { ai_model: e.target.value })}
                        options={models.map(m => ({
                          value: m.id,
                          label: `${m.name}${m.available ? '' : ` (${t('notConfigured')})`}`,
                        }))}
                      />

                      <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1">
                          {t('promptTemplate')}
                        </label>
                        <TextArea
                          value={step.prompt_template}
                          onChange={(e) => updateStep(index, { prompt_template: e.target.value })}
                          placeholder={t('promptTemplatePlaceholder')}
                          rows={8}
                          className="font-mono text-sm"
                        />
                        <p className="mt-1 text-sm text-secondary-500">
                          {t('promptTemplateHelp')}
                        </p>
                      </div>

                      <Select
                        label={t('outputFormat')}
                        value={step.output_format}
                        onChange={(e) => updateStep(index, { output_format: e.target.value as any })}
                        options={[
                          { value: 'text', label: t('plainText') },
                          { value: 'markdown', label: t('markdown') },
                          { value: 'json', label: t('json') },
                        ]}
                      />

                      {/* Model Config */}
                      <div className="border-t border-secondary-200 pt-4">
                        <h3 className="text-sm font-medium text-secondary-700 mb-3">{t('modelSettings')}</h3>
                        <div className="grid grid-cols-2 gap-4">
                          <Input
                            label={t('temperature')}
                            type="number"
                            min="0"
                            max="2"
                            step="0.1"
                            value={JSON.parse(step.model_config || '{}').temperature || 0.7}
                            onChange={(e) => {
                              const config = JSON.parse(step.model_config || '{}');
                              config.temperature = parseFloat(e.target.value);
                              updateStep(index, { model_config: JSON.stringify(config) });
                            }}
                          />
                          <Input
                            label={t('maxTokens')}
                            type="number"
                            min="100"
                            max="100000"
                            step="100"
                            value={JSON.parse(step.model_config || '{}').maxTokens || 2000}
                            onChange={(e) => {
                              const config = JSON.parse(step.model_config || '{}');
                              config.maxTokens = parseInt(e.target.value);
                              updateStep(index, { model_config: JSON.stringify(config) });
                            }}
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    /* Dynamic executor config (script, http, transform, etc.) */
                    <ExecutorConfigFields
                      stepType={step.step_type!}
                      executors={executors}
                      executorConfig={step.executor_config || '{}'}
                      onConfigChange={(config) => updateStep(index, { executor_config: config })}
                    />
                  )}
                </CardBody>
              )}
            </Card>
          ))}
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-secondary-200">
        <Button variant="ghost" onClick={() => navigate('/')}>
          {t('cancel')}
        </Button>
        <Button onClick={handleStartExecution} isLoading={isStarting} size="lg">
          {t('startWorkflow')}
        </Button>
      </div>

      {/* Variable Help Modal */}
      <Modal
        isOpen={showVariableHelp}
        onClose={() => setShowVariableHelp(false)}
        title={t('variableReference')}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <h3 className="font-semibold text-secondary-900">{t('userInputVariables')}</h3>
            <p className="text-sm text-secondary-600 mt-1">
              <code className="bg-secondary-100 px-1 rounded">{'{{variable_name}}'}</code> {t('userInputVariablesDesc')}
            </p>
            <div className="mt-2 bg-secondary-50 p-3 rounded text-sm font-mono">
              {'{{product_name}}'}<br/>
              {'{{target_audience}}'}<br/>
              {'{{additional_context}}'}
            </div>
          </div>
          <div>
            <h3 className="font-semibold text-secondary-900">{t('previousStepOutputs')}</h3>
            <p className="text-sm text-secondary-600 mt-1">
              {t('previousStepOutputsDesc')} <code className="bg-secondary-100 px-1 rounded">{'{{step_N_output}}'}</code>
            </p>
            <div className="mt-2 bg-secondary-50 p-3 rounded text-sm font-mono">
              {'{{step_1_output}}'}<br/>
              {'{{step_2_output}}'}
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

    </div>
  );
}

function formatLabel(varName: string): string {
  return varName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Icons
function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
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
