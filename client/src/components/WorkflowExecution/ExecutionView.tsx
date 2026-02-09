import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { WorkflowExecution, StepExecution, GeneratedImage } from '../../types';
import api from '../../services/api';
import { Button, Card, CardBody, CardHeader, Modal, TextArea, TranslatedText } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { ReviewAnalysisDisplay } from '../ReviewAnalysis';

export function ExecutionView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<StepExecution | null>(null);
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (id) {
      loadExecution(parseInt(id));
    }
  }, [id]);

  // Auto-refresh polling for in-progress executions
  useEffect(() => {
    if (!execution || !autoRefresh) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    // Only poll if execution is running or pending
    const shouldPoll = ['running', 'pending'].includes(execution.status);

    if (!shouldPoll) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    // Set up polling every 3 seconds
    pollingRef.current = setInterval(async () => {
      try {
        const data = await api.getExecution(parseInt(id!));
        setExecution(data);

        // Update selected step if needed
        const currentStep = data.step_executions?.find(
          (se) => se.status === 'awaiting_review'
        );
        if (currentStep && (!selectedStep || selectedStep.id !== currentStep.id)) {
          setSelectedStep(currentStep);
        } else if (data.step_executions?.length && !currentStep) {
          const lastStep = data.step_executions[data.step_executions.length - 1];
          if (!selectedStep || selectedStep.id !== lastStep.id || selectedStep.status !== lastStep.status) {
            setSelectedStep(lastStep);
          }
        }
      } catch (err) {
        console.error('Error polling execution:', err);
      }
    }, 3000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [execution?.status, autoRefresh, id]);

  const loadExecution = async (executionId: number) => {
    setIsLoading(true);
    try {
      const data = await api.getExecution(executionId);
      setExecution(data);

      // Auto-select the current step being reviewed
      const reviewStep = data.step_executions?.find(
        (se) => se.status === 'awaiting_review'
      );
      if (reviewStep) {
        setSelectedStep(reviewStep);
      } else if (data.step_executions?.length) {
        setSelectedStep(data.step_executions[data.step_executions.length - 1]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApprove = async (stepExecution: StepExecution) => {
    if (!execution) return;
    setActionLoading(`approve-${stepExecution.id}`);
    try {
      await api.approveStep(execution.id, stepExecution.id);
      await loadExecution(execution.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (stepExecution: StepExecution) => {
    if (!execution) return;
    setActionLoading(`reject-${stepExecution.id}`);
    try {
      await api.rejectStep(execution.id, stepExecution.id);
      await loadExecution(execution.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async () => {
    if (!execution || !selectedStep) return;
    setActionLoading(`retry-${selectedStep.id}`);
    setShowPromptModal(false);
    try {
      await api.retryStep(
        execution.id,
        selectedStep.id,
        editedPrompt || undefined
      );
      await loadExecution(execution.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const openPromptEditor = (step: StepExecution) => {
    setSelectedStep(step);
    setEditedPrompt(step.prompt_used || '');
    setShowPromptModal(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!execution) {
    return (
      <div className="text-center py-12">
        <p className="text-secondary-600">Execution not found</p>
        <Button onClick={() => navigate('/executions')} className="mt-4">
          View All Executions
        </Button>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-secondary-100 text-secondary-700',
    running: 'bg-blue-100 text-blue-700',
    paused: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    awaiting_review: 'bg-purple-100 text-purple-700',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">
            <TranslatedText text={execution.recipe?.name || `Execution #${execution.id}`} />
          </h1>
          <div className="flex items-center space-x-3 mt-2">
            <span className={`px-3 py-1 text-sm font-medium rounded-full ${statusColors[execution.status]}`}>
              {execution.status}
            </span>
            <span className="text-secondary-500">
              Step {execution.current_step} of {execution.total_steps}
            </span>
            {['running', 'pending'].includes(execution.status) && (
              <label className="flex items-center space-x-2 text-sm text-secondary-600">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="rounded border-secondary-300 text-primary-600 focus:ring-primary-500"
                />
                <span>Auto-refresh</span>
              </label>
            )}
          </div>
        </div>
        <Button variant="ghost" onClick={() => navigate('/executions')}>
          Back to Executions
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-6">
        {/* Step List */}
        <div className="col-span-1">
          <Card>
            <CardHeader>
              <h2 className="font-semibold text-secondary-900">Steps</h2>
            </CardHeader>
            <CardBody className="p-0">
              <div className="divide-y divide-secondary-100">
                {execution.step_executions?.map((step) => (
                  <div
                    key={step.id}
                    className={`p-4 cursor-pointer transition-colors ${
                      selectedStep?.id === step.id
                        ? 'bg-primary-50'
                        : 'hover:bg-secondary-50'
                    }`}
                    onClick={() => setSelectedStep(step)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <StepStatusIcon status={step.status} />
                        <div>
                          <h4 className="font-medium text-secondary-900">
                            <TranslatedText text={step.step_name || ''} />
                          </h4>
                          <p className="text-sm text-secondary-500">
                            {step.ai_model_used || step.ai_model || 'AI'}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Step Output */}
        <div className="col-span-2">
          {selectedStep ? (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-secondary-900">
                    <TranslatedText text={selectedStep.step_name || ''} />
                  </h2>
                  <span className={`inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded ${statusColors[selectedStep.status]}`}>
                    {selectedStep.status}
                  </span>
                </div>
                {selectedStep.status === 'awaiting_review' && (
                  <div className="flex items-center space-x-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openPromptEditor(selectedStep)}
                    >
                      Edit Prompt
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleReject(selectedStep)}
                      isLoading={actionLoading === `reject-${selectedStep.id}`}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleApprove(selectedStep)}
                      isLoading={actionLoading === `approve-${selectedStep.id}`}
                    >
                      Approve
                    </Button>
                  </div>
                )}
                {selectedStep.status === 'failed' && (
                  <Button
                    size="sm"
                    onClick={() => openPromptEditor(selectedStep)}
                  >
                    Retry
                  </Button>
                )}
              </CardHeader>
              <CardBody>
                {selectedStep.status === 'pending' && (
                  <div className="text-center py-8 text-secondary-500">
                    This step hasn't been executed yet.
                  </div>
                )}
                {selectedStep.status === 'running' && (
                  <div className="text-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
                    <p className="text-secondary-500 mt-4">Processing...</p>
                  </div>
                )}
                {selectedStep.status === 'failed' && selectedStep.error_message && (
                  <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4">
                    {selectedStep.error_message}
                  </div>
                )}
                {(selectedStep.status === 'completed' ||
                  selectedStep.status === 'awaiting_review') &&
                  selectedStep.output && (
                    <div>
                      {/* Generated Images Display */}
                      {selectedStep.output.generatedImages && selectedStep.output.generatedImages.length > 0 && (
                        <div className="mb-6">
                          <h3 className="text-sm font-medium text-secondary-700 mb-3">{t('generatedImages')}</h3>
                          <div className="grid grid-cols-2 gap-4">
                            {selectedStep.output.generatedImages.map((image, index) => (
                              <div key={index} className="relative group">
                                <div className="bg-secondary-100 rounded-lg overflow-hidden border border-secondary-200">
                                  <img
                                    src={`data:${image.mimeType};base64,${image.base64}`}
                                    alt={`Generated image ${index + 1}`}
                                    className="w-full h-auto object-contain"
                                  />
                                </div>
                                <div className="absolute bottom-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => {
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
                                    className="px-3 py-1.5 bg-white/90 hover:bg-white text-secondary-700 text-sm rounded-lg shadow-sm flex items-center gap-1"
                                    title={t('viewFullSize')}
                                  >
                                    <ExpandIcon className="w-4 h-4" />
                                    {t('viewFullSize')}
                                  </button>
                                  <button
                                    onClick={() => {
                                      const link = document.createElement('a');
                                      link.href = `data:${image.mimeType};base64,${image.base64}`;
                                      link.download = `generated-image-${index + 1}.${image.mimeType.split('/')[1] || 'png'}`;
                                      document.body.appendChild(link);
                                      link.click();
                                      document.body.removeChild(link);
                                    }}
                                    className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg shadow-sm flex items-center gap-1"
                                    title={t('downloadImage')}
                                  >
                                    <DownloadIcon className="w-4 h-4" />
                                    {t('downloadImage')}
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

                      {/* Text Content Display */}
                      {selectedStep.output.content && (
                        <ReviewAwareContentDisplay
                          content={selectedStep.output.content}
                          stepName={selectedStep.step_name || ''}
                        />
                      )}
                    </div>
                  )}

                {/* Token Usage */}
                {selectedStep.output?.usage && (
                  <div className="mt-6 pt-4 border-t border-secondary-200 flex items-center space-x-4 text-sm text-secondary-500">
                    <span>Model: {selectedStep.output.model}</span>
                    <span>
                      Tokens: {selectedStep.output.usage.promptTokens} in /
                      {selectedStep.output.usage.completionTokens} out
                    </span>
                  </div>
                )}
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody className="text-center py-12">
                <p className="text-secondary-600">Select a step to view details</p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      {/* Prompt Editor Modal */}
      <Modal
        isOpen={showPromptModal}
        onClose={() => setShowPromptModal(false)}
        title="Edit Prompt"
        size="full"
      >
        <div className="space-y-4">
          <TextArea
            label="Prompt"
            value={editedPrompt}
            onChange={(e) => setEditedPrompt(e.target.value)}
            rows={15}
            className="font-mono text-sm"
          />
          <div className="flex justify-end space-x-3">
            <Button variant="ghost" onClick={() => setShowPromptModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRetry}
              isLoading={actionLoading?.startsWith('retry')}
            >
              Retry with Modified Prompt
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      );
    case 'running':
      return (
        <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center">
          <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      );
    case 'awaiting_review':
      return (
        <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center">
          <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        </div>
      );
    case 'failed':
      return (
        <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center">
          <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      );
    default:
      return (
        <div className="w-6 h-6 rounded-full bg-secondary-100 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-secondary-400"></div>
        </div>
      );
  }
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

// Component to detect and render review analysis content appropriately
function ReviewAwareContentDisplay({ content, stepName }: { content: string; stepName: string }) {
  const analysisType = useMemo(() => {
    const lowerName = stepName.toLowerCase();

    // Detect review analysis step types
    if (lowerName.includes('categorize') || lowerName.includes('categorization')) {
      return 'categorized';
    }
    if (lowerName.includes('positive') && lowerName.includes('analy')) {
      return 'positive';
    }
    if (lowerName.includes('negative') && lowerName.includes('analy')) {
      return 'negative';
    }
    if (lowerName.includes('summary') || lowerName.includes('executive')) {
      return 'summary';
    }

    return null;
  }, [stepName]);

  // Try to detect if content is JSON
  const isJson = useMemo(() => {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }, [content]);

  // Use specialized display for review analysis steps
  if (analysisType) {
    return <ReviewAnalysisDisplay data={content} type={analysisType} />;
  }

  // For JSON content, show formatted JSON with copy button
  if (isJson) {
    return (
      <div className="relative">
        <button
          onClick={() => navigator.clipboard.writeText(content)}
          className="absolute top-2 right-2 px-2 py-1 text-xs bg-secondary-100 hover:bg-secondary-200 rounded text-secondary-600"
        >
          Copy JSON
        </button>
        <pre className="bg-secondary-50 p-4 rounded-lg overflow-x-auto text-sm font-mono">
          {JSON.stringify(JSON.parse(content), null, 2)}
        </pre>
      </div>
    );
  }

  // Default: render as markdown
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
