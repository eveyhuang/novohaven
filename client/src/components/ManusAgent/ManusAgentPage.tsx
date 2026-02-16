import React, { useState, useEffect, useMemo } from 'react';
import { ManusChat } from '../ManusChat/ManusChat';
import { ManusFile, Recipe, RecipeStep, TemplateInputConfig, InputTypeConfig } from '../../types';
import api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';

// System variables that shouldn't be treated as user inputs
const SYSTEM_VARIABLES = [
  'brand_voice', 'amazon_requirements', 'image_style_guidelines',
  'social_media_guidelines', 'platform_requirements', 'tone_guidelines'
];

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

export function ManusAgentPage() {
  const { t } = useLanguage();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<Recipe[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<Recipe | null>(null);
  const [selectedStep, setSelectedStep] = useState<RecipeStep | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [manusKey, setManusKey] = useState(0);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);
  const [isStartingTemplate, setIsStartingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  useEffect(() => {
    api.getScrapingStatus()
      .then((status) => setConfigured(status.manus_configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (showTemplates && templates.length === 0) {
      loadTemplates();
    }
  }, [showTemplates]);

  const loadTemplates = async () => {
    try {
      const allRecipes = await api.getRecipes();
      // Filter to templates that have manus steps
      const manusTemplates = allRecipes.filter((r) => r.is_template);
      // Load full details for each to check step_type
      const detailed = await Promise.all(
        manusTemplates.map(async (r) => {
          try {
            const full = await api.getRecipe(r.id);
            return full;
          } catch {
            return r;
          }
        })
      );
      const filtered = detailed.filter((r) => {
        const step = r.steps?.[0];
        return step && step.step_type === 'manus';
      });
      setTemplates(filtered);
    } catch (err) {
      console.error('Failed to load manus templates:', err);
    }
  };

  const selectTemplate = (template: Recipe) => {
    const step = template.steps?.[0];
    setSelectedTemplate(template);
    setSelectedStep(step || null);
    setVariableValues({});
    setTemplateError(null);
  };

  const templateVariables = useMemo(() => {
    if (!selectedStep?.prompt_template) return [];
    return extractInputsFromPrompt(selectedStep.prompt_template);
  }, [selectedStep]);

  const getInputConfig = (varName: string): InputTypeConfig => {
    try {
      if (!selectedStep?.input_config) return { type: 'text' };
      const config: TemplateInputConfig = JSON.parse(selectedStep.input_config);
      return config.variables?.[varName] || { type: 'text' };
    } catch {
      return { type: 'text' };
    }
  };

  const handleRunTemplate = async () => {
    if (!selectedTemplate || !selectedStep) return;

    // Validate required variables are filled
    const missing = templateVariables.filter(
      (v) => !variableValues[v] || !variableValues[v].trim()
    );
    if (missing.length > 0) {
      setTemplateError(t('manusTemplate.fillVariables') + ': ' + missing.join(', '));
      return;
    }

    setIsStartingTemplate(true);
    setTemplateError(null);

    try {
      const result = await api.startManusTaskFromTemplate(selectedTemplate.id, variableValues);
      // Remount ManusChat with the compiled prompt and let it auto-start
      setInitialPrompt(result.compiledPrompt);
      setManusKey((k) => k + 1);
    } catch (err: any) {
      setTemplateError(err.message || 'Failed to start template task');
    } finally {
      setIsStartingTemplate(false);
    }
  };

  const handleComplete = (result: { output: string; files?: ManusFile[]; creditsUsed?: number }) => {
    console.log('[ManusAgent] Task completed', result);
  };

  if (configured === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">{t('manusAgent.title')}</h1>
          <p className="text-secondary-600 mt-1">{t('manusAgent.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {configured && (
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className={`inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                showTemplates
                  ? 'bg-purple-100 text-purple-700 border border-purple-300'
                  : 'bg-secondary-100 text-secondary-700 border border-secondary-300 hover:bg-secondary-200'
              }`}
            >
              <TemplateIcon className="w-4 h-4 mr-1.5" />
              {t('manusTemplate.templates')}
            </button>
          )}
          <StatusBadge configured={configured} t={t} />
        </div>
      </div>

      {/* Main content */}
      {configured ? (
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Template Sidebar */}
          {showTemplates && (
            <div className="w-80 flex-shrink-0 flex flex-col border border-secondary-200 rounded-lg bg-white overflow-hidden">
              {/* Sidebar Header */}
              <div className="px-4 py-3 border-b border-secondary-200 bg-secondary-50">
                <h3 className="font-semibold text-secondary-900 text-sm">{t('manusTemplate.savedTemplates')}</h3>
              </div>

              {/* Template List */}
              <div className="flex-1 overflow-y-auto">
                {templates.length === 0 ? (
                  <div className="p-4 text-center text-secondary-500 text-sm">
                    <p>{t('manusTemplate.noTemplates')}</p>
                    <p className="mt-1 text-xs">{t('manusTemplate.createHint')}</p>
                  </div>
                ) : (
                  <div className="divide-y divide-secondary-100">
                    {templates.map((tmpl) => (
                      <button
                        key={tmpl.id}
                        onClick={() => selectTemplate(tmpl)}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          selectedTemplate?.id === tmpl.id
                            ? 'bg-purple-50 border-l-2 border-purple-500'
                            : 'hover:bg-secondary-50'
                        }`}
                      >
                        <div className="font-medium text-sm text-secondary-900">{tmpl.name}</div>
                        {tmpl.description && (
                          <div className="text-xs text-secondary-500 mt-0.5 line-clamp-2">{tmpl.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Variable Form (when template selected) */}
              {selectedTemplate && selectedStep && (
                <div className="border-t border-secondary-200 bg-secondary-50 p-4 space-y-3 max-h-[50%] overflow-y-auto">
                  <h4 className="font-medium text-sm text-secondary-900">
                    {selectedTemplate.name}
                  </h4>

                  {templateVariables.length > 0 ? (
                    <>
                      {templateVariables.map((varName) => {
                        const config = getInputConfig(varName);
                        return (
                          <div key={varName}>
                            <label className="block text-xs font-medium text-secondary-700 mb-1">
                              {config.label || varName}
                            </label>
                            {config.type === 'textarea' ? (
                              <textarea
                                value={variableValues[varName] || ''}
                                onChange={(e) =>
                                  setVariableValues({ ...variableValues, [varName]: e.target.value })
                                }
                                placeholder={config.placeholder || varName}
                                rows={3}
                                className="w-full px-2.5 py-1.5 text-sm border border-secondary-300 rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                              />
                            ) : (
                              <input
                                type="text"
                                value={variableValues[varName] || ''}
                                onChange={(e) =>
                                  setVariableValues({ ...variableValues, [varName]: e.target.value })
                                }
                                placeholder={config.placeholder || varName}
                                className="w-full px-2.5 py-1.5 text-sm border border-secondary-300 rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                              />
                            )}
                            {config.description && (
                              <p className="text-xs text-secondary-400 mt-0.5">{config.description}</p>
                            )}
                          </div>
                        );
                      })}
                    </>
                  ) : (
                    <p className="text-xs text-secondary-500">{t('manusTemplate.noVariables')}</p>
                  )}

                  {templateError && (
                    <div className="text-xs text-red-600 bg-red-50 rounded px-2 py-1.5">{templateError}</div>
                  )}

                  <button
                    onClick={handleRunTemplate}
                    disabled={isStartingTemplate}
                    className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {isStartingTemplate ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                        {t('manusTemplate.starting')}
                      </>
                    ) : (
                      <>
                        <PlayIcon className="w-4 h-4" />
                        {t('manusTemplate.runWithTemplate')}
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ManusChat (main area) */}
          <div className="flex-1 min-h-0">
            <ManusChat
              key={manusKey}
              showPromptInput={true}
              standalone={true}
              initialPrompt={initialPrompt}
              onComplete={handleComplete}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 mx-auto mb-4 bg-secondary-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-secondary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <p className="text-secondary-600 text-sm">{t('manusAgent.notConfigured')}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ configured, t }: { configured: boolean; t: (key: any) => string }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        configured
          ? 'bg-green-100 text-green-800'
          : 'bg-red-100 text-red-800'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${configured ? 'bg-green-500' : 'bg-red-500'}`} />
      {configured ? t('manusChat.ready') : t('notConfigured')}
    </span>
  );
}

function TemplateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
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

export default ManusAgentPage;
