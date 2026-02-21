import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { WorkflowDefinition, WorkflowStep, AIModel } from '../../types';
import api, { ExecutorInfo } from '../../services/api';
import { Button, Input, TextArea, Select, Card, CardBody, CardHeader, Modal, ExecutorConfigFields } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { useNotifications } from '../../context/NotificationContext';

const STEP_OUTPUT_REF_REGEX = /^step_\d+_output(?:\..+)?$/i;
const COMPANY_STANDARD_KEYS = [
  'brand_voice',
  'amazon_requirements',
  'image_style_guidelines',
  'social_media_guidelines',
  'platform_requirements',
  'tone_guidelines',
];

function isStepOutputReference(varName: string): boolean {
  return STEP_OUTPUT_REF_REGEX.test(String(varName || '').trim());
}

function isCompanyStandardVariable(varName: string): boolean {
  const normalized = String(varName || '').trim().toLowerCase();
  return COMPANY_STANDARD_KEYS.some((key) =>
    normalized.includes(key.replace(/_/g, '')) ||
    normalized === key ||
    normalized.replace(/_/g, '') === key.replace(/_/g, '')
  );
}

// Extract user input variables from a single prompt template (excludes step outputs and company standards)
function extractInputsFromPrompt(promptTemplate: string | null | undefined): string[] {
  if (!promptTemplate) return [];
  const variables: string[] = [];
  const matches = promptTemplate.match(/\{\{([^}]+)\}\}/g) || [];
  matches.forEach((match) => {
    const varName = match.replace(/\{\{|\}\}/g, '').trim();
    // Exclude step outputs (step_N_output) and common company standards
    if (!isStepOutputReference(varName) && !isCompanyStandardVariable(varName)) {
      if (!variables.includes(varName)) {
        variables.push(varName);
      }
    }
  });
  return variables;
}

// Extract user input variables from all steps
function extractRequiredInputs(steps: WorkflowStep[]): string[] {
  const requiredInputs = new Set<string>();
  const optionalInputs = new Set<string>();
  const variableRegex = /\{\{([^}]+)\}\}/g;

  // Pass 1: collect optional variables from input_config.
  for (const step of steps) {
    if (!step?.input_config) continue;
    try {
      const config = typeof step.input_config === 'string'
        ? JSON.parse(step.input_config)
        : step.input_config;
      if (!config?.variables) continue;

      if (Array.isArray(config.variables)) {
        for (const variable of config.variables) {
          const source = String(variable?.source || '').trim();
          if (source && source !== 'user_input') continue;
          if (isStepOutputReference(source)) continue;
          if (variable?.optional === true || variable?.required === false) {
            optionalInputs.add(String(variable.name || '').trim());
          }
        }
      } else {
        for (const [varName, varConfig] of Object.entries(config.variables)) {
          const cfg = varConfig as any;
          const source = String(cfg?.source || '').trim();
          if (source && source !== 'user_input') continue;
          if (isStepOutputReference(source)) continue;
          if (cfg?.optional === true || cfg?.required === false) {
            optionalInputs.add(String(varName || '').trim());
          }
        }
      }
    } catch {
      // Ignore malformed step config.
    }
  }

  const collectTemplateVariables = (templateText: string) => {
    if (!templateText) return;
    let match: RegExpExecArray | null;
    variableRegex.lastIndex = 0;
    while ((match = variableRegex.exec(templateText)) !== null) {
      const varName = String(match[1] || '').trim();
      if (!varName) continue;
      if (isStepOutputReference(varName)) continue;
      if (isCompanyStandardVariable(varName)) continue;
      if (optionalInputs.has(varName)) continue;
      requiredInputs.add(varName);
    }
  };

  // Pass 2: collect required user-input variables.
  for (const step of steps) {
    if (step?.input_config) {
      try {
        const config = typeof step.input_config === 'string'
          ? JSON.parse(step.input_config)
          : step.input_config;
        if (config?.variables) {
          if (Array.isArray(config.variables)) {
            for (const variable of config.variables) {
              const name = String(variable?.name || '').trim();
              if (!name) continue;
              if (isStepOutputReference(name)) continue;
              if (variable?.source === 'user_input' && variable?.required !== false && variable?.optional !== true) {
                requiredInputs.add(name);
              }
            }
          } else {
            for (const [varName, varConfig] of Object.entries(config.variables)) {
              const name = String(varName || '').trim();
              const cfg = varConfig as any;
              const source = String(cfg?.source || '').trim();
              if (!name) continue;
              if (isStepOutputReference(name)) continue;
              if (source && source !== 'user_input') continue;
              if (isStepOutputReference(source)) continue;
              if (cfg?.optional !== true && cfg?.required !== false) {
                requiredInputs.add(name);
              }
            }
          }
        }
      } catch {
        // Ignore malformed step config.
      }
    }

    collectTemplateVariables(step.prompt_template || '');
    if (step?.step_type && step.step_type !== 'ai') {
      const executorText = typeof step.executor_config === 'string'
        ? step.executor_config
        : JSON.stringify(step.executor_config || {});
      collectTemplateVariables(executorText);
    }
  }

  return Array.from(requiredInputs).sort();
}


export function RecipeBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { addNotification } = useNotifications();
  // Check if this is a new recipe: either no id param or id is 'new'
  const isNew = !id || id === 'new';

  const [recipe, setRecipe] = useState<Partial<WorkflowDefinition>>({
    name: '',
    description: '',
    steps: [],
  });
  const [models, setModels] = useState<AIModel[]>([]);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [availableSkills, setAvailableSkills] = useState<WorkflowDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(!isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);
  const [showVariableHelp, setShowVariableHelp] = useState(false);
  const [showStepSelector, setShowStepSelector] = useState(false);

  // Compute required inputs from all steps
  const requiredInputs = useMemo(() => {
    return extractRequiredInputs((recipe.steps || []) as WorkflowStep[]);
  }, [recipe.steps]);

  useEffect(() => {
    loadModels();
    loadExecutors();
    loadSkills();
    if (!isNew && id) {
      loadWorkflow(parseInt(id));
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

  const getExecutorInfo = (stepType?: string) => {
    return executors.find(e => e.type === (stepType || 'ai'));
  };

  const loadSkills = async () => {
    try {
      const skills = await api.getSkills();
      // Load steps for each skill
      const skillsWithSteps = await Promise.all(
        skills.map(async (skill) => {
          const fullSkill = await api.getSkill(skill.id);
          return fullSkill;
        })
      );
      setAvailableSkills(skillsWithSteps);
    } catch (err: any) {
      console.error('Failed to load skills:', err);
    }
  };

  const loadWorkflow = async (workflowId: number) => {
    setIsLoading(true);
    try {
      const data = await api.getWorkflow(workflowId);
      setRecipe(data);
      if (data.steps && data.steps.length > 0) {
        setSelectedStepIndex(0);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async (): Promise<boolean> => {
    if (!recipe.name) {
      setError(t('recipeNameRequired'));
      return false;
    }

    setIsSaving(true);
    setError(null);
    try {
      const steps = (recipe.steps || []).map((step, index) => ({
        ...step,
        step_order: index + 1,
      }));

      if (isNew) {
        const created = await api.createWorkflow({
          name: recipe.name,
          description: recipe.description,
          steps,
        });
        navigate(`/workflows/${created.id}`);
      } else if (id) {
        await api.updateWorkflow(parseInt(id), {
          name: recipe.name,
          description: recipe.description,
          steps,
        });
        addNotification({ type: 'success', title: t('workflowSaved') });
      }
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAndRun = async () => {
    const saved = await handleSave();
    if (saved && !isNew && id) {
      navigate(`/workflows/${id}/run`);
    }
  };

  const addStep = () => {
    setShowStepSelector(true);
  };

  const addSkillStep = (skillStep: WorkflowStep) => {
    const newStep: WorkflowStep = {
      ...skillStep,
      id: undefined,
      recipe_id: undefined,
      step_order: (recipe.steps?.length || 0) + 1,
    };
    setRecipe({
      ...recipe,
      steps: [...(recipe.steps || []), newStep],
    });
    setSelectedStepIndex((recipe.steps?.length || 0));
    setShowStepSelector(false);
  };

  const updateStep = (index: number, updates: Partial<WorkflowStep>) => {
    const steps = [...(recipe.steps || [])];
    steps[index] = { ...steps[index], ...updates };
    setRecipe({ ...recipe, steps });
  };

  const removeStep = (index: number) => {
    const steps = (recipe.steps || []).filter((_, i) => i !== index);
    setRecipe({ ...recipe, steps });
    if (selectedStepIndex === index) {
      setSelectedStepIndex(steps.length > 0 ? Math.max(0, index - 1) : null);
    } else if (selectedStepIndex !== null && selectedStepIndex > index) {
      setSelectedStepIndex(selectedStepIndex - 1);
    }
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const steps = [...(recipe.steps || [])];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= steps.length) return;

    [steps[index], steps[newIndex]] = [steps[newIndex], steps[index]];
    setRecipe({ ...recipe, steps });
    setSelectedStepIndex(newIndex);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const selectedStep = selectedStepIndex !== null ? recipe.steps?.[selectedStepIndex] : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">
            {isNew ? t('createNewRecipeTitle') : t('editRecipe')}
          </h1>
          <p className="text-secondary-600 mt-1">
            {t('buildWorkflowStep')}
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t('cancel')}
          </Button>
          {!isNew && (
            <Button variant="secondary" onClick={handleSaveAndRun} isLoading={isSaving}>
              {t('run')}
            </Button>
          )}
          <Button onClick={handleSave} isLoading={isSaving}>
            {isNew ? t('createRecipe') : t('saveChanges')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Recipe Info */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-secondary-900">{t('recipeDetails')}</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            label={t('recipeName')}
            value={recipe.name || ''}
            onChange={(e) => setRecipe({ ...recipe, name: e.target.value })}
            placeholder={t('recipeNamePlaceholder')}
          />
          <TextArea
            label={t('description')}
            value={recipe.description || ''}
            onChange={(e) => setRecipe({ ...recipe, description: e.target.value })}
            placeholder={t('descriptionPlaceholder')}
            rows={3}
          />
        </CardBody>
      </Card>

      {/* Required Inputs */}
      {requiredInputs.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-secondary-900">{t('requiredInputFields')}</h2>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-secondary-600 mb-3">{t('requiredInputFieldsDesc')}</p>
            <div className="flex flex-wrap gap-2">
              {requiredInputs.map((input) => (
                <span
                  key={input}
                  className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-primary-100 text-primary-800"
                >
                  {input}
                </span>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Steps Builder */}
      <div className="grid grid-cols-3 gap-6">
        {/* Step List */}
        <div className="col-span-1">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <h2 className="font-semibold text-secondary-900">{t('stepsTitle')}</h2>
              <Button size="sm" onClick={addStep}>
                {t('addStep')}
              </Button>
            </CardHeader>
            <CardBody className="p-0">
              {recipe.steps?.length === 0 ? (
                <div className="p-6 text-center text-secondary-500">
                  {t('noStepsYet')}
                </div>
              ) : (
                <div className="divide-y divide-secondary-100">
                  {recipe.steps?.map((step, index) => (
                    <div
                      key={index}
                      className={`p-4 cursor-pointer transition-colors ${
                        selectedStepIndex === index
                          ? 'bg-primary-50'
                          : 'hover:bg-secondary-50'
                      }`}
                      onClick={() => setSelectedStepIndex(index)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <span className="text-lg">{getExecutorInfo(step.step_type)?.icon || '🤖'}</span>
                          <div>
                            <span className="text-sm font-medium text-secondary-500">
                              Step {index + 1}
                            </span>
                            <h4 className="font-medium text-secondary-900">
                              {step.step_name}
                            </h4>
                          </div>
                        </div>
                        <div className="flex items-center space-x-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); moveStep(index, 'up'); }}
                            disabled={index === 0}
                            className="p-1 text-secondary-400 hover:text-secondary-600 disabled:opacity-30"
                          >
                            <ChevronUpIcon className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); moveStep(index, 'down'); }}
                            disabled={index === (recipe.steps?.length || 0) - 1}
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
                        </div>
                      </div>
                      <p className="text-sm text-secondary-500 mt-1">
                        {step.step_type === 'ai'
                          ? models.find(m => m.id === step.ai_model)?.name || step.ai_model
                          : getExecutorInfo(step.step_type)?.displayName || step.step_type}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Step Editor */}
        <div className="col-span-2">
          {selectedStep ? (
            <Card>
              <CardHeader>
                <h2 className="font-semibold text-secondary-900">
                  {t('stepConfiguration')} - Step {selectedStepIndex! + 1}
                </h2>
              </CardHeader>
              <CardBody className="space-y-4">
                <Input
                  label={t('stepName')}
                  value={selectedStep.step_name}
                  onChange={(e) => updateStep(selectedStepIndex!, { step_name: e.target.value })}
                  placeholder={t('stepNamePlaceholder')}
                />

                {/* Step type-specific configuration */}
                {selectedStep.step_type === 'scraping' ? (
                  <div className="space-y-4">
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center space-x-2 mb-2">
                        <span className="text-2xl">🔍</span>
                        <h4 className="font-medium text-blue-800">{t('scrapingStep')}</h4>
                      </div>
                      <p className="text-sm text-blue-700">
                        {t('scrapingStepDescription')}
                      </p>
                    </div>

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <h5 className="text-sm font-medium text-yellow-800 mb-2">{t('howItWorks')}</h5>
                      <ul className="text-sm text-yellow-700 space-y-1">
                        <li>• {t('scrapingInputOption1')}</li>
                        <li>• {t('scrapingInputOption2')}</li>
                        <li>• {t('scrapingInputOption3')}</li>
                      </ul>
                    </div>

                    <Select
                      label={t('outputFormat')}
                      value={selectedStep.output_format}
                      onChange={(e) => updateStep(selectedStepIndex!, { output_format: e.target.value as any })}
                      options={[
                        { value: 'json', label: t('json') },
                        { value: 'text', label: t('plainText') },
                      ]}
                    />
                  </div>
                ) : selectedStep.step_type === 'ai' || !selectedStep.step_type ? (
                  /* AI Step UI */
                  <>
                    <Select
                      label={t('aiModel')}
                      value={selectedStep.ai_model}
                      onChange={(e) => updateStep(selectedStepIndex!, { ai_model: e.target.value })}
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
                      <TextArea
                        value={selectedStep.prompt_template}
                        onChange={(e) => updateStep(selectedStepIndex!, { prompt_template: e.target.value })}
                        placeholder={t('promptTemplatePlaceholder')}
                        rows={12}
                        className="font-mono text-sm"
                      />
                      <p className="mt-1 text-sm text-secondary-500">
                        {t('promptTemplateHelp')}
                      </p>
                    </div>

                    <Select
                      label={t('outputFormat')}
                      value={selectedStep.output_format}
                      onChange={(e) => updateStep(selectedStepIndex!, { output_format: e.target.value as any })}
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
                          value={JSON.parse(selectedStep.model_config || '{}').temperature || 0.7}
                          onChange={(e) => {
                            const config = JSON.parse(selectedStep.model_config || '{}');
                            config.temperature = parseFloat(e.target.value);
                            updateStep(selectedStepIndex!, { model_config: JSON.stringify(config) });
                          }}
                        />
                        <Input
                          label={t('maxTokens')}
                          type="number"
                          min="100"
                          max="100000"
                          step="100"
                          value={JSON.parse(selectedStep.model_config || '{}').maxTokens || 2000}
                          onChange={(e) => {
                            const config = JSON.parse(selectedStep.model_config || '{}');
                            config.maxTokens = parseInt(e.target.value);
                            updateStep(selectedStepIndex!, { model_config: JSON.stringify(config) });
                          }}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  /* Dynamic executor config (script, http, transform, etc.) */
                  <ExecutorConfigFields
                    stepType={selectedStep.step_type!}
                    executors={executors}
                    executorConfig={selectedStep.executor_config || '{}'}
                    onConfigChange={(config) => updateStep(selectedStepIndex!, { executor_config: config })}
                  />
                )}
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody className="text-center py-12">
                <p className="text-secondary-600">
                  {t('selectStepToEdit')}
                </p>
              </CardBody>
            </Card>
          )}
        </div>
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

      {/* Template Selector Modal */}
      <Modal
        isOpen={showStepSelector}
        onClose={() => setShowStepSelector(false)}
        title="Select Skill Step"
        size="lg"
      >
        <p className="text-sm text-secondary-600 mb-4">Choose a skill step to add into this workflow.</p>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {availableSkills.length === 0 ? (
            <p className="text-secondary-600 text-center py-4">
              No skills available. Create a skill first.
            </p>
          ) : (
            availableSkills.map((skill) => {
              const step = skill.steps?.[0];
              if (!step) return null;
              const execInfo = getExecutorInfo(step.step_type);
              return (
                <div
                  key={skill.id}
                  className="border border-secondary-200 rounded-lg p-4 hover:bg-secondary-50 cursor-pointer flex items-center justify-between"
                  onClick={() => addSkillStep(step)}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{execInfo?.icon || '🤖'}</span>
                      <h3 className="font-semibold text-secondary-900">{skill.name}</h3>
                      <span className="text-xs px-2 py-0.5 rounded bg-secondary-100 text-secondary-600">
                        {step.step_type === 'ai'
                          ? models.find(m => m.id === step.ai_model)?.name || step.ai_model
                          : execInfo?.displayName || step.step_type}
                      </span>
                    </div>
                    {skill.description && (
                      <p className="text-sm text-secondary-600 mt-1">{skill.description}</p>
                    )}
                  </div>
                  <Button size="sm" variant="secondary">
                    {t('add')}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </Modal>
    </div>
  );
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

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}
