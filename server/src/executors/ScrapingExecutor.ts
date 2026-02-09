import { RecipeStep, ScrapingPlatform } from '../types';
import { scrapeReviews, isBrightDataConfigured } from '../services/brightDataService';
import { parseReviewCSV } from '../services/csvParserService';
import { logUsage } from '../services/usageTrackingService';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export class ScrapingExecutor implements StepExecutor {
  type = 'scraping';
  displayName = 'Web Scraping';
  icon = '🔍';
  description = 'Scrape product reviews from e-commerce platforms using BrightData';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    // Scraping steps need input_config with variables or api_config
    if (!step.input_config && !step.api_config) {
      errors.push('Scraping step requires input configuration or API configuration');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    // Parse API config to determine service
    let apiConfig = { service: 'brightdata', endpoint: 'scrape_reviews' };
    if (step.api_config) {
      try {
        apiConfig = JSON.parse(step.api_config);
      } catch {
        // Use defaults
      }
    }

    const { userInputs, userId } = context;

    // Get input variables
    let urls: string[] = [];
    let csvData: string | undefined;
    let platform: ScrapingPlatform | undefined;

    // Check for URLs from user input
    if (userInputs.product_urls) {
      if (Array.isArray(userInputs.product_urls)) {
        urls = userInputs.product_urls;
      } else if (typeof userInputs.product_urls === 'string') {
        urls = userInputs.product_urls
          .split(/[\n,]/)
          .map((url: string) => url.trim())
          .filter((url: string) => url.length > 0);
      }
    }

    // Check for CSV data
    if (userInputs.csv_data) {
      csvData = userInputs.csv_data;
    } else if (userInputs.csv_file) {
      csvData = typeof userInputs.csv_file === 'string'
        ? userInputs.csv_file
        : userInputs.csv_file?.content || userInputs.csv_file;
    }

    // Check for platform specification
    if (userInputs.platform) {
      platform = userInputs.platform as ScrapingPlatform;
    }

    // Validate input
    if (urls.length === 0 && !csvData) {
      return {
        success: false,
        content: '',
        error: 'No product URLs or CSV data provided for scraping',
      };
    }

    let scrapedData: any[] = [];
    let usageInfo = { requests_made: 0, reviews_fetched: 0 };

    // Process CSV data if provided
    if (csvData) {
      const parseResult = parseReviewCSV(csvData, platform);
      if (parseResult.success && parseResult.data) {
        scrapedData = parseResult.data;
        usageInfo.reviews_fetched += parseResult.data.length;
      } else if (!parseResult.success && urls.length === 0) {
        return {
          success: false,
          content: '',
          error: parseResult.error || 'Failed to parse CSV data',
        };
      }
    }

    // Scrape URLs if provided
    if (urls.length > 0) {
      if (!isBrightDataConfigured()) {
        return {
          success: false,
          content: '',
          error: 'BrightData is not configured. Please set BRIGHTDATA_API_KEY environment variable.',
        };
      }

      const scrapingResult = await scrapeReviews(urls);

      if (scrapingResult.success && scrapingResult.data) {
        for (const product of scrapingResult.data) {
          scrapedData.push(...product.reviews.map(review => ({
            ...review,
            product_url: product.url,
            product_name: product.product_name,
            product_price: product.product_price,
            product_features: product.product_features,
          })));
        }

        if (scrapingResult.usage) {
          usageInfo.requests_made += scrapingResult.usage.requests_made;
          usageInfo.reviews_fetched += scrapingResult.usage.reviews_fetched;
        }
      } else if (!scrapingResult.success && scrapedData.length === 0) {
        return {
          success: false,
          content: '',
          error: scrapingResult.error || 'Failed to scrape reviews from URLs',
        };
      }
    }

    // Log usage for billing
    logUsage(
      userId,
      apiConfig.service,
      apiConfig.endpoint,
      usageInfo.requests_made,
      usageInfo.reviews_fetched
    );

    // Format output data
    const outputContent = JSON.stringify({
      reviews: scrapedData,
      summary: {
        total_reviews: scrapedData.length,
        urls_processed: urls.length,
        csv_rows_processed: csvData ? scrapedData.length - (urls.length > 0 ? scrapedData.length : 0) : 0,
      }
    }, null, 2);

    return {
      success: true,
      content: outputContent,
      metadata: {
        service: apiConfig.service,
        usage: usageInfo,
        stepType: 'scraping',
      },
      promptUsed: `Scraped ${urls.length} URL(s), processed ${scrapedData.length} reviews`,
      modelUsed: `${apiConfig.service}:${apiConfig.endpoint}`,
    };
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'service',
          label: 'Scraping Service',
          type: 'select',
          required: true,
          defaultValue: 'brightdata',
          options: [
            { value: 'brightdata', label: 'BrightData' },
          ],
        },
        {
          name: 'endpoint',
          label: 'Endpoint',
          type: 'select',
          required: true,
          defaultValue: 'scrape_reviews',
          options: [
            { value: 'scrape_reviews', label: 'Scrape Reviews' },
          ],
        },
      ],
    };
  }
}
