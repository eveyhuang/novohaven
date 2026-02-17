import React, { useEffect, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Button, Card, CardBody } from '../common';
import api from '../../services/api';

interface DraftStep {
  id: number;
  step_number: number;
  title: string;
  step_type: string;
  prompt_template: string;
}

interface DraftSummary {
  id: number;
  name: string;
  skill_type: string;
  change_summary: string;
  status: string;
  created_at: string;
}

interface DraftDetail {
  draft: DraftSummary & { steps: DraftStep[] };
  original: (DraftSummary & { steps: DraftStep[] }) | null;
}

export function DraftList() {
  const { t } = useLanguage();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  useEffect(() => {
    loadDrafts();
  }, []);

  const loadDrafts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.getSkillDrafts();
      setDrafts(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load drafts');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRowClick = async (draft: DraftSummary) => {
    if (expandedId === draft.id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }

    setExpandedId(draft.id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await api.getSkillDraft(draft.id);
      setDetail(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load draft details');
      setExpandedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleApprove = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading(id);
    try {
      await api.approveSkillDraft(id);
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to approve draft');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading(id);
    try {
      await api.rejectSkillDraft(id);
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to reject draft');
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">Skill Draft Review</h1>
        <p className="text-secondary-600 mt-1">
          Review and approve agent-proposed skill and workflow changes
        </p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {drafts.length === 0 ? (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-secondary-600">
              No pending drafts to review.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-secondary-200 bg-secondary-50">
                  <th className="px-6 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider">
                    Change Summary
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-secondary-100">
                {drafts.map((draft) => (
                  <React.Fragment key={draft.id}>
                    {/* Summary row */}
                    <tr
                      onClick={() => handleRowClick(draft)}
                      className={`cursor-pointer transition-colors hover:bg-secondary-50 ${
                        expandedId === draft.id ? 'bg-secondary-50' : ''
                      }`}
                    >
                      <td className="px-6 py-4 text-sm font-medium text-secondary-900">
                        {draft.name}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <span
                          className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            draft.skill_type === 'skill'
                              ? 'bg-primary-100 text-primary-700'
                              : 'bg-secondary-100 text-secondary-700'
                          }`}
                        >
                          {draft.skill_type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-secondary-600 max-w-xs truncate">
                        {draft.change_summary}
                      </td>
                      <td className="px-6 py-4 text-sm text-secondary-500 whitespace-nowrap">
                        {formatDate(draft.created_at)}
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end space-x-2">
                          <Button
                            size="sm"
                            className="bg-green-600 text-white hover:bg-green-700 focus:ring-green-500"
                            onClick={(e) => handleApprove(draft.id, e)}
                            isLoading={actionLoading === draft.id}
                            disabled={actionLoading === draft.id}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={(e) => handleReject(draft.id, e)}
                            isLoading={actionLoading === draft.id}
                            disabled={actionLoading === draft.id}
                          >
                            Reject
                          </Button>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    {expandedId === draft.id && (
                      <tr>
                        <td colSpan={5} className="px-6 py-6 bg-secondary-50">
                          {detailLoading ? (
                            <div className="flex items-center justify-center py-8">
                              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
                            </div>
                          ) : detail ? (
                            <DraftDetailView detail={detail} />
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function DraftDetailView({ detail }: { detail: DraftDetail }) {
  const { draft, original } = detail;
  const hasOriginal = original !== null;

  return (
    <div className="space-y-6">
      {/* Side-by-side comparison */}
      {hasOriginal ? (
        <div className="grid grid-cols-2 gap-6">
          {/* Original */}
          <div>
            <h3 className="text-sm font-semibold text-secondary-500 uppercase tracking-wider mb-3">
              Original
            </h3>
            <div className="bg-white rounded-lg border border-secondary-200 p-4 space-y-3">
              <div>
                <span className="text-xs text-secondary-400">Name</span>
                <p className="text-sm text-secondary-900">{original!.name}</p>
              </div>
              <div>
                <span className="text-xs text-secondary-400">Steps</span>
                <StepList steps={original!.steps} />
              </div>
            </div>
          </div>

          {/* Proposed */}
          <div>
            <h3 className="text-sm font-semibold text-green-600 uppercase tracking-wider mb-3">
              Proposed Changes
            </h3>
            <div className="bg-white rounded-lg border border-green-200 p-4 space-y-3">
              <div>
                <span className="text-xs text-secondary-400">Name</span>
                <p className="text-sm text-secondary-900">{draft.name}</p>
              </div>
              <div>
                <span className="text-xs text-secondary-400">Steps</span>
                <StepList steps={draft.steps} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-semibold text-green-600 uppercase tracking-wider mb-3">
            New {draft.skill_type}
          </h3>
          <div className="bg-white rounded-lg border border-green-200 p-4 space-y-3">
            <div>
              <span className="text-xs text-secondary-400">Name</span>
              <p className="text-sm text-secondary-900">{draft.name}</p>
            </div>
            <div>
              <span className="text-xs text-secondary-400">Change Summary</span>
              <p className="text-sm text-secondary-700">{draft.change_summary}</p>
            </div>
            <div>
              <span className="text-xs text-secondary-400">Steps</span>
              <StepList steps={draft.steps} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepList({ steps }: { steps: DraftStep[] }) {
  if (!steps || steps.length === 0) {
    return <p className="text-sm text-secondary-400 italic mt-1">No steps</p>;
  }

  return (
    <ol className="mt-1 space-y-2">
      {steps.map((step) => (
        <li
          key={step.id}
          className="text-sm border border-secondary-100 rounded-md px-3 py-2 bg-secondary-50"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-secondary-800">
              {step.step_number}. {step.title}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-secondary-200 text-secondary-600">
              {step.step_type}
            </span>
          </div>
          {step.prompt_template && (
            <p className="text-xs text-secondary-500 mt-1 line-clamp-2">
              {step.prompt_template}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
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
