import { ScrapingPlatform, ScrapingResponse } from '../types';
export declare function detectPlatform(url: string): ScrapingPlatform | null;
export declare function isBrightDataConfigured(): boolean;
export declare function scrapeReviews(urls: string[]): Promise<ScrapingResponse>;
export declare function scrapeReviewsMock(urls: string[]): Promise<ScrapingResponse>;
export declare function scrapeReviewsWithFallback(urls: string[], platform?: 'amazon' | 'walmart' | 'wayfair'): Promise<ScrapingResponse>;
//# sourceMappingURL=brightDataService.d.ts.map