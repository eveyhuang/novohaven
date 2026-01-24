import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Recipe, RecipeStep, AIModel, InputTypeConfig, TemplateInputConfig } from '../../types';
import api from '../../services/api';
import { Button, Input, TextArea, Select, Card, CardBody, CardHeader, Modal, DynamicInput, TranslatedText } from '../common';
import { useLanguage } from '../../context/LanguageContext';

const DEFAULT_STEP: Omit<RecipeStep, 'id' | 'recipe_id' | 'created_at'> = {
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

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [localSteps, setLocalSteps] = useState<RecipeStep[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, any>>({});
  const [inputConfigs, setInputConfigs] = useState<Record<string, InputTypeConfig>>({});
  const [models, setModels] = useState<AIModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]));
  const [showVariableHelp, setShowVariableHelp] = useState(false);

  useEffect(() => {
    loadModels();
    if (id) {
      loadRecipe(parseInt(id));
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

  const loadRecipe = async (recipeId: number) => {
    setIsLoading(true);
    try {
      const data = await api.getRecipe(recipeId);
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
    const variableRegex = /\{\{([^}]+)\}\}/g;

    const standardNames = [
      'brand_voice', 'amazon_requirements', 'social_media_guidelines',
      'image_style_guidelines', 'platform_requirements', 'tone_guidelines',
    ];

    for (const step of localSteps) {
      // For scraping steps, get inputs from input_config
      if (step.step_type === 'scraping' && step.input_config) {
        try {
          const config = JSON.parse(step.input_config);
          if (config.variables) {
            // Handle both array format and object format
            if (Array.isArray(config.variables)) {
              // Array format: [{ name: 'product_urls', source: 'user_input', ... }]
              for (const variable of config.variables) {
                if (variable.source === 'user_input' && variable.required !== false) {
                  inputs.add(variable.name);
                }
              }
            } else {
              // Object format: { product_urls: { type: 'url_list', ... } }
              for (const [varName, varConfig] of Object.entries(config.variables)) {
                const cfg = varConfig as any;
                // Skip optional variables
                if (cfg.optional !== true) {
                  inputs.add(varName);
                }
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
        continue;
      }

      // For AI steps, get inputs from prompt_template
      let match;
      const template = step.prompt_template || '';
      while ((match = variableRegex.exec(template)) !== null) {
        const varName = match[1].trim();
        // Skip step outputs and company standards
        if (!varName.match(/^step_\d+_output$/) &&
            !standardNames.some(s => varName.toLowerCase().includes(s.replace(/_/g, '')))) {
          inputs.add(varName);
        }
      }
    }
    return Array.from(inputs);
  };

  const requiredInputs = extractRequiredInputs();

  const updateStep = (index: number, updates: Partial<RecipeStep>) => {
    const newSteps = [...localSteps];
    newSteps[index] = { ...newSteps[index], ...updates };
    setLocalSteps(newSteps);
  };

  const addStep = () => {
    const newStep: RecipeStep = {
      ...DEFAULT_STEP,
      step_order: localSteps.length + 1,
      step_name: `Step ${localSteps.length + 1}`,
    } as RecipeStep;
    setLocalSteps([...localSteps, newStep]);
    setExpandedSteps(new Set([...expandedSteps, localSteps.length]));
  };

  const removeStep = (index: number) => {
    if (localSteps.length <= 1) {
      setError('Recipe must have at least one step');
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

  const handleStartExecution = async () => {
    if (!recipe) return;

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
      return;
    }

    // Prepare input data - convert complex types to strings for prompt injection
    const processedInputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(inputValues)) {
      const config = inputConfigs[key];

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

    // Check that all AI steps have prompts (scraping steps don't need prompts)
    const emptyPromptSteps = localSteps.filter(s =>
      s.step_type !== 'scraping' && (!s.prompt_template || !s.prompt_template.trim())
    );
    if (emptyPromptSteps.length > 0) {
      setError('All AI steps must have a prompt template');
      return;
    }

    setIsStarting(true);
    setError(null);
    try {
      // Pass modified steps to the execution with processed inputs
      const result = await api.startExecution(recipe.id, processedInputs, localSteps);
      navigate(`/executions/${result.executionId}`);
    } catch (err: any) {
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
            {recipe.is_template && (
              <span className="px-2 py-0.5 text-xs font-medium bg-primary-100 text-primary-700 rounded">
                {t('template')}
              </span>
            )}
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
      {requiredInputs.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-secondary-900">{t('inputValues')}</h2>
            <p className="text-sm text-secondary-500 mt-1">
              {t('provideInputs')}
            </p>
          </CardHeader>
          <CardBody className="space-y-4">
            {requiredInputs.map((input) => {
              const config = inputConfigs[input] || {
                type: 'text' as const,
                label: formatLabel(input),
                placeholder: `Enter ${formatLabel(input).toLowerCase()}...`,
              };

              // Ensure label defaults to formatted input name
              if (!config.label) {
                config.label = formatLabel(input);
              }

              return (
                <DynamicInput
                  key={input}
                  name={input}
                  config={config}
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
                        ? 'BrightData Scraping'
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
                          <span className="text-2xl">🔍</span>
                          <h4 className="font-medium text-blue-800">Scraping Step</h4>
                        </div>
                        <p className="text-sm text-blue-700">
                          This step extracts product reviews from e-commerce URLs using the BrightData API.
                          You can also upload CSV files with review data.
                        </p>
                        {step.api_config && (() => {
                          try {
                            const apiConfig = JSON.parse(step.api_config);
                            return (
                              <div className="mt-3 text-sm">
                                <span className="text-blue-600 font-medium">Service:</span>
                                <span className="ml-2 text-blue-800">{apiConfig.service}</span>
                                <span className="ml-4 text-blue-600 font-medium">Endpoint:</span>
                                <span className="ml-2 text-blue-800">{apiConfig.endpoint}</span>
                              </div>
                            );
                          } catch {
                            return null;
                          }
                        })()}
                      </div>
                      <div className="bg-secondary-50 rounded-lg p-4">
                        <h5 className="text-sm font-medium text-secondary-700 mb-2">Supported Platforms</h5>
                        <div className="flex space-x-2">
                          <span className="px-2 py-1 bg-orange-100 text-orange-800 text-xs rounded border border-orange-200">
                            📦 Amazon
                          </span>
                          <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded border border-blue-200">
                            🛒 Walmart
                          </span>
                          <span className="px-2 py-1 bg-purple-100 text-purple-800 text-xs rounded border border-purple-200">
                            🏠 Wayfair
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
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
