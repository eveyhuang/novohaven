import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WorkflowDefinition, WorkflowExecution } from '../../types';
import api from '../../services/api';
import { Button, Card, CardBody } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { translateText } from '../../services/translationService';

export function Dashboard() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [skills, setSkills] = useState<WorkflowDefinition[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [recentExecutions, setRecentExecutions] = useState<WorkflowExecution[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentHealth, setAgentHealth] = useState<{
    activeSessions: number;
    pendingDrafts: number;
    skillCount: number;
    workflowCount: number;
  }>({ activeSessions: 0, pendingDrafts: 0, skillCount: 0, workflowCount: 0 });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [skillsData, workflowsData, executionsData] = await Promise.all([
        api.getSkills(),
        api.getWorkflows(),
        api.getExecutions(),
      ]);
      setSkills(skillsData);
      setWorkflows(workflowsData);
      setRecentExecutions(executionsData.slice(0, 5));

      // Load agent health data (non-blocking)
      try {
        const [sessions, drafts, skills, workflows] = await Promise.all([
          api.getSessions().catch(() => []),
          api.getSkillDrafts().catch(() => []),
          api.getSkills().catch(() => []),
          api.getWorkflows().catch(() => []),
        ]);
        setAgentHealth({
          activeSessions: sessions.filter((s: any) => s.status === 'active').length,
          pendingDrafts: drafts.length,
          skillCount: skills.length,
          workflowCount: workflows.length,
        });
      } catch {
        // Agent health is optional
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCloneWorkflow = async (workflowId: number) => {
    try {
      const cloned = await api.cloneWorkflow(workflowId);
      navigate(`/workflows/${cloned.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteWorkflow = async (workflowId: number) => {
    if (!window.confirm('Are you sure you want to delete this?')) return;
    try {
      await api.deleteWorkflow(workflowId);
      setWorkflows(workflows.filter(w => w.id !== workflowId));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteSkill = async (skillId: number) => {
    if (!window.confirm('Are you sure you want to delete this?')) return;
    try {
      await api.deleteSkill(skillId);
      setSkills(skills.filter(s => s.id !== skillId));
    } catch (err: any) {
      setError(err.message);
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
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">{t('dashboardTitle')}</h1>
        <p className="text-secondary-600 mt-1">
          {t('dashboardSubtitle')}
        </p>
      </div>

      {/* Agent Health Panel */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card hoverable onClick={() => navigate('/sessions')}>
          <CardBody className="text-center py-4">
            <div className="text-2xl font-bold text-primary-600">{agentHealth.activeSessions}</div>
            <div className="text-sm text-secondary-600">Active Sessions</div>
          </CardBody>
        </Card>
        <Card hoverable onClick={() => navigate('/drafts')}>
          <CardBody className="text-center py-4">
            <div className="text-2xl font-bold text-yellow-600">{agentHealth.pendingDrafts}</div>
            <div className="text-sm text-secondary-600">Pending Drafts</div>
          </CardBody>
        </Card>
        <Card hoverable onClick={() => navigate('/skills/new')}>
          <CardBody className="text-center py-4">
            <div className="text-2xl font-bold text-green-600">{agentHealth.skillCount}</div>
            <div className="text-sm text-secondary-600">Skills</div>
          </CardBody>
        </Card>
        <Card hoverable onClick={() => navigate('/workflows/new')}>
          <CardBody className="text-center py-4">
            <div className="text-2xl font-bold text-blue-600">{agentHealth.workflowCount}</div>
            <div className="text-sm text-secondary-600">Workflows</div>
          </CardBody>
        </Card>
      </div>

      {/* Build with AI card */}
      <Card hoverable onClick={() => navigate('/workflows/ai-builder')} className="bg-gradient-to-r from-primary-50 to-blue-50 border-primary-200">
        <CardBody className="flex items-center gap-4 py-5">
          <div className="text-3xl">{'\uD83E\uDD16'}</div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-primary-900">{t('buildWithAI')}</h2>
            <p className="text-sm text-primary-700">{t('buildWithAIDescription')}</p>
          </div>
          <Button size="sm" onClick={(e) => { e.stopPropagation(); navigate('/workflows/ai-builder'); }}>
            {t('getStarted')}
          </Button>
        </CardBody>
      </Card>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Skills (was Templates) */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-secondary-900">
              My Skills
            </h2>
            <p className="text-sm text-secondary-500">Single-task building blocks for your workflows</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate('/skills/new')}>
            Create New Skill
          </Button>
        </div>
        {skills.length === 0 ? (
          <Card>
            <CardBody className="text-center py-8">
              <p className="text-secondary-600 mb-4">
                No skills yet. Create your first skill to get started.
              </p>
              <Button variant="secondary" onClick={() => navigate('/skills/new')}>
                Create New Skill
              </Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onEdit={() => navigate(`/skills/${skill.id}`)}
                onDelete={() => handleDeleteSkill(skill.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      {/* Workflows (was Recipes) */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-secondary-900">
              My Workflows
            </h2>
            <p className="text-sm text-secondary-500">Multi-step workflows that chain skills together</p>
          </div>
          <Button size="sm" onClick={() => navigate('/workflows/new')}>
            Create New Workflow
          </Button>
        </div>
        {workflows.length === 0 ? (
          <Card>
            <CardBody className="text-center py-12">
              <p className="text-secondary-600 mb-4">
                You haven't created any workflows yet.
              </p>
              <Button onClick={() => navigate('/workflows/new')}>
                Create Your First Workflow
              </Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {workflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onRun={() => navigate(`/workflows/${workflow.id}/run`)}
                onEdit={() => navigate(`/workflows/${workflow.id}`)}
                onClone={() => handleCloneWorkflow(workflow.id)}
                onDelete={() => handleDeleteWorkflow(workflow.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      {/* Recent Executions */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-secondary-900">
            {t('recentExecutions')}
          </h2>
          {recentExecutions.length > 0 && (
            <Button variant="ghost" onClick={() => navigate('/executions')}>
              {t('viewAll')}
            </Button>
          )}
        </div>
        {recentExecutions.length === 0 ? (
          <Card>
            <CardBody className="text-center py-8">
              <p className="text-secondary-600">
                {t('noExecutionsYet')}
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentExecutions.map((execution) => (
              <ExecutionRow
                key={execution.id}
                execution={execution}
                onClick={() => navigate(`/executions/${execution.id}`)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface WorkflowCardProps {
  workflow: WorkflowDefinition;
  onRun?: () => void;
  onEdit?: () => void;
  onClone?: () => void;
  onDelete?: () => void;
  t: (key: any) => string;
}

function WorkflowCard({ workflow, onRun, onEdit, onClone, onDelete, t }: WorkflowCardProps) {
  const { language } = useLanguage();
  const [translatedName, setTranslatedName] = useState(workflow.name);
  const [translatedDesc, setTranslatedDesc] = useState(workflow.description || '');

  useEffect(() => {
    if (language === 'en') {
      setTranslatedName(workflow.name);
      setTranslatedDesc(workflow.description || '');
    } else {
      translateText(workflow.name, 'en', language).then(setTranslatedName);
      if (workflow.description) {
        translateText(workflow.description, 'en', language).then(setTranslatedDesc);
      }
    }
  }, [workflow.name, workflow.description, language]);

  return (
    <Card hoverable className="flex flex-col">
      <CardBody className="flex-1">
        <div className="flex items-start justify-between">
          <h3 className="font-semibold text-secondary-900">{translatedName}</h3>
          <span className="text-sm text-secondary-500">
            {workflow.step_count || 0} steps
          </span>
        </div>
        <p className="text-sm text-secondary-600 mt-2 line-clamp-2">
          {translatedDesc || t('noDescription')}
        </p>
      </CardBody>
      <div className="px-6 py-3 border-t border-secondary-100 flex items-center justify-between">
        {onRun && (
          <Button size="sm" onClick={onRun}>
            {t('run')}
          </Button>
        )}
        <div className="flex items-center space-x-2">
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t('edit')}
            </Button>
          )}
          {onClone && (
            <Button size="sm" variant="ghost" onClick={onClone}>
              {t('clone')}
            </Button>
          )}
          {onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete}>
              {t('delete')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

interface SkillCardProps {
  skill: WorkflowDefinition;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: any) => string;
}

function SkillCard({ skill, onEdit, onDelete, t }: SkillCardProps) {
  const { language } = useLanguage();
  const [translatedName, setTranslatedName] = useState(skill.name);
  const [translatedDesc, setTranslatedDesc] = useState(skill.description || '');
  const [skillType, setSkillType] = useState<'AI' | 'API'>('AI');

  useEffect(() => {
    if (language === 'en') {
      setTranslatedName(skill.name);
      setTranslatedDesc(skill.description || '');
    } else {
      translateText(skill.name, 'en', language).then(setTranslatedName);
      if (skill.description) {
        translateText(skill.description, 'en', language).then(setTranslatedDesc);
      }
    }
  }, [skill.name, skill.description, language]);

  // Determine skill type: "API" if any step is scraping, otherwise "AI"
  useEffect(() => {
    if (skill.steps && skill.steps.length > 0) {
      // Steps are available, check step types
      const hasScrapingStep = skill.steps.some(step => step.step_type === 'scraping');
      setSkillType(hasScrapingStep ? 'API' : 'AI');
    } else {
      // Steps not loaded, fetch full skill to determine type
      api.getSkill(skill.id).then(fullSkill => {
        if (fullSkill.steps && fullSkill.steps.length > 0) {
          const hasScrapingStep = fullSkill.steps.some((step: any) => step.step_type === 'scraping');
          setSkillType(hasScrapingStep ? 'API' : 'AI');
        }
      }).catch(() => {
        // If fetch fails, default to 'AI'
        setSkillType('AI');
      });
    }
  }, [skill.id, skill.steps]);

  return (
    <Card hoverable className="flex flex-col" onClick={onEdit}>
      <CardBody className="flex-1">
        <div className="flex items-start justify-between">
          <h3 className="font-semibold text-secondary-900">{translatedName}</h3>
          <span className="inline-block px-2 py-0.5 text-xs font-medium bg-primary-100 text-primary-700 rounded">
            {skillType}
          </span>
        </div>
        <p className="text-sm text-secondary-600 mt-2 line-clamp-2">
          {translatedDesc || t('noDescription')}
        </p>
      </CardBody>
      <div className="px-6 py-3 border-t border-secondary-100 flex items-center justify-end">
        <div className="flex items-center space-x-2">
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            {t('edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            {t('delete')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

interface ExecutionRowProps {
  execution: WorkflowExecution;
  onClick: () => void;
  t: (key: any) => string;
}

function ExecutionRow({ execution, onClick, t }: ExecutionRowProps) {
  const { language } = useLanguage();
  const [translatedName, setTranslatedName] = useState(execution.recipe_name || `Workflow #${execution.recipe_id}`);

  useEffect(() => {
    const recipeName = execution.recipe_name || `Workflow #${execution.recipe_id}`;
    if (language === 'en') {
      setTranslatedName(recipeName);
    } else {
      translateText(recipeName, 'en', language).then(setTranslatedName);
    }
  }, [execution.recipe_name, execution.recipe_id, language]);

  const statusColors: Record<string, string> = {
    pending: 'bg-secondary-100 text-secondary-700',
    running: 'bg-blue-100 text-blue-700',
    paused: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  };

  const statusLabels: Record<string, string> = {
    pending: t('pending'),
    running: t('running'),
    paused: t('paused'),
    completed: t('completed'),
    failed: t('failed'),
  };

  return (
    <Card hoverable onClick={onClick}>
      <CardBody className="flex items-center justify-between py-3">
        <div className="flex items-center space-x-4">
          <span className={`px-2 py-1 text-xs font-medium rounded ${statusColors[execution.status]}`}>
            {statusLabels[execution.status] || execution.status}
          </span>
          <span className="font-medium text-secondary-900">
            {translatedName}
          </span>
        </div>
        <div className="flex items-center space-x-4 text-sm text-secondary-500">
          <span>
            {t('currentStep')} {execution.current_step}/{execution.total_steps || '?'}
          </span>
          <span>
            {new Date(execution.created_at).toLocaleDateString()}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
