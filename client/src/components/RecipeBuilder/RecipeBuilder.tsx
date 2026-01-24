import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Recipe, RecipeStep, AIModel } from '../../types';
import api from '../../services/api';
import { Button, Input, TextArea, Select, Card, CardBody, CardHeader, Modal } from '../common';
import { useLanguage } from '../../context/LanguageContext';

// Extract user input variables from a single prompt template (excludes step outputs and company standards)
function extractInputsFromPrompt(promptTemplate: string): string[] {
  const variables: string[] = [];
  const matches = promptTemplate.match(/\{\{([^}]+)\}\}/g) || [];
  matches.forEach((match) => {
    const varName = match.replace(/\{\{|\}\}/g, '').trim();
    // Exclude step outputs (step_N_output) and common company standards
    if (!varName.match(/^step_\d+_output$/) &&
        !['brand_voice', 'amazon_requirements', 'image_style_guidelines', 'social_media_guidelines'].includes(varName)) {
      if (!variables.includes(varName)) {
        variables.push(varName);
      }
    }
  });
  return variables;
}

// Extract user input variables from all steps
function extractRequiredInputs(steps: RecipeStep[]): string[] {
  const allVariables = new Set<string>();

  steps.forEach((step) => {
    extractInputsFromPrompt(step.prompt_template).forEach((varName) => {
      allVariables.add(varName);
    });
  });

  return Array.from(allVariables).sort();
}


export function RecipeBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  // Check if this is a new recipe: either no id param or id is 'new'
  const isNew = !id || id === 'new';

  const [recipe, setRecipe] = useState<Partial<Recipe>>({
    name: '',
    description: '',
    steps: [],
    is_template: false,
  });
  const [models, setModels] = useState<AIModel[]>([]);
  const [templateRecipes, setTemplateRecipes] = useState<Recipe[]>([]);
  const [isLoading, setIsLoading] = useState(!isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);
  const [showVariableHelp, setShowVariableHelp] = useState(false);
  const [showStepSelector, setShowStepSelector] = useState(false);

  // Compute required inputs from all steps
  const requiredInputs = useMemo(() => {
    return extractRequiredInputs((recipe.steps || []) as RecipeStep[]);
  }, [recipe.steps]);

  useEffect(() => {
    loadModels();
    loadTemplates();
    if (!isNew && id) {
      loadRecipe(parseInt(id));
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

  const loadTemplates = async () => {
    try {
      const recipes = await api.getRecipes();
      const templates = recipes.filter(r => r.is_template);
      // Load steps for each template
      const templatesWithSteps = await Promise.all(
        templates.map(async (template) => {
          const fullRecipe = await api.getRecipe(template.id);
          return fullRecipe;
        })
      );
      setTemplateRecipes(templatesWithSteps);
    } catch (err: any) {
      console.error('Failed to load templates:', err);
    }
  };

  const loadRecipe = async (recipeId: number) => {
    setIsLoading(true);
    try {
      const data = await api.getRecipe(recipeId);
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

  const handleSave = async () => {
    if (!recipe.name) {
      setError(t('recipeNameRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const steps = (recipe.steps || []).map((step, index) => ({
        ...step,
        step_order: index + 1,
      }));

      if (isNew) {
        const created = await api.createRecipe({
          name: recipe.name,
          description: recipe.description,
          steps,
          is_template: false,
        });
        navigate(`/recipes/${created.id}`);
      } else if (id) {
        await api.updateRecipe(parseInt(id), {
          name: recipe.name,
          description: recipe.description,
          steps,
          is_template: false,
        });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const addStep = () => {
    setShowStepSelector(true);
  };

  const addTemplateStep = (templateStep: RecipeStep) => {
    const newStep: RecipeStep = {
      ...templateStep,
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

  const updateStep = (index: number, updates: Partial<RecipeStep>) => {
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
            <Button variant="secondary" onClick={() => navigate(`/recipes/${id}/run`)}>
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
                          ? step.step_type === 'scraping' ? 'bg-blue-50' : 'bg-primary-50'
                          : 'hover:bg-secondary-50'
                      }`}
                      onClick={() => setSelectedStepIndex(index)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          {step.step_type === 'scraping' && (
                            <span className="text-lg">🔍</span>
                          )}
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
                        {step.step_type === 'scraping'
                          ? 'BrightData Scraping'
                          : models.find(m => m.id === step.ai_model)?.name || step.ai_model}
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

                {/* Scraping Step UI */}
                {selectedStep.step_type === 'scraping' ? (
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
                      {selectedStep.api_config && (() => {
                        try {
                          const apiConfig = JSON.parse(selectedStep.api_config);
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

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <h5 className="text-sm font-medium text-yellow-800 mb-2">Input Options</h5>
                      <ul className="text-sm text-yellow-700 space-y-1">
                        <li>• Enter product URLs (one per line) to scrape reviews</li>
                        <li>• Upload CSV files with existing review data</li>
                        <li>• Combine both methods for comprehensive data</li>
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
                ) : (
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
        title={t('selectTemplateStep')}
        size="lg"
      >
        <p className="text-sm text-secondary-600 mb-4">{t('selectTemplateDesc')}</p>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {templateRecipes.length === 0 ? (
            <p className="text-secondary-600 text-center py-4">
              {t('noTemplatesAvailable')}
            </p>
          ) : (
            templateRecipes.map((template) => {
              const step = template.steps?.[0];
              if (!step) return null;
              const isScraping = step.step_type === 'scraping';
              return (
                <div
                  key={template.id}
                  className={`border rounded-lg p-4 hover:bg-secondary-50 cursor-pointer flex items-center justify-between ${
                    isScraping ? 'border-blue-200 bg-blue-50/30' : 'border-secondary-200'
                  }`}
                  onClick={() => addTemplateStep(step)}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {isScraping && <span className="text-lg">🔍</span>}
                      <h3 className="font-semibold text-secondary-900">{template.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        isScraping
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-secondary-100 text-secondary-600'
                      }`}>
                        {isScraping
                          ? 'BrightData Scraping'
                          : models.find(m => m.id === step.ai_model)?.name || step.ai_model}
                      </span>
                    </div>
                    {template.description && (
                      <p className="text-sm text-secondary-600 mt-1">{template.description}</p>
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
