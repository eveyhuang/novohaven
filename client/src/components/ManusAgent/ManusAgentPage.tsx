import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { WorkflowDefinition, WorkflowStep, TemplateInputConfig, InputTypeConfig } from '../../types';
import api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';

// System variables that shouldn't be treated as user inputs
const SYSTEM_VARIABLES = [
  'company_voice', 'company_platform', 'company_image', 'voice_guidelines',
  'brand_voice', 'amazon_requirements', 'image_style_guidelines',
  'social_media_guidelines', 'platform_requirements', 'tone_guidelines', 'content_guidelines'
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
  const navigate = useNavigate();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skill state
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState<WorkflowDefinition[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<WorkflowDefinition | null>(null);
  const [selectedStep, setSelectedStep] = useState<WorkflowStep | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});

  useEffect(() => {
    api.getScrapingStatus()
      .then((status) => setConfigured(status.manus_configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (showSkills && skills.length === 0) {
      loadSkills();
    }
  }, [showSkills]);

  const loadSkills = async () => {
    try {
      const allSkills = await api.getSkills();
      const detailed = await Promise.all(
        allSkills.map(async (s) => {
          try { return await api.getSkill(s.id); } catch { return s; }
        })
      );
      setSkills(detailed.filter((s) => s.steps?.[0]?.step_type === 'manus'));
    } catch (err) {
      console.error('Failed to load manus skills:', err);
    }
  };

  const selectSkill = (skill: WorkflowDefinition) => {
    const step = skill.steps?.[0];
    setSelectedSkill(skill);
    setSelectedStep(step || null);
    setVariableValues({});
    setError(null);
  };

  const skillVariables = useMemo(() => {
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

  // Submit freeform prompt -> create execution -> redirect
  const handleSubmit = async () => {
    if (!prompt.trim() || starting) return;

    setStarting(true);
    setError(null);
    try {
      const result = await api.startQuickExecution('manus', prompt.trim());
      if (result.executionId) {
        navigate(`/executions/${result.executionId}`);
      } else {
        setError(result.error || 'Failed to create execution');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start task');
    } finally {
      setStarting(false);
    }
  };

  // Submit from skill -> create execution and redirect
  const handleRunSkill = async () => {
    if (!selectedSkill || starting) return;

    const missing = skillVariables.filter(
      (v) => !variableValues[v] || !variableValues[v].trim()
    );
    if (missing.length > 0) {
      setError(t('manusTemplate.fillVariables') + ': ' + missing.join(', '));
      return;
    }

    setStarting(true);
    setError(null);
    try {
      const result = await api.startSkillExecution(
        selectedSkill.id,
        variableValues
      );
      if (result.executionId) {
        navigate(`/executions/${result.executionId}`);
      } else {
        setError(result.error || 'Failed to create execution');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start skill task');
    } finally {
      setStarting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (configured === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
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
              onClick={() => setShowSkills(!showSkills)}
              className={`inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                showSkills
                  ? 'bg-purple-100 text-purple-700 border border-purple-300'
                  : 'bg-secondary-100 text-secondary-700 border border-secondary-300 hover:bg-secondary-200'
              }`}
            >
              <SkillIcon className="w-4 h-4 mr-1.5" />
              Skills
            </button>
          )}
          <StatusBadge configured={configured} t={t} />
        </div>
      </div>

      {/* Main content */}
      {configured ? (
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Skill Sidebar */}
          {showSkills && (
            <div className="w-80 flex-shrink-0 flex flex-col border border-secondary-200 rounded-lg bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-secondary-200 bg-secondary-50">
                <h3 className="font-semibold text-secondary-900 text-sm">Saved Skills</h3>
              </div>
              <div className="flex-1 overflow-y-auto">
                {skills.length === 0 ? (
                  <div className="p-4 text-center text-secondary-500 text-sm">
                    <p>No Manus skills yet</p>
                    <p className="mt-1 text-xs">Create a skill with a Manus step to use it here.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-secondary-100">
                    {skills.map((skill) => (
                      <button
                        key={skill.id}
                        onClick={() => selectSkill(skill)}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          selectedSkill?.id === skill.id
                            ? 'bg-purple-50 border-l-2 border-purple-500'
                            : 'hover:bg-secondary-50'
                        }`}
                      >
                        <div className="font-medium text-sm text-secondary-900">{skill.name}</div>
                        {skill.description && (
                          <div className="text-xs text-secondary-500 mt-0.5 line-clamp-2">{skill.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Variable Form */}
              {selectedSkill && selectedStep && (
                <div className="border-t border-secondary-200 bg-secondary-50 p-4 space-y-3 max-h-[50%] overflow-y-auto">
                  <h4 className="font-medium text-sm text-secondary-900">
                    {selectedSkill.name}
                  </h4>
                  {skillVariables.length > 0 ? (
                    skillVariables.map((varName) => {
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
                    })
                  ) : (
                    <p className="text-xs text-secondary-500">{t('manusTemplate.noVariables')}</p>
                  )}

                  {error && (
                    <div className="text-xs text-red-600 bg-red-50 rounded px-2 py-1.5">{error}</div>
                  )}

                  <button
                    onClick={handleRunSkill}
                    disabled={starting}
                    className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {starting ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                        {t('manusTemplate.starting')}
                      </>
                    ) : (
                      <>
                        <PlayIcon className="w-4 h-4" />
                        Run Skill
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Freeform prompt area */}
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center border border-secondary-200 rounded-lg bg-white p-8">
            <div className="w-full max-w-xl space-y-4">
              <div className="text-center mb-6">
                <div className="w-14 h-14 mx-auto mb-3 bg-purple-100 rounded-full flex items-center justify-center text-2xl">
                  &#129504;
                </div>
                <h2 className="text-lg font-semibold text-secondary-900">
                  What should Manus do?
                </h2>
                <p className="text-sm text-secondary-500 mt-1">
                  Describe a task and Manus will execute it autonomously.
                </p>
              </div>

              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g., Scrape the top 10 products from Amazon for wireless headphones and create a comparison table..."
                rows={4}
                disabled={starting}
                className="w-full px-4 py-3 text-sm border border-secondary-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none disabled:bg-secondary-50"
              />

              {error && !selectedSkill && (
                <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
              )}

              <button
                onClick={handleSubmit}
                disabled={!prompt.trim() || starting}
                className="w-full px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {starting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    Starting...
                  </>
                ) : (
                  <>
                    <PlayIcon className="w-4 h-4" />
                    Start Task
                  </>
                )}
              </button>
            </div>
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
        configured ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${configured ? 'bg-green-500' : 'bg-red-500'}`} />
      {configured ? t('manusChat.ready') : t('notConfigured')}
    </span>
  );
}

function SkillIcon({ className }: { className?: string }) {
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
