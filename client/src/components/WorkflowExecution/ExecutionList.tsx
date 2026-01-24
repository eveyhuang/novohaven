import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { WorkflowExecution } from '../../types';
import api from '../../services/api';
import { Button, Card, CardBody, Modal, TranslatedText } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { translateText } from '../../services/translationService';

export function ExecutionList() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowExecution | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadExecutions();
  }, []);

  // Auto-refresh if there are running executions
  useEffect(() => {
    const hasRunning = executions.some(e => ['running', 'pending'].includes(e.status));

    if (!hasRunning) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    // Poll every 5 seconds when there are running executions
    pollingRef.current = setInterval(async () => {
      try {
        const data = await api.getExecutions();
        setExecutions(data);
      } catch (err) {
        console.error('Error polling executions:', err);
      }
    }, 5000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [executions]);

  const loadExecutions = async () => {
    setIsLoading(true);
    try {
      const data = await api.getExecutions();
      setExecutions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async (execution: WorkflowExecution, e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading(execution.id);
    try {
      await api.cancelExecution(execution.id);
      await loadExecutions();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (execution: WorkflowExecution) => {
    setActionLoading(execution.id);
    setConfirmDelete(null);
    try {
      await api.deleteExecution(execution.id);
      await loadExecutions();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const canCancel = (status: string) => ['running', 'paused', 'pending'].includes(status);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-secondary-100 text-secondary-700',
    running: 'bg-blue-100 text-blue-700',
    paused: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-orange-100 text-orange-700',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Executions</h1>
          <p className="text-secondary-600 mt-1">
            View and manage your workflow executions
          </p>
        </div>
        <Button onClick={() => navigate('/')}>
          Start New Workflow
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Execution List */}
      {executions.length === 0 ? (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-secondary-600 mb-4">
              No executions yet. Start a workflow to see it here.
            </p>
            <Button onClick={() => navigate('/')}>
              Go to Dashboard
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-4">
          {executions.map((execution) => (
            <Card
              key={execution.id}
              hoverable
              onClick={() => navigate(`/executions/${execution.id}`)}
            >
              <CardBody className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <StatusIcon status={execution.status} />
                  <div>
                    <h3 className="font-medium text-secondary-900">
                      <TranslatedText
                        text={execution.recipe_name || `Recipe #${execution.recipe_id}`}
                      />
                    </h3>
                    <p className="text-sm text-secondary-500">
                      {t('execution')} #{execution.id}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-4">
                  <span className={`px-3 py-1 text-sm font-medium rounded-full ${statusColors[execution.status]}`}>
                    {t(execution.status as any) || execution.status}
                  </span>
                  <div className="text-right mr-4">
                    <p className="text-sm text-secondary-900">
                      {execution.current_step} / {execution.total_steps || '?'} {t('steps')}
                    </p>
                    <p className="text-xs text-secondary-500">
                      {formatDate(execution.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center space-x-2">
                    {canCancel(execution.status) && (
                      <button
                        onClick={(e) => handleCancel(execution, e)}
                        disabled={actionLoading === execution.id}
                        className="p-2 text-yellow-600 hover:bg-yellow-50 rounded-lg transition-colors disabled:opacity-50"
                        title={t('cancelExecution')}
                      >
                        {actionLoading === execution.id ? (
                          <div className="w-5 h-5 border-2 border-yellow-600 border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <StopIcon className="w-5 h-5" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(execution);
                      }}
                      disabled={actionLoading === execution.id}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      title={t('deleteExecution')}
                    >
                      <TrashIcon className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t('confirmDeleteExecution')}
        size="sm"
      >
        {confirmDelete && (
          <div className="space-y-4">
            <p className="text-secondary-600">
              {t('confirmDeleteExecutionDesc')}
            </p>
            <p className="font-medium text-secondary-900">
              <TranslatedText text={confirmDelete.recipe_name || `Recipe #${confirmDelete.recipe_id}`} /> - {t('execution')} #{confirmDelete.id}
            </p>
            <div className="flex justify-end space-x-3 pt-4">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => handleDelete(confirmDelete)}
                isLoading={actionLoading === confirmDelete.id}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
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

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      );
    case 'running':
      return (
        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      );
    case 'paused':
      return (
        <div className="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      );
    case 'failed':
      return (
        <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      );
    case 'cancelled':
      return (
        <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      );
    default:
      return (
        <div className="w-10 h-10 rounded-full bg-secondary-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-secondary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      );
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) {
    return 'Just now';
  } else if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins} minute${mins > 1 ? 's' : ''} ago`;
  } else if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  } else {
    return date.toLocaleDateString();
  }
}
