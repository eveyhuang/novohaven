import { Page } from 'puppeteer';

export interface ExtractionResult {
  success: boolean;
  data: any;
  reviewCount?: number;
  error?: string;
}

export interface ExtractionStrategy {
  platform: string;
  displayName: string;
  execute(
    page: Page,
    urls: string[],
    onProgress: (message: string) => void,
  ): Promise<ExtractionResult>;
}

// Strategy registry
const strategies = new Map<string, ExtractionStrategy>();

export function registerStrategy(strategy: ExtractionStrategy): void {
  strategies.set(strategy.platform, strategy);
}

export function getStrategy(platform: string): ExtractionStrategy | undefined {
  return strategies.get(platform);
}

export function getAllStrategies(): ExtractionStrategy[] {
  return Array.from(strategies.values());
}

// Register strategies
import { WayfairStrategy } from './wayfairStrategy';
registerStrategy(new WayfairStrategy());
