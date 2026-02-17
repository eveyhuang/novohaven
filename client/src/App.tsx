import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { NotificationProvider } from './context/NotificationContext';
import { Layout, Notifications } from './components/common';
import { Dashboard } from './components/Dashboard';
import { WorkflowEditor, WorkflowRunner } from './components/RecipeBuilder';
import { SkillEditor } from './components/TemplateEditor';
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

            {/* Skill Routes (was Templates) */}
            <Route path="/skills/new" element={<SkillEditor />} />
            <Route path="/skills/:id" element={<SkillEditor />} />

            {/* Workflow Routes (was Recipes) */}
            <Route path="/workflows/new" element={<WorkflowEditor />} />
            <Route path="/workflows/:id" element={<WorkflowEditor />} />
            <Route path="/workflows/:id/run" element={<WorkflowRunner />} />

            {/* Backward compat routes */}
            <Route path="/templates/new" element={<SkillEditor />} />
            <Route path="/templates/:id" element={<SkillEditor />} />
            <Route path="/recipes/new" element={<WorkflowEditor />} />
            <Route path="/recipes/:id" element={<WorkflowEditor />} />
            <Route path="/recipes/:id/run" element={<WorkflowRunner />} />

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
              element={
                <div className="text-center py-12">
                  <h1 className="text-2xl font-bold text-secondary-900">Page Not Found</h1>
                  <p className="text-secondary-600 mt-2">
                    The page you're looking for doesn't exist.
                  </p>
                </div>
              }
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
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">API Usage</h1>
        <p className="text-secondary-600 mt-1">
          Track your scraping usage and estimated costs
        </p>
      </div>
      <UsageDashboard showBilling={true} />
    </div>
  );
}

export default App;
