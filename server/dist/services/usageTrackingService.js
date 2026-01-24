"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logUsage = logUsage;
exports.getUserUsageStats = getUserUsageStats;
exports.getUserUsageHistory = getUserUsageHistory;
exports.getAllUsageAdmin = getAllUsageAdmin;
exports.generateBillingReport = generateBillingReport;
const database_1 = require("../models/database");
// Log API usage
function logUsage(userId, service, endpoint, requestCount = 1, recordsFetched = 0, metadata) {
    try {
        database_1.queries.logApiUsage(userId, service, endpoint, requestCount, recordsFetched, metadata ? JSON.stringify(metadata) : undefined);
    }
    catch (error) {
        console.error('Failed to log API usage:', error.message);
        // Don't throw - usage logging should not break the main operation
    }
}
// Get usage statistics for a user
function getUserUsageStats(userId) {
    const stats = database_1.queries.getUsageStats(userId);
    const byService = database_1.queries.getUsageByService(userId);
    const serviceBreakdown = {};
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
function getUserUsageHistory(userId, service) {
    if (service) {
        return database_1.queries.getUsageByUserAndService(userId, service);
    }
    return database_1.queries.getUsageByUser(userId);
}
// Get admin view of all users' usage (for billing)
function getAllUsageAdmin() {
    return database_1.queries.getAllUsageAdmin();
}
// Helper to format usage for billing report
function generateBillingReport(userId) {
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
//# sourceMappingURL=usageTrackingService.js.map