import { UsageStats } from '../types';
export declare function logUsage(userId: number, service: string, endpoint: string, requestCount?: number, recordsFetched?: number, metadata?: Record<string, any>): void;
export declare function getUserUsageStats(userId: number): UsageStats;
export declare function getUserUsageHistory(userId: number, service?: string): any[];
export declare function getAllUsageAdmin(): any[];
export declare function generateBillingReport(userId: number): {
    userId: number;
    stats: UsageStats;
    estimatedCost?: number;
};
//# sourceMappingURL=usageTrackingService.d.ts.map