import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { Layout } from './components/common';
import { Dashboard } from './components/Dashboard';
import { RecipeBuilder, RecipeRunner } from './components/RecipeBuilder';
import { TemplateEditor } from './components/TemplateEditor';
import { ExecutionList, ExecutionView } from './components/WorkflowExecution';
import { StandardsManager } from './components/CompanyStandards';
import { OutputsGallery } from './components/OutputsGallery';
import { UsageDashboard } from './components/ReviewAnalysis';

function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <BrowserRouter>
        <Layout>
          <Routes>
            {/* Dashboard */}
            <Route path="/" element={<Dashboard />} />

            {/* Template Routes */}
            <Route path="/templates/new" element={<TemplateEditor />} />
            <Route path="/templates/:id" element={<TemplateEditor />} />

            {/* Recipe Routes */}
            <Route path="/recipes/new" element={<RecipeBuilder />} />
            <Route path="/recipes/:id" element={<RecipeBuilder />} />
            <Route path="/recipes/:id/run" element={<RecipeRunner />} />

            {/* Execution Routes */}
            <Route path="/executions" element={<ExecutionList />} />
            <Route path="/executions/:id" element={<ExecutionView />} />

            {/* Outputs Gallery */}
            <Route path="/outputs" element={<OutputsGallery />} />

            {/* Standards Routes */}
            <Route path="/standards" element={<StandardsManager />} />

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
          Track your BrightData scraping usage and estimated costs
        </p>
      </div>
      <UsageDashboard showBilling={true} />
    </div>
  );
}

export default App;
