import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { NotificationProvider } from './context/NotificationContext';
import { Layout, Notifications } from './components/common';
import { Dashboard } from './components/Dashboard';
import { WorkflowEditor, WorkflowRunner } from './components/RecipeBuilder';
import { SkillEditor } from './components/SkillEditor';
import { ExecutionList } from './components/WorkflowExecution';
import ChatExecution from './components/ChatExecution/ChatExecution';
import { StandardsManager } from './components/CompanyStandards';
import { OutputsGallery } from './components/OutputsGallery';
import { UsageDashboard } from './components/ReviewAnalysis';
import { AIWorkflowBuilder } from './components/WorkflowBuilder';
import { ManusAgentPage } from './components/ManusAgent/ManusAgentPage';
import { AgentChat } from './components/AgentChat/AgentChat';
import { SessionMonitor } from './components/SessionMonitor/SessionMonitor';
import { PluginManager } from './components/PluginManager/PluginManager';
import { DraftList } from './components/SkillDraftReview/DraftList';

function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <BrowserRouter>
        <NotificationProvider>
        <Notifications />
        <Layout>
          <Routes>
            {/* Dashboard */}
            <Route path="/" element={<Dashboard />} />

            {/* Skill Routes */}
            <Route path="/skills/new" element={<SkillEditor />} />
            <Route path="/skills/:id" element={<SkillEditor />} />

            {/* Workflow Routes */}
            <Route path="/workflows/new" element={<WorkflowEditor />} />
            <Route path="/workflows/:id" element={<WorkflowEditor />} />
            <Route path="/workflows/:id/run" element={<WorkflowRunner />} />

            {/* Agent Chat */}
            <Route path="/chat" element={<AgentChat />} />

            {/* Session Monitor */}
            <Route path="/sessions" element={<SessionMonitor />} />

            {/* Plugin Manager */}
            <Route path="/plugins" element={<PluginManager />} />

            {/* Skill Draft Review */}
            <Route path="/drafts" element={<DraftList />} />

            {/* Execution Routes */}
            <Route path="/executions" element={<ExecutionList />} />
            <Route path="/executions/:id" element={<ChatExecution />} />

            {/* Outputs Gallery */}
            <Route path="/outputs" element={<OutputsGallery />} />

            {/* Standards Routes */}
            <Route path="/standards" element={<StandardsManager />} />

            {/* AI Workflow Builder */}
            <Route path="/workflows/ai-builder" element={<AIWorkflowBuilder />} />

            {/* Manus AI Agent */}
            <Route path="/manus" element={<ManusAgentPage />} />

            {/* Usage Dashboard */}
            <Route path="/usage" element={<UsageDashboardPage />} />

            {/* 404 */}
            <Route
              path="*"
              element={<NotFoundPage />}
            />
          </Routes>
        </Layout>
        </NotificationProvider>
      </BrowserRouter>
      </AuthProvider>
    </LanguageProvider>
  );
}

// Usage Dashboard Page wrapper
function UsageDashboardPage() {
  const { t } = useLanguage();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">{t('usage')}</h1>
        <p className="text-secondary-600 mt-1">
          {t('usagePageSubtitle')}
        </p>
      </div>
      <UsageDashboard showBilling={true} />
    </div>
  );
}

function NotFoundPage() {
  const { t } = useLanguage();

  return (
    <div className="text-center py-12">
      <h1 className="text-2xl font-bold text-secondary-900">{t('pageNotFound')}</h1>
      <p className="text-secondary-600 mt-2">
        {t('pageNotFoundDesc')}
      </p>
    </div>
  );
}

export default App;
