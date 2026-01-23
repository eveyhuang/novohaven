import { queries } from '../models/database';
import { UsageStats } from '../types';

// Log API usage
export function logUsage(
  userId: number,
  service: string,
  endpoint: string,
  requestCount: number = 1,
  recordsFetched: number = 0,
  metadata?: Record<string, any>
): void {
  try {
    queries.logApiUsage(
      userId,
      service,
      endpoint,
      requestCount,
      recordsFetched,
      metadata ? JSON.stringify(metadata) : undefined
    );
  } catch (error: any) {
    console.error('Failed to log API usage:', error.message);
    // Don't throw - usage logging should not break the main operation
  }
}

// Get usage statistics for a user
export function getUserUsageStats(userId: number): UsageStats {
  const stats = queries.getUsageStats(userId);
  const byService = queries.getUsageByService(userId);

  const serviceBreakdown: Record<string, { requests: number; records: number }> = {};
  for (const row of byService) {
    serviceBreakdown[row.service] = {
      requests: row.total_requests || 0,
      records: row.total_records || 0,
    };
  }

  return {
    total_requests: stats?.total_requests || 0,
    total_records: stats?.total_records || 0,
    by_service: serviceBreakdown,
    by_period: {
      today: stats?.today_requests || 0,
      this_week: stats?.week_requests || 0,
      this_month: stats?.month_requests || 0,
    },
  };
}

// Get detailed usage history for a user
export function getUserUsageHistory(userId: number, service?: string) {
  if (service) {
    return queries.getUsageByUserAndService(userId, service);
  }
  return queries.getUsageByUser(userId);
}

// Get admin view of all users' usage (for billing)
export function getAllUsageAdmin() {
  return queries.getAllUsageAdmin();
}

// Helper to format usage for billing report
export function generateBillingReport(userId: number): {
  userId: number;
  stats: UsageStats;
  estimatedCost?: number;
} {
  const stats = getUserUsageStats(userId);

  // Simple cost estimation (you can adjust based on BrightData pricing)
  // BrightData typically charges per successful request or per 1000 records
  const COST_PER_REQUEST = 0.01; // Example: $0.01 per request
  const COST_PER_1000_RECORDS = 0.50; // Example: $0.50 per 1000 records

  const requestCost = (stats.by_service['brightdata']?.requests || 0) * COST_PER_REQUEST;
  const recordCost = ((stats.by_service['brightdata']?.records || 0) / 1000) * COST_PER_1000_RECORDS;

  return {
    userId,
    stats,
    estimatedCost: requestCost + recordCost,
  };
}
