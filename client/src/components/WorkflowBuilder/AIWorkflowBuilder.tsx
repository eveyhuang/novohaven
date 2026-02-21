import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, Modal } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import api, {
  AssistantMessage,
  AssistantResponse,
  GeneratedWorkflow,
  GeneratedStep,
  GeneratedInputSpec,
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
  reviewAction?: ReviewAction;
}

interface ReviewAction {
  executionId: number;
  stepExecutionId: number;
  stepOrder: number;
  stepName: string;
  outputPreview: string;
}

interface ActiveTestContext {
  executionId: number;
  workflowSnapshot: GeneratedWorkflow;
  inputData: Record<string, any>;
}

const VARIABLE_REGEX = /\{\{([^}]+)\}\}/g;
const RESERVED_VARIABLES = new Set([
  'company_voice',
  'company_platform',
  'company_image',
  'brand_voice',
  'amazon_requirements',
  'social_media_guidelines',
  'image_style_guidelines',
  'platform_requirements',
  'tone_guidelines',
]);

const WORKFLOW_JSON_BLOCK_REGEX = /```workflow-json\s*\n?([\s\S]*?)\n?\s*```/i;
const GENERIC_JSON_BLOCK_REGEX = /```json\s*\n?([\s\S]*?)\n?\s*```/i;

function parseWorkflowFromAssistantText(content: string): GeneratedWorkflow | null {
  const tryParse = (raw: string): GeneratedWorkflow | null => {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.name || !Array.isArray(parsed.steps)) return null;
      return parsed as GeneratedWorkflow;
    } catch {
      return null;
    }
  };

  const workflowFence = content.match(WORKFLOW_JSON_BLOCK_REGEX);
  if (workflowFence?.[1]) {
    const parsed = tryParse(workflowFence[1]);
    if (parsed) return parsed;
  }

  const jsonFence = content.match(GENERIC_JSON_BLOCK_REGEX);
  if (jsonFence?.[1]) {
    const parsed = tryParse(jsonFence[1]);
    if (parsed) return parsed;
  }

  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = tryParse(trimmed);
    if (parsed) return parsed;
  }

  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(candidates[i]);
    if (parsed) return parsed;
  }

  return null;
}

function inferRequiredInputsFromWorkflow(workflow: GeneratedWorkflow | null): GeneratedInputSpec[] {
  if (!workflow) return [];

  const byName = new Map<string, GeneratedInputSpec>();
  for (const spec of workflow.requiredInputs || []) {
    const name = String(spec?.name || '').trim();
    if (!name) continue;
    byName.set(name, {
      name,
      type: spec.type || 'text',
      description: spec.description || '',
    });
  }

  const considerText = (text: string) => {
    if (!text) return;
    let match: RegExpExecArray | null;
    VARIABLE_REGEX.lastIndex = 0;
    while ((match = VARIABLE_REGEX.exec(text)) !== null) {
      const raw = String(match[1] || '').trim();
      if (!raw) continue;
      if (/^step_\d+_output(?:\..+)?$/i.test(raw)) continue;
      if (RESERVED_VARIABLES.has(raw.toLowerCase())) continue;
      if (!byName.has(raw)) {
        byName.set(raw, {
          name: raw,
          type: 'text',
          description: '',
        });
      }
    }
  };

  for (const step of workflow.steps || []) {
    considerText(step.prompt_template || '');
    considerText(JSON.stringify(step.executor_config || {}));
  }

  return Array.from(byName.values());
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
  const [isTesting, setIsTesting] = useState(false);
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [activeTestContext, setActiveTestContext] = useState<ActiveTestContext | null>(null);
  const [handledReviewActions, setHandledReviewActions] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [pendingRejectAction, setPendingRejectAction] = useState<ReviewAction | null>(null);
  const [rejectFixInstructions, setRejectFixInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const effectiveRequiredInputs = useMemo(
    () => inferRequiredInputsFromWorkflow(currentWorkflow),
    [currentWorkflow]
  );

  useEffect(() => {
    if (!currentWorkflow) {
      setTestInputs({});
      return;
    }

    setTestInputs((prev) => {
      const next: Record<string, string> = {};
      for (const spec of effectiveRequiredInputs) {
        next[spec.name] = prev[spec.name] ?? '';
      }
      return next;
    });
  }, [currentWorkflow, effectiveRequiredInputs]);

  const buildAssistantMessages = (
    chatMessages: ChatMessage[],
    workflowContext?: GeneratedWorkflow,
    extraContext?: string
  ): AssistantMessage[] => {
    let lastUserIndex = -1;
    for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
      if (chatMessages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    return chatMessages.map((msg, index) => {
      if (index !== lastUserIndex || msg.role !== 'user') {
        return { role: msg.role, content: msg.content };
      }

      let content = msg.content;
      if (workflowContext && workflowContext.steps && workflowContext.steps.length > 0) {
        content +=
          `\n\nCurrent workflow draft. Apply edits to this JSON when responding:\n` +
          `\`\`\`workflow-json\n${JSON.stringify(workflowContext, null, 2)}\n\`\`\``;
      }
      if (extraContext) {
        content += `\n\n${extraContext}`;
      }
      return { role: msg.role, content };
    });
  };

  const buildTestInputData = (requiredSpecs: GeneratedInputSpec[]): Record<string, any> => {
    const inputData: Record<string, any> = {};
    for (const spec of requiredSpecs || []) {
      const raw = String(testInputs[spec.name] ?? '').trim();
      if (!raw) continue;

      if (spec.type === 'url_list') {
        inputData[spec.name] = raw
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        continue;
      }

      inputData[spec.name] = raw;
    }
    return inputData;
  };

  const waitForExecutionCompletion = async (executionId: number): Promise<any | null> => {
    const maxAttempts = 75;
    const delayMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const status = await api.getExecutionStatus(executionId);
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'paused') {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return null;
  };

  const summarizeExecutionFailure = (status: any): string => {
    const failedSteps = Array.isArray(status?.stepResults)
      ? status.stepResults.filter((step: any) => step?.status === 'failed')
      : [];

    if (failedSteps.length === 0) {
      return status?.error || 'Workflow execution failed with no detailed step error.';
    }

    return failedSteps
      .map((step: any) => {
        const order = step?.stepOrder ?? '?';
        const name = step?.stepName || `Step ${order}`;
        const errorText = step?.error || 'Unknown step error';
        return `Step ${order} (${name}): ${errorText}`;
      })
      .join('\n');
  };

  const hasFailedStep = (status: any): boolean => {
    return Array.isArray(status?.stepResults)
      && status.stepResults.some((step: any) => step?.status === 'failed');
  };

  const reviewActionKey = (action: ReviewAction): string => {
    return `${action.executionId}:${action.stepExecutionId}`;
  };

  const appendAssistantMessage = (content: string, reviewAction?: ReviewAction) => {
    setMessages((prev) => {
      const next = [...prev, { role: 'assistant' as const, content, reviewAction }];
      messagesRef.current = next;
      return next;
    });
  };

  const previewText = (value: unknown, maxChars = 1600): string => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
  };

  const extractStepOutputPreview = (stepExecution: any): string => {
    if (!stepExecution) return '';

    const output = stepExecution.output;
    if (typeof output?.content === 'string' && output.content.trim()) {
      return previewText(output.content.trim());
    }
    if (typeof stepExecution.output_data === 'string' && stepExecution.output_data.trim()) {
      try {
        const parsed = JSON.parse(stepExecution.output_data);
        if (typeof parsed?.content === 'string' && parsed.content.trim()) {
          return previewText(parsed.content.trim());
        }
        return previewText(parsed);
      } catch {
        return previewText(stepExecution.output_data.trim());
      }
    }
    return '';
  };

  const getPendingReviewAction = async (executionId: number): Promise<ReviewAction | null> => {
    const detail = await api.getExecution(executionId);
    const steps = Array.isArray(detail?.step_executions) ? detail.step_executions : [];
    const awaiting = steps.find((step: any) => step?.status === 'awaiting_review');
    if (!awaiting) return null;

    return {
      executionId,
      stepExecutionId: Number(awaiting.id),
      stepOrder: Number(awaiting.step_order || 0),
      stepName: String(awaiting.step_name || `Step ${awaiting.step_order || '?'}`),
      outputPreview: extractStepOutputPreview(awaiting),
    };
  };

  const handleExecutionOutcome = async (
    status: any,
    executionId: number,
    workflowSnapshot: GeneratedWorkflow,
    inputData: Record<string, any>
  ): Promise<void> => {
    if (status.status === 'completed') {
      appendAssistantMessage(`${t('aiBuilderTestPassed')} #${executionId}`);
      setActiveTestContext(null);
      return;
    }

    if (status.status === 'paused' && !hasFailedStep(status)) {
      const pendingReview = await getPendingReviewAction(executionId);
      if (pendingReview) {
        appendAssistantMessage(
          `${t('aiBuilderReviewPrompt')} #${executionId}\n${t('aiBuilderReviewStep')}: ${pendingReview.stepOrder} (${pendingReview.stepName})`,
          pendingReview
        );
        if (pendingReview.outputPreview) {
          appendAssistantMessage(
            `${t('aiBuilderReviewOutput')}\n${pendingReview.outputPreview}`
          );
        }
        setActiveTestContext({ executionId, workflowSnapshot, inputData });
      } else {
        appendAssistantMessage(`${t('aiBuilderTestPausedReview')} #${executionId}`);
        setActiveTestContext({ executionId, workflowSnapshot, inputData });
      }
      return;
    }

    const failureSummary = summarizeExecutionFailure(status);
    appendAssistantMessage(`${t('aiBuilderTestFailed')} #${executionId}\n${failureSummary}`);
    appendAssistantMessage(t('aiBuilderAutoFixing'));
    setActiveTestContext(null);
    await requestWorkflowFixFromFailure(workflowSnapshot, executionId, inputData, failureSummary);
  };

  const handleReviewAction = async (
    reviewAction: ReviewAction,
    action: 'approve' | 'reject',
    rejectInstructions?: string
  ) => {
    const key = reviewActionKey(reviewAction);
    if (handledReviewActions[key] || isTesting || isLoading) return;

    setHandledReviewActions((prev) => ({ ...prev, [key]: action === 'approve' ? 'approved' : 'rejected' }));
    setIsTesting(true);
    setError(null);

    const workflowSnapshot = activeTestContext?.workflowSnapshot || currentWorkflow;
    const inputData = activeTestContext?.inputData || buildTestInputData(effectiveRequiredInputs);

    try {
      if (action === 'approve') {
        appendAssistantMessage(`${t('aiBuilderReviewApproved')} #${reviewAction.executionId}\n${t('aiBuilderReviewContinuing')}`);
        await api.approveStep(reviewAction.executionId, reviewAction.stepExecutionId);
        const nextStatus = await waitForExecutionCompletion(reviewAction.executionId);
        if (!nextStatus) {
          appendAssistantMessage(t('aiBuilderTestTimeout'));
          setActiveTestContext(null);
          return;
        }
        if (!workflowSnapshot) {
          appendAssistantMessage(`${t('aiBuilderTestGenericError')}: ${t('aiBuilderMissingWorkflowContext')}`);
          setActiveTestContext(null);
          return;
        }
        await handleExecutionOutcome(nextStatus, reviewAction.executionId, workflowSnapshot, inputData);
        return;
      }

      await api.rejectStep(reviewAction.executionId, reviewAction.stepExecutionId);
      appendAssistantMessage(`${t('aiBuilderReviewRejected')} #${reviewAction.executionId}`);
      if (!workflowSnapshot) {
        appendAssistantMessage(`${t('aiBuilderTestGenericError')}: ${t('aiBuilderMissingWorkflowContext')}`);
        setActiveTestContext(null);
        return;
      }
      appendAssistantMessage(t('aiBuilderAutoFixing'));
      const guidance = String(rejectInstructions || '').trim();
      if (guidance) {
        appendAssistantMessage(`${t('aiBuilderFixGuidanceReceived')}: ${guidance}`);
      }
      const failureSummary = guidance
        ? `${t('aiBuilderReviewRejected')}: Step ${reviewAction.stepOrder} (${reviewAction.stepName}).\n${t('aiBuilderFixGuidancePrefix')}:\n${guidance}`
        : `${t('aiBuilderReviewRejected')}: Step ${reviewAction.stepOrder} (${reviewAction.stepName}).`;
      setActiveTestContext(null);
      await requestWorkflowFixFromFailure(
        workflowSnapshot,
        reviewAction.executionId,
        inputData,
        failureSummary
      );
    } catch (err: any) {
      const message = err?.message || t('aiBuilderTestGenericError');
      setError(message);
      appendAssistantMessage(`${t('aiBuilderTestGenericError')}: ${message}`);
    } finally {
      setIsTesting(false);
    }
  };

  const openRejectFixModal = (reviewAction: ReviewAction) => {
    const key = reviewActionKey(reviewAction);
    if (handledReviewActions[key] || isTesting || isLoading) return;
    setPendingRejectAction(reviewAction);
    setRejectFixInstructions('');
  };

  const closeRejectFixModal = () => {
    if (isTesting || isLoading) return;
    setPendingRejectAction(null);
    setRejectFixInstructions('');
  };

  const confirmRejectAndFix = async () => {
    if (!pendingRejectAction) return;
    const action = pendingRejectAction;
    const instructions = rejectFixInstructions.trim();
    setPendingRejectAction(null);
    setRejectFixInstructions('');
    await handleReviewAction(action, 'reject', instructions);
  };

  const requestWorkflowFixFromFailure = async (
    workflowSnapshot: GeneratedWorkflow,
    executionId: number | null,
    inputData: Record<string, any>,
    failureSummary: string
  ) => {
    const executionLabel = executionId ? ` #${executionId}` : '';
    const executionContextLine = executionId
      ? `Execution #${executionId} failed while testing this workflow.`
      : 'Workflow test failed before execution started.';
    const autoFixUserMessage: ChatMessage = {
      role: 'user',
      content: `${t('aiBuilderAutoFixRequest')}${executionLabel}\n${failureSummary}`,
    };
    const updatedMessages = [...messagesRef.current, autoFixUserMessage];
    setMessages(updatedMessages);
    messagesRef.current = updatedMessages;

    setIsLoading(true);
    setError(null);

    try {
      const response = await api.assistantGenerate(
        buildAssistantMessages(
          updatedMessages,
          workflowSnapshot,
          [
            executionContextLine,
            'Revise the workflow to fix the failure and return an updated workflow-json.',
            `Input data used:\n${JSON.stringify(inputData, null, 2)}`,
            `Failure summary:\n${failureSummary}`,
          ].join('\n\n')
        )
      );

      const resolvedWorkflow = response.workflow || parseWorkflowFromAssistantText(response.message);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message,
        workflow: resolvedWorkflow || undefined,
        suggestions: response.suggestions,
      };

      const withAssistant = [...updatedMessages, assistantMessage];
      setMessages(withAssistant);
      messagesRef.current = withAssistant;

      if (resolvedWorkflow) {
        setCurrentWorkflow(resolvedWorkflow);
      }
    } catch (err: any) {
      setError(err.message || t('aiBuilderFixFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading || isTesting) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messagesRef.current, userMessage];
    setMessages(updatedMessages);
    messagesRef.current = updatedMessages;
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      const response: AssistantResponse = await api.assistantGenerate(
        buildAssistantMessages(updatedMessages, currentWorkflow || undefined)
      );

      const resolvedWorkflow = response.workflow || parseWorkflowFromAssistantText(response.message);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message,
        workflow: resolvedWorkflow || undefined,
        suggestions: response.suggestions,
      };

      const withAssistant = [...updatedMessages, assistantMessage];
      setMessages(withAssistant);
      messagesRef.current = withAssistant;

      if (resolvedWorkflow) {
        setCurrentWorkflow(resolvedWorkflow);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to generate response');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Keep Enter for newline; use Cmd/Ctrl+Enter for quick send.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
    inputRef.current?.focus();
  };

  const handleTestInputChange = (name: string, value: string) => {
    setTestInputs((prev) => ({ ...prev, [name]: value }));
  };

  const handleTestWorkflow = async () => {
    if (!currentWorkflow || isTesting || isLoading || isSaving || !!activeTestContext) return;

    const missingInputs = effectiveRequiredInputs
      .map((spec) => spec.name)
      .filter((name) => !String(testInputs[name] ?? '').trim());

    if (missingInputs.length > 0) {
      setError(`${t('aiBuilderMissingTestInputs')}: ${missingInputs.join(', ')}`);
      return;
    }

    const workflowSnapshot = JSON.parse(JSON.stringify(currentWorkflow)) as GeneratedWorkflow;
    workflowSnapshot.requiredInputs = effectiveRequiredInputs;
    const inputData = buildTestInputData(effectiveRequiredInputs);

    setIsTesting(true);
    setError(null);
    setHandledReviewActions({});
    setMessages((prev) => {
      const next = [...prev, { role: 'assistant' as const, content: t('aiBuilderTesting') }];
      messagesRef.current = next;
      return next;
    });

    let tempWorkflowId: number | undefined;
    let startedExecutionId: number | undefined;
    try {
      const saved = await api.assistantSave(workflowSnapshot, false);
      tempWorkflowId = saved.workflowId;
      if (!tempWorkflowId) {
        throw new Error(t('aiBuilderTestPrepFailed'));
      }

      const started = await api.startWorkflowExecution(tempWorkflowId, inputData);
      if (!started?.executionId) {
        throw new Error(started?.error || t('aiBuilderTestStartFailed'));
      }
      startedExecutionId = started.executionId;
      setActiveTestContext({
        executionId: started.executionId,
        workflowSnapshot,
        inputData,
      });

      appendAssistantMessage(`${t('aiBuilderTestStarted')} #${started.executionId}`);

      const finalStatus = await waitForExecutionCompletion(started.executionId);
      if (!finalStatus) {
        if (startedExecutionId) {
          try {
            await api.cancelExecution(startedExecutionId);
          } catch {
            // If cancellation fails, still report timeout and continue cleanup.
          }
        }
        appendAssistantMessage(t('aiBuilderTestTimeout'));
        setActiveTestContext(null);
        return;
      }

      await handleExecutionOutcome(finalStatus, started.executionId, workflowSnapshot, inputData);
    } catch (err: any) {
      const message = err?.message || t('aiBuilderTestGenericError');
      setError(message);
      setActiveTestContext(null);
      appendAssistantMessage(`${t('aiBuilderTestGenericError')}: ${message}`);

      const shouldAutoFix = Boolean(workflowSnapshot)
        && (/missing required inputs/i.test(message)
          || /unresolved variables/i.test(message)
          || /cannot navigate/i.test(message)
          || /waiting for selector/i.test(message)
          || /unsupported action/i.test(message)
          || !startedExecutionId);

      if (shouldAutoFix) {
        appendAssistantMessage(t('aiBuilderAutoFixing'));
        await requestWorkflowFixFromFailure(
          workflowSnapshot,
          startedExecutionId ?? null,
          inputData,
          `Workflow test startup failed.\n${message}`
        );
      }
    } finally {
      if (tempWorkflowId) {
        try {
          await api.deleteWorkflow(tempWorkflowId);
        } catch {
          // Best effort cleanup for temporary test workflow.
        }
      }
      setIsTesting(false);
    }
  };

  const handleSave = async (asSkill: boolean) => {
    if (!currentWorkflow) return;

    setIsSaving(true);
    setError(null);

    try {
      const result = await api.assistantSave(currentWorkflow, asSkill);
      if (result.entityType === 'skill' && result.skillId) {
        navigate(`/skills/${result.skillId}`);
      } else if (result.entityType === 'workflow' && result.workflowId) {
        navigate(`/workflows/${result.workflowId}`);
      }
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

                    {msg.reviewAction && (
                      <div className="mt-3 pt-3 border-t border-secondary-200">
                        <p className="text-xs text-secondary-500 mb-2">
                          {t('aiBuilderReviewActions')}
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleReviewAction(msg.reviewAction!, 'approve')}
                            disabled={isTesting || isLoading || !!handledReviewActions[reviewActionKey(msg.reviewAction)]}
                            className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {t('aiBuilderReviewApprove')}
                          </button>
                          <button
                            onClick={() => openRejectFixModal(msg.reviewAction!)}
                            disabled={isTesting || isLoading || !!handledReviewActions[reviewActionKey(msg.reviewAction)]}
                            className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {t('aiBuilderReviewReject')}
                          </button>
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
                  className="flex-1 resize-none overflow-hidden rounded-lg border border-secondary-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  rows={1}
                  disabled={isLoading || isTesting}
                />
                <Button
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading || isTesting}
                  isLoading={isLoading}
                  className="self-end"
                >
                  {t('send')}
                </Button>
              </div>
              <p className="mt-2 text-xs text-secondary-500">{t('aiBuilderInputHint')}</p>
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
                  {effectiveRequiredInputs.length > 0 && (
                    <div className="bg-blue-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-blue-700 mb-1">{t('requiredInputs')}:</p>
                      <div className="space-y-1">
                        {effectiveRequiredInputs.map((inp, i) => (
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

                  {/* Reusable skill blueprints */}
                  {currentWorkflow.skill_blueprints && currentWorkflow.skill_blueprints.length > 0 && (
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-emerald-700 mb-2">
                        Reusable Skills ({currentWorkflow.skill_blueprints.length})
                      </p>
                      <div className="space-y-2">
                        {currentWorkflow.skill_blueprints.map((bp, i) => (
                          <div key={bp.key || `${bp.name}-${i}`} className="border border-emerald-200 rounded px-2 py-1.5 bg-white/70">
                            <div className="text-xs font-semibold text-emerald-800">
                              {bp.name}
                              {bp.key ? <span className="ml-1 text-emerald-600">[{bp.key}]</span> : null}
                            </div>
                            <div className="text-[11px] text-emerald-700">
                              {bp.steps.length} step(s)
                              {bp.requiredInputs && bp.requiredInputs.length > 0
                                ? ` • ${bp.requiredInputs.length} input(s)`
                                : ''}
                            </div>
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
                {effectiveRequiredInputs.length > 0 && (
                  <div className="space-y-2 pb-2">
                    <p className="text-xs font-medium text-secondary-600">{t('aiBuilderTestInputs')}</p>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {effectiveRequiredInputs.map((spec) => {
                        const isLong = spec.type === 'textarea' || spec.type === 'url_list';
                        return (
                          <div key={spec.name}>
                            <label className="block text-xs text-secondary-500 mb-1">
                              {spec.name}
                              <span className="ml-1 text-secondary-400">({spec.type})</span>
                            </label>
                            {isLong ? (
                              <textarea
                                value={testInputs[spec.name] || ''}
                                onChange={(e) => handleTestInputChange(spec.name, e.target.value)}
                                rows={spec.type === 'url_list' ? 3 : 2}
                                placeholder={spec.description || ''}
                                className="w-full border border-secondary-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                                disabled={isTesting || isLoading || isSaving}
                              />
                            ) : (
                              <input
                                type="text"
                                value={testInputs[spec.name] || ''}
                                onChange={(e) => handleTestInputChange(spec.name, e.target.value)}
                                placeholder={spec.description || ''}
                                className="w-full border border-secondary-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                                disabled={isTesting || isLoading || isSaving}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={handleTestWorkflow}
                  isLoading={isTesting}
                  disabled={isTesting || isLoading || isSaving || !!activeTestContext}
                >
                  {t('aiBuilderRunTest')}
                </Button>
                {activeTestContext && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    {t('aiBuilderReviewPending')}
                  </p>
                )}
                <Button
                  className="w-full"
                  onClick={() => handleSave(false)}
                  isLoading={isSaving}
                  disabled={isSaving || isTesting || isLoading}
                >
                  Save As Workflow
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => handleSave(true)}
                  isLoading={isSaving}
                  disabled={isSaving || isTesting || isLoading}
                >
                  Save As Skill
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal
        isOpen={!!pendingRejectAction}
        onClose={closeRejectFixModal}
        title={t('aiBuilderRejectModalTitle')}
        size="md"
      >
        <div className="space-y-3">
          <p className="text-sm text-secondary-600">{t('aiBuilderRejectModalDescription')}</p>
          <textarea
            value={rejectFixInstructions}
            onChange={(e) => setRejectFixInstructions(e.target.value)}
            placeholder={t('aiBuilderRejectModalPlaceholder')}
            rows={5}
            className="w-full border border-secondary-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
            disabled={isTesting || isLoading}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeRejectFixModal} disabled={isTesting || isLoading}>
              {t('cancel')}
            </Button>
            <Button onClick={confirmRejectAndFix} disabled={isTesting || isLoading}>
              {t('aiBuilderRejectSubmit')}
            </Button>
          </div>
        </div>
      </Modal>
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
  const sourceLabel = step.from_skill_id
    ? `skill #${step.from_skill_id}${step.from_step_order ? ` step ${step.from_step_order}` : ''}`
    : step.from_skill_blueprint
      ? `blueprint:${step.from_skill_blueprint}${step.from_step_order ? ` step ${step.from_step_order}` : ''}`
      : step.from_skill_name
        ? `skill:${step.from_skill_name}${step.from_step_order ? ` step ${step.from_step_order}` : ''}`
        : 'inline';
  const modelLabel = step.ai_model ? `model:${step.ai_model}` : '';

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
      <div className="px-3 pb-2 pt-1 bg-secondary-50 border-t border-secondary-100 flex items-center gap-2 text-[11px] text-secondary-500">
        <span className="px-1.5 py-0.5 rounded bg-secondary-200 text-secondary-700">source:{sourceLabel}</span>
        {modelLabel && <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{modelLabel}</span>}
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
              <option value="file">File</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
