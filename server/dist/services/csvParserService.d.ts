import { ScrapingPlatform, ReviewData, CSVParseResult } from '../types';
export declare function parseReviewCSV(content: string, platform?: ScrapingPlatform, productUrl?: string): CSVParseResult;
export declare function reviewsToCSV(reviews: ReviewData[]): string;
export declare function reviewsToJSON(reviews: ReviewData[]): string;
//# sourceMappingURL=csvParserService.d.ts.map