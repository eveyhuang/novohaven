import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../services/api';
import {
  WorkflowExecution,
  StepExecution,
  ExecutionChatMessage,
} from '../../types';
import StepProgressBar from './StepProgressBar';
import ChatMessageList from './ChatMessageList';
import ChatInput from './ChatInput';

const ChatExecution: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const executionId = parseInt(id || '0', 10);

  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [messages, setMessages] = useState<ExecutionChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const stepRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const messageIdsRef = useRef<Set<string>>(new Set());

  // Reconstruct chat messages from existing step executions
  const reconstructMessages = useCallback(
    (exec: WorkflowExecution): ExecutionChatMessage[] => {
      const msgs: ExecutionChatMessage[] = [];
      const steps = exec.step_executions || [];

      for (const step of steps) {
        if (step.status === 'pending') continue;

        // step-start
        msgs.push({
          id: `reconstructed-start-${step.id}`,
          executionId: exec.id,
          stepOrder: step.step_order,
          stepName: step.step_name || `Step ${step.step_order}`,
          stepType: getStepType(step),
          type: 'step-start',
          role: 'system',
          content: `Starting step ${step.step_order}: ${step.step_name || 'Unknown'}`,
          timestamp: step.executed_at || exec.created_at,
        });

        // step-output or step-error
        if (step.status === 'failed' && step.error_message) {
          msgs.push({
            id: `reconstructed-error-${step.id}`,
            executionId: exec.id,
            stepOrder: step.step_order,
            stepName: step.step_name || `Step ${step.step_order}`,
            stepType: getStepType(step),
            type: 'step-error',
            role: 'system',
            content: step.error_message,
            metadata: { stepExecutionId: step.id },
            timestamp: step.executed_at || exec.created_at,
          });
        } else if (step.output_data || step.output) {
          const output = parseStepOutput(step);
          msgs.push({
            id: `reconstructed-output-${step.id}`,
            executionId: exec.id,
            stepOrder: step.step_order,
            stepName: step.step_name || `Step ${step.step_order}`,
            stepType: getStepType(step),
            type: 'step-output',
            role: 'system',
            content: output.content,
            metadata: {
              model: step.ai_model_used || step.ai_model,
              usage: output.usage,
              images: output.generatedImages,
              isJson: output.isJson,
              stepExecutionId: step.id,
            },
            timestamp: step.executed_at || exec.created_at,
          });

          // action-required for awaiting_review steps
          if (step.status === 'awaiting_review') {
            msgs.push({
              id: `reconstructed-action-${step.id}`,
              executionId: exec.id,
              stepOrder: step.step_order,
              stepName: step.step_name || `Step ${step.step_order}`,
              stepType: getStepType(step),
              type: 'action-required',
              role: 'system',
              content: 'Step complete. Please review and approve or reject.',
              metadata: {
                actionType: 'approve',
                stepExecutionId: step.id,
              },
              timestamp: step.executed_at || exec.created_at,
            });
          }

          // step-approved for completed steps
          if (step.status === 'completed' && step.approved) {
            msgs.push({
              id: `reconstructed-approved-${step.id}`,
              executionId: exec.id,
              stepOrder: step.step_order,
              stepName: step.step_name || `Step ${step.step_order}`,
              stepType: getStepType(step),
              type: 'step-approved',
              role: 'system',
              content: 'Step approved',
              timestamp: step.executed_at || exec.created_at,
            });
          }
        }
      }

      // execution-complete
      if (exec.status === 'completed') {
        msgs.push({
          id: `reconstructed-complete-${exec.id}`,
          executionId: exec.id,
          stepOrder: steps.length,
          stepName: '',
          stepType: 'ai',
          type: 'execution-complete',
          role: 'system',
          content: 'All steps complete',
          timestamp: exec.completed_at || exec.created_at,
        });
      }

      return msgs;
    },
    []
  );

  // Load execution data
  const loadExecution = useCallback(async () => {
    try {
      const exec = await api.getExecution(executionId);
      setExecution(exec);

      // Reconstruct messages from step executions
      const reconstructed = reconstructMessages(exec);

      // Track IDs to avoid duplicates from SSE
      const idSet = new Set<string>();
      reconstructed.forEach((m) => idSet.add(m.id));
      messageIdsRef.current = idSet;

      setMessages(reconstructed);
      setLoading(false);
    } catch (err: any) {
      setError(err.message || 'Failed to load execution');
      setLoading(false);
    }
  }, [executionId, reconstructMessages]);

  // Connect to SSE stream
  useEffect(() => {
    if (!executionId) return;

    loadExecution();

    const es = api.connectExecutionStream(executionId);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Skip connection event
        if (data.type === 'connected') return;

        const msg = data as ExecutionChatMessage;

        // Deduplicate
        if (messageIdsRef.current.has(msg.id)) return;
        messageIdsRef.current.add(msg.id);

        setMessages((prev) => [...prev, msg]);

        // Refresh execution data on key events
        if (
          msg.type === 'step-approved' ||
          msg.type === 'step-rejected' ||
          msg.type === 'execution-complete' ||
          msg.type === 'step-error' ||
          msg.type === 'action-required'
        ) {
          // Small delay to let DB update
          setTimeout(() => {
            api.getExecution(executionId).then(setExecution).catch(() => {});
          }, 500);
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [executionId, loadExecution]);

  // Handle approve
  const handleApprove = async (stepExecutionId: number) => {
    setActionLoading(true);
    try {
      await api.approveStep(executionId, stepExecutionId);
      // SSE will deliver the events; also refresh execution
      setTimeout(() => {
        api.getExecution(executionId).then(setExecution).catch(() => {});
      }, 500);
    } catch (err: any) {
      console.error('Approve failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  // Handle reject
  const handleReject = async (stepExecutionId: number) => {
    setActionLoading(true);
    try {
      await api.rejectStep(executionId, stepExecutionId);
      setTimeout(() => {
        api.getExecution(executionId).then(setExecution).catch(() => {});
      }, 500);
    } catch (err: any) {
      console.error('Reject failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  // Handle retry
  const handleRetry = async (stepExecutionId: number) => {
    setActionLoading(true);
    try {
      await api.retryStep(executionId, stepExecutionId);
      setTimeout(() => {
        api.getExecution(executionId).then(setExecution).catch(() => {});
      }, 500);
    } catch (err: any) {
      console.error('Retry failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  // Handle user message sent (for Manus)
  const handleMessageSent = (text: string) => {
    const userMsg: ExecutionChatMessage = {
      id: `user-${Date.now()}`,
      executionId,
      stepOrder: execution?.current_step || 1,
      stepName: '',
      stepType: 'manus',
      type: 'user-message',
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
  };

  // Scroll to step
  const handleStepClick = (stepOrder: number) => {
    const el = stepRefs.current[stepOrder];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Determine if chat input should be active
  const activeManusTaskId = getActiveManusTaskId(execution);
  const chatInputEnabled =
    !!activeManusTaskId &&
    execution?.status !== 'completed' &&
    execution?.status !== 'failed';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error || !execution) {
    return (
      <div className="p-6 text-center">
        <p className="text-red-600 mb-4">{error || 'Execution not found'}</p>
        <Link to="/executions" className="text-primary-600 hover:text-primary-700">
          Back to Executions
        </Link>
      </div>
    );
  }

  const stepExecutions = execution.step_executions || [];
  const totalSteps = execution.total_steps || stepExecutions.length;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-white rounded-lg border border-secondary-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-secondary-200 bg-secondary-50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-secondary-900">
              {execution.recipe_name || execution.recipe?.name || 'Execution'}
            </h2>
            <p className="text-xs text-secondary-500">
              Execution #{execution.id}
            </p>
          </div>
          <StatusBadge status={execution.status} />
        </div>
      </div>

      {/* Step Progress Bar */}
      {stepExecutions.length > 1 && (
        <StepProgressBar
          steps={stepExecutions}
          currentStep={execution.current_step}
          totalSteps={totalSteps}
          onStepClick={handleStepClick}
        />
      )}

      {/* Message List */}
      <ChatMessageList
        messages={messages}
        onApprove={handleApprove}
        onReject={handleReject}
        onRetry={handleRetry}
        actionDisabled={actionLoading}
        stepRefs={stepRefs}
      />

      {/* Chat Input */}
      <ChatInput
        activeManusTaskId={activeManusTaskId}
        enabled={chatInputEnabled}
        onMessageSent={handleMessageSent}
      />
    </div>
  );
};

// --- Helpers ---

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-secondary-100 text-secondary-600',
    running: 'bg-blue-100 text-blue-700',
    paused: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  };

  return (
    <span
      className={`px-2.5 py-1 text-xs font-medium rounded-full ${
        colors[status] || colors.pending
      }`}
    >
      {status}
    </span>
  );
}

function getStepType(step: StepExecution): string {
  // Try to get step type from output_data metadata
  if (step.output_data) {
    try {
      const parsed = JSON.parse(step.output_data);
      if (parsed.stepType) return parsed.stepType;
    } catch {}
  }
  return 'ai';
}

function parseStepOutput(step: StepExecution): {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
  generatedImages?: any[];
  isJson?: boolean;
} {
  // Use parsed output object if available
  if (step.output) {
    return {
      content: step.output.content || '',
      usage: step.output.usage,
      generatedImages: step.output.generatedImages,
    };
  }

  // Fall back to parsing output_data string
  if (step.output_data) {
    try {
      const parsed = JSON.parse(step.output_data);
      return {
        content: parsed.content || step.output_data,
        usage: parsed.usage,
        generatedImages: parsed.generatedImages,
        isJson: typeof parsed.content === 'string' && isJsonString(parsed.content),
      };
    } catch {
      return { content: step.output_data };
    }
  }

  return { content: '' };
}

function isJsonString(str: string): boolean {
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function getActiveManusTaskId(
  execution: WorkflowExecution | null
): string | null {
  if (!execution || !execution.step_executions) return null;

  // Find a running or awaiting_review Manus step
  for (const step of execution.step_executions) {
    if (step.status !== 'running' && step.status !== 'awaiting_review')
      continue;

    if (step.output_data) {
      try {
        const parsed = JSON.parse(step.output_data);
        if (parsed.manusTaskId) return parsed.manusTaskId;
      } catch {}
    }
  }

  return null;
}

export default ChatExecution;
