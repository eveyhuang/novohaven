import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import { UsageStats, UsageHistoryItem, BillingReport } from '../../types';

interface UsageDashboardProps {
  showBilling?: boolean;
  compact?: boolean;
}

export const UsageDashboard: React.FC<UsageDashboardProps> = ({
  showBilling = true,
  compact = false,
}) => {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [history, setHistory] = useState<UsageHistoryItem[]>([]);
  const [billing, setBilling] = useState<BillingReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'history'>('overview');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statsData, historyData, billingData] = await Promise.all([
        api.getUsageStats(),
        api.getUsageHistory(),
        showBilling ? api.getBillingReport() : Promise.resolve(null),
      ]);
      setStats(statsData);
      setHistory(historyData);
      setBilling(billingData);
    } catch (err: any) {
      setError(err.message || 'Failed to load usage data');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-secondary-200 p-6">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <span className="ml-3 text-secondary-600">Loading usage data...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-secondary-200 p-6">
        <div className="text-center py-8">
          <div className="text-red-500 mb-2">Failed to load usage data</div>
          <div className="text-secondary-600 text-sm mb-4">{error}</div>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-secondary-200 p-4">
        <h3 className="text-sm font-semibold text-secondary-900 mb-3">API Usage</h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <div className="text-xl font-bold text-secondary-900">
              {stats?.total_requests || 0}
            </div>
            <div className="text-xs text-secondary-500">Total Requests</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-secondary-900">
              {stats?.total_records || 0}
            </div>
            <div className="text-xs text-secondary-500">Records Fetched</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-primary-600">
              ${billing?.estimatedCost?.toFixed(2) || '0.00'}
            </div>
            <div className="text-xs text-secondary-500">Est. Cost</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-secondary-200">
      {/* Header */}
      <div className="p-4 border-b border-secondary-200">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-secondary-900">Usage Dashboard</h2>
          <button
            onClick={loadData}
            className="text-sm text-primary-600 hover:text-primary-700"
          >
            Refresh
          </button>
        </div>

        {/* Tabs */}
        <div className="flex space-x-4 mt-4">
          <button
            onClick={() => setActiveTab('overview')}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'overview'
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-secondary-600 hover:text-secondary-900'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'history'
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-secondary-600 hover:text-secondary-900'
            }`}
          >
            History
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {activeTab === 'overview' ? (
          <div className="space-y-6">
            {/* Period Stats */}
            <div>
              <h3 className="text-sm font-medium text-secondary-700 mb-3">Usage by Period</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-secondary-50 rounded-lg p-4">
                  <div className="text-3xl font-bold text-secondary-900">
                    {stats?.by_period.today || 0}
                  </div>
                  <div className="text-sm text-secondary-600">Today</div>
                </div>
                <div className="bg-secondary-50 rounded-lg p-4">
                  <div className="text-3xl font-bold text-secondary-900">
                    {stats?.by_period.this_week || 0}
                  </div>
                  <div className="text-sm text-secondary-600">This Week</div>
                </div>
                <div className="bg-secondary-50 rounded-lg p-4">
                  <div className="text-3xl font-bold text-secondary-900">
                    {stats?.by_period.this_month || 0}
                  </div>
                  <div className="text-sm text-secondary-600">This Month</div>
                </div>
              </div>
            </div>

            {/* Service Breakdown */}
            <div>
              <h3 className="text-sm font-medium text-secondary-700 mb-3">Usage by Service</h3>
              {stats?.by_service && Object.keys(stats.by_service).length > 0 ? (
                <div className="space-y-3">
                  {Object.entries(stats.by_service).map(([service, data]) => (
                    <div
                      key={service}
                      className="flex items-center justify-between p-3 bg-secondary-50 rounded-lg"
                    >
                      <div className="flex items-center space-x-3">
                        <div className={`w-3 h-3 rounded-full ${
                          service === 'brightdata' ? 'bg-blue-500' :
                          service === 'csv_upload' ? 'bg-green-500' :
                          'bg-secondary-500'
                        }`} />
                        <div>
                          <div className="font-medium text-secondary-900 capitalize">
                            {service.replace(/_/g, ' ')}
                          </div>
                          <div className="text-xs text-secondary-500">
                            {data.requests} requests
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium text-secondary-900">
                          {data.records.toLocaleString()}
                        </div>
                        <div className="text-xs text-secondary-500">records</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-secondary-500">
                  No usage data yet. Start by scraping reviews or uploading CSV files.
                </div>
              )}
            </div>

            {/* Billing Info */}
            {showBilling && billing && (
              <div className="bg-primary-50 border border-primary-200 rounded-lg p-4">
                <h3 className="text-sm font-medium text-primary-900 mb-2">Estimated Cost</h3>
                <div className="flex items-baseline">
                  <span className="text-3xl font-bold text-primary-700">
                    ${billing.estimatedCost?.toFixed(2) || '0.00'}
                  </span>
                  <span className="ml-2 text-sm text-primary-600">this billing period</span>
                </div>
                <p className="text-xs text-primary-600 mt-2">
                  Based on BrightData usage: $0.01/request + $0.50/1000 records
                </p>
              </div>
            )}

            {/* Total Stats */}
            <div className="border-t border-secondary-200 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-secondary-900">
                    {stats?.total_requests || 0}
                  </div>
                  <div className="text-sm text-secondary-600">Total API Requests</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-secondary-900">
                    {(stats?.total_records || 0).toLocaleString()}
                  </div>
                  <div className="text-sm text-secondary-600">Total Records Fetched</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* History Tab */
          <div>
            {history.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-secondary-200">
                      <th className="text-left py-2 px-3 font-medium text-secondary-700">Date</th>
                      <th className="text-left py-2 px-3 font-medium text-secondary-700">Service</th>
                      <th className="text-left py-2 px-3 font-medium text-secondary-700">Endpoint</th>
                      <th className="text-right py-2 px-3 font-medium text-secondary-700">Requests</th>
                      <th className="text-right py-2 px-3 font-medium text-secondary-700">Records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.slice(0, 20).map((item) => (
                      <tr key={item.id} className="border-b border-secondary-100 hover:bg-secondary-50">
                        <td className="py-2 px-3 text-secondary-600">
                          {new Date(item.created_at).toLocaleString()}
                        </td>
                        <td className="py-2 px-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            item.service === 'brightdata' ? 'bg-blue-100 text-blue-800' :
                            item.service === 'csv_upload' ? 'bg-green-100 text-green-800' :
                            'bg-secondary-100 text-secondary-800'
                          }`}>
                            {item.service}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-secondary-600">{item.endpoint}</td>
                        <td className="py-2 px-3 text-right text-secondary-900">{item.request_count}</td>
                        <td className="py-2 px-3 text-right text-secondary-900">{item.records_fetched}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {history.length > 20 && (
                  <div className="text-center py-3 text-secondary-500 text-sm">
                    Showing 20 of {history.length} records
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-secondary-500">
                No usage history yet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default UsageDashboard;
