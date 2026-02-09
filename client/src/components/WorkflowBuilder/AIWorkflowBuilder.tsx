import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import api, {
  AssistantMessage,
  AssistantResponse,
  GeneratedWorkflow,
  GeneratedStep,
} from '../../services/api';

// Step type icons (matching the server executor registry)
const STEP_TYPE_ICONS: Record<string, string> = {
  ai: '\uD83E\uDDE0',
  scraping: '\uD83D\uDD0D',
  script: '\uD83D\uDCDC',
  http: '\uD83C\uDF10',
  transform: '\uD83D\uDD04',
  browser: '\uD83D\uDDA5\uFE0F',
};

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  workflow?: GeneratedWorkflow;
  suggestions?: string[];
}

export function AIWorkflowBuilder() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentWorkflow, setCurrentWorkflow] = useState<GeneratedWorkflow | null>(null);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      // Build the message history for the API (only role + content)
      const apiMessages: AssistantMessage[] = updatedMessages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      const response: AssistantResponse = await api.assistantGenerate(apiMessages);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message,
        workflow: response.workflow,
        suggestions: response.suggestions,
      };

      setMessages(prev => [...prev, assistantMessage]);

      if (response.workflow) {
        setCurrentWorkflow(response.workflow);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to generate response');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
    inputRef.current?.focus();
  };

  const handleSave = async (asTemplate: boolean) => {
    if (!currentWorkflow) return;

    setIsSaving(true);
    setError(null);

    try {
      const result = await api.assistantSave(currentWorkflow, asTemplate);
      navigate(`/recipes/${result.recipeId}`);
    } catch (err: any) {
      setError(err.message || 'Failed to save workflow');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateStep = (index: number, updates: Partial<GeneratedStep>) => {
    if (!currentWorkflow) return;
    const newSteps = [...currentWorkflow.steps];
    newSteps[index] = { ...newSteps[index], ...updates };
    setCurrentWorkflow({ ...currentWorkflow, steps: newSteps });
  };

  const handleRemoveStep = (index: number) => {
    if (!currentWorkflow) return;
    const newSteps = currentWorkflow.steps.filter((_, i) => i !== index);
    setCurrentWorkflow({ ...currentWorkflow, steps: newSteps });
  };

  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    if (!currentWorkflow) return;
    const newSteps = [...currentWorkflow.steps];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= newSteps.length) return;
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    setCurrentWorkflow({ ...currentWorkflow, steps: newSteps });
  };

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">{t('aiWorkflowBuilder')}</h1>
          <p className="text-secondary-600 text-sm">{t('aiWorkflowBuilderDescription')}</p>
        </div>
        <Button variant="ghost" onClick={() => navigate('/')}>
          {t('backToDashboard')}
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            &times;
          </button>
        </div>
      )}

      {/* Main split layout */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left: Chat Panel */}
        <div className="flex-1 flex flex-col min-w-0">
          <Card className="flex-1 flex flex-col min-h-0">
            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="text-center py-12">
                  <div className="text-4xl mb-4">{'\uD83E\uDD16'}</div>
                  <h3 className="text-lg font-semibold text-secondary-900 mb-2">
                    {t('aiBuilderWelcome')}
                  </h3>
                  <p className="text-secondary-600 text-sm max-w-md mx-auto mb-6">
                    {t('aiBuilderWelcomeDescription')}
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {[
                      t('aiBuilderExample1'),
                      t('aiBuilderExample2'),
                      t('aiBuilderExample3'),
                    ].map((example, i) => (
                      <button
                        key={i}
                        onClick={() => handleSuggestionClick(example)}
                        className="px-3 py-2 text-sm bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100 transition-colors text-left"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-4 py-3 ${
                      msg.role === 'user'
                        ? 'bg-primary-600 text-white'
                        : 'bg-secondary-100 text-secondary-900'
                    }`}
                  >
                    <div className="whitespace-pre-wrap text-sm">{msg.content}</div>

                    {msg.suggestions && msg.suggestions.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-secondary-200">
                        <p className="text-xs text-secondary-500 mb-2">{t('suggestions')}:</p>
                        <div className="flex flex-wrap gap-1">
                          {msg.suggestions.map((s, j) => (
                            <button
                              key={j}
                              onClick={() => handleSuggestionClick(s)}
                              className="px-2 py-1 text-xs bg-white text-secondary-700 rounded border border-secondary-200 hover:bg-secondary-50"
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-secondary-100 rounded-lg px-4 py-3">
                    <div className="flex items-center space-x-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600"></div>
                      <span className="text-sm text-secondary-600">{t('aiThinking')}</span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="border-t border-secondary-200 p-4">
              <div className="flex gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t('aiBuilderPlaceholder')}
                  className="flex-1 resize-none rounded-lg border border-secondary-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  rows={2}
                  disabled={isLoading}
                />
                <Button
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading}
                  isLoading={isLoading}
                  className="self-end"
                >
                  {t('send')}
                </Button>
              </div>
            </div>
          </Card>
        </div>

        {/* Right: Workflow Preview */}
        <div className="w-96 flex flex-col min-h-0">
          <Card className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-secondary-200 flex items-center justify-between">
              <h3 className="font-semibold text-secondary-900">{t('workflowPreview')}</h3>
              {currentWorkflow && (
                <span className="text-xs text-secondary-500">
                  {currentWorkflow.steps.length} {t('steps')}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {!currentWorkflow ? (
                <div className="text-center py-12">
                  <div className="text-3xl mb-3 opacity-40">{'\uD83D\uDCCB'}</div>
                  <p className="text-sm text-secondary-500">{t('noWorkflowYet')}</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Workflow name and description */}
                  <div>
                    <input
                      type="text"
                      value={currentWorkflow.name}
                      onChange={e =>
                        setCurrentWorkflow({ ...currentWorkflow, name: e.target.value })
                      }
                      className="w-full font-semibold text-secondary-900 bg-transparent border-b border-transparent hover:border-secondary-300 focus:border-primary-500 focus:outline-none px-1 py-0.5"
                    />
                    <textarea
                      value={currentWorkflow.description}
                      onChange={e =>
                        setCurrentWorkflow({ ...currentWorkflow, description: e.target.value })
                      }
                      className="w-full text-sm text-secondary-600 bg-transparent border-b border-transparent hover:border-secondary-300 focus:border-primary-500 focus:outline-none px-1 py-0.5 resize-none mt-1"
                      rows={2}
                    />
                  </div>

                  {/* Required inputs */}
                  {currentWorkflow.requiredInputs.length > 0 && (
                    <div className="bg-blue-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-blue-700 mb-1">{t('requiredInputs')}:</p>
                      <div className="space-y-1">
                        {currentWorkflow.requiredInputs.map((inp, i) => (
                          <div key={i} className="text-xs text-blue-600">
                            <span className="font-mono">{`{{${inp.name}}}`}</span>
                            <span className="text-blue-400 ml-1">({inp.type})</span>
                            {inp.description && (
                              <span className="text-blue-400 ml-1">- {inp.description}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Steps */}
                  <div className="space-y-2">
                    {currentWorkflow.steps.map((step, index) => (
                      <StepCard
                        key={index}
                        step={step}
                        index={index}
                        isEditing={editingStep === index}
                        onToggleEdit={() =>
                          setEditingStep(editingStep === index ? null : index)
                        }
                        onUpdate={updates => handleUpdateStep(index, updates)}
                        onRemove={() => handleRemoveStep(index)}
                        onMoveUp={() => handleMoveStep(index, 'up')}
                        onMoveDown={() => handleMoveStep(index, 'down')}
                        isFirst={index === 0}
                        isLast={index === currentWorkflow.steps.length - 1}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Save buttons */}
            {currentWorkflow && (
              <div className="border-t border-secondary-200 p-4 space-y-2">
                <Button
                  className="w-full"
                  onClick={() => handleSave(false)}
                  isLoading={isSaving}
                  disabled={isSaving}
                >
                  {t('saveAsRecipe')}
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => handleSave(true)}
                  isLoading={isSaving}
                  disabled={isSaving}
                >
                  {t('saveAsTemplate')}
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// Step card component
interface StepCardProps {
  step: GeneratedStep;
  index: number;
  isEditing: boolean;
  onToggleEdit: () => void;
  onUpdate: (updates: Partial<GeneratedStep>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
  t: (key: any) => string;
}

function StepCard({
  step,
  index,
  isEditing,
  onToggleEdit,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  t,
}: StepCardProps) {
  const icon = STEP_TYPE_ICONS[step.step_type] || '\u2699\uFE0F';

  return (
    <div className="border border-secondary-200 rounded-lg overflow-hidden">
      {/* Step header */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-secondary-50 cursor-pointer hover:bg-secondary-100"
        onClick={onToggleEdit}
      >
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-medium text-secondary-500">
          {index + 1}.
        </span>
        <span className="text-sm font-medium text-secondary-900 flex-1 truncate">
          {step.step_name}
        </span>
        <span className="text-xs text-secondary-400">{step.step_type}</span>
        <div className="flex items-center gap-1">
          {!isFirst && (
            <button
              onClick={e => {
                e.stopPropagation();
                onMoveUp();
              }}
              className="text-secondary-400 hover:text-secondary-600 text-xs"
              title="Move up"
            >
              {'\u25B2'}
            </button>
          )}
          {!isLast && (
            <button
              onClick={e => {
                e.stopPropagation();
                onMoveDown();
              }}
              className="text-secondary-400 hover:text-secondary-600 text-xs"
              title="Move down"
            >
              {'\u25BC'}
            </button>
          )}
          <button
            onClick={e => {
              e.stopPropagation();
              onRemove();
            }}
            className="text-red-400 hover:text-red-600 text-xs ml-1"
            title="Remove"
          >
            {'\u2715'}
          </button>
        </div>
      </div>

      {/* Step details (when editing) */}
      {isEditing && (
        <div className="p-3 space-y-3 text-sm">
          <div>
            <label className="block text-xs font-medium text-secondary-500 mb-1">
              {t('stepName')}
            </label>
            <input
              type="text"
              value={step.step_name}
              onChange={e => onUpdate({ step_name: e.target.value })}
              className="w-full border border-secondary-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>

          {step.step_type === 'ai' && (
            <>
              <div>
                <label className="block text-xs font-medium text-secondary-500 mb-1">
                  {t('aiModel')}
                </label>
                <input
                  type="text"
                  value={step.ai_model}
                  onChange={e => onUpdate({ ai_model: e.target.value })}
                  className="w-full border border-secondary-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary-500 mb-1">
                  {t('promptTemplate')}
                </label>
                <textarea
                  value={step.prompt_template}
                  onChange={e => onUpdate({ prompt_template: e.target.value })}
                  className="w-full border border-secondary-300 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
                  rows={4}
                />
              </div>
            </>
          )}

          {step.step_type !== 'ai' && step.executor_config && (
            <div>
              <label className="block text-xs font-medium text-secondary-500 mb-1">
                {t('executorConfig')}
              </label>
              <textarea
                value={JSON.stringify(step.executor_config, null, 2)}
                onChange={e => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    onUpdate({ executor_config: parsed });
                  } catch {
                    // Don't update if invalid JSON
                  }
                }}
                className="w-full border border-secondary-300 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
                rows={4}
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-secondary-500 mb-1">
              {t('outputFormat')}
            </label>
            <select
              value={step.output_format}
              onChange={e =>
                onUpdate({ output_format: e.target.value as GeneratedStep['output_format'] })
              }
              className="w-full border border-secondary-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="text">Text</option>
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
              <option value="image">Image</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
