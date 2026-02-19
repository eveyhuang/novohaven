import { RecipeStep } from '../types';
import { browserService } from '../services/browserService';
import { getStrategy, getAllStrategies } from '../services/extractionStrategies';
import { logUsage } from '../services/usageTrackingService';
import { queries } from '../models/database';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export class ScrapingExecutor implements StepExecutor {
  type = 'scraping';
  displayName = 'Browser Scraping';
  icon = '🌐';
  description = 'Scrape reviews from e-commerce platforms using browser automation';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!step.input_config) {
      errors.push('Scraping step requires input configuration');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(_step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    const { userInputs, userId } = context;

    console.log('[ScrapingExecutor] Starting execution');
    console.log('[ScrapingExecutor] User inputs:', JSON.stringify(userInputs, null, 2));
    console.log('[ScrapingExecutor] Step execution ID:', context.stepExecution.id);

    // Parse URLs - accept multiple possible input names
    const rawUrls = userInputs.urls || userInputs.product_urls || userInputs.product_url;
    let urlList: string[] = [];
    if (typeof rawUrls === 'string') {
      urlList = rawUrls.split(/[\n,]/).map((u: string) => u.trim()).filter(Boolean);
    } else if (Array.isArray(rawUrls)) {
      urlList = rawUrls.filter(Boolean);
    }

    console.log('[ScrapingExecutor] Parsed URL list:', urlList);

    if (urlList.length === 0) {
      return {
        success: false,
        content: '',
        error: 'No URLs provided. Please provide at least one URL to scrape.',
      };
    }

    // Determine platform
    const platform = userInputs.platform || this.detectPlatform(urlList[0]);
    console.log('[ScrapingExecutor] Detected platform:', platform);

    if (!platform) {
      return {
        success: false,
        content: '',
        error: 'Could not determine platform. Please select a platform or provide a supported URL.',
      };
    }

    const strategy = getStrategy(platform);
    if (!strategy) {
      const available = getAllStrategies().map(s => s.platform);
      return {
        success: false,
        content: '',
        error: `Unsupported platform: ${platform}. Available: ${available.join(', ')}`,
      };
    }

    // Create browser task
    const browserTaskId = browserService.createTask();
    console.log('[ScrapingExecutor] Created browser task:', browserTaskId);
    
    const task = browserService.getTask(browserTaskId);
    if (!task) {
      console.error('[ScrapingExecutor] CRITICAL: Task not found immediately after creation!');
      return {
        success: false,
        content: '',
        error: 'Failed to create browser task',
      };
    }
    console.log('[ScrapingExecutor] Retrieved task object, status:', task.status);

    const { emitter, executionId } = context;

    try {
      // Store browserTaskId early so frontend can connect to SSE stream
      const earlyMetadata = JSON.stringify({ browserTaskId, stepType: 'scraping', platform });
      console.log('[ScrapingExecutor] Updating step execution with metadata:', earlyMetadata);
      queries.updateStepExecution('running', earlyMetadata, 'browser:scrape', urlList.join(', '), context.stepExecution.id);

      // Emit progress through execution emitter
      if (emitter) {
        const progressMsg = emitter.createMessage({
          executionId,
          stepOrder: context.stepExecution.step_order,
          stepName: _step.step_name,
          stepType: 'scraping',
          type: 'progress',
          role: 'system',
          content: `Starting browser scraping for ${platform}...`,
          metadata: { taskId: browserTaskId },
        });
        emitter.emit(executionId, progressMsg);
      }

      // Brief pause to let frontend connect to SSE stream after navigating
      console.log('[ScrapingExecutor] Waiting 1 second for frontend to connect...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('[ScrapingExecutor] Listener count:', task.emitter.listenerCount('progress'));

      // Emit initial message so UI shows activity immediately
      console.log('[ScrapingExecutor] Emitting initial messages to task', browserTaskId);
      browserService.emit(task, 'message', {
        role: 'system',
        content: [{ type: 'text', text: `Starting browser scraping for ${platform}...` }],
      });

      browserService.emit(task, 'message', {
        role: 'system',
        content: [{ type: 'text', text: `Processing ${urlList.length} URL(s)` }],
      });

      // Launch browser
      console.log('[ScrapingExecutor] Launching browser...');
      const page = await browserService.launchBrowser(browserTaskId);
      console.log('[ScrapingExecutor] Browser launched successfully');

      // Run extraction strategy
      const onProgress = (message: string) => {
        browserService.emit(task, 'message', {
          role: 'system',
          content: [{ type: 'text', text: message }],
        });
        // Also emit through execution emitter
        if (emitter) {
          const progressMsg = emitter.createMessage({
            executionId,
            stepOrder: context.stepExecution.step_order,
            stepName: _step.step_name,
            stepType: 'scraping',
            type: 'progress',
            role: 'system',
            content: message,
            metadata: { taskId: browserTaskId },
          });
          emitter.emit(executionId, progressMsg);
        }
      };

      const result = await strategy.execute(page, urlList, onProgress);

      // Only check for CAPTCHA if extraction failed with no results (page may be blocked)
      // A 429 rate limit or partial failure with some reviews is NOT a CAPTCHA
      const hasCaptcha = !result.success && !result.reviewCount
        ? await browserService.detectCaptcha(browserTaskId)
        : false;
      if (hasCaptcha) {
        onProgress('CAPTCHA detected. Waiting for manual resolution...');
        // Emit action-required for CAPTCHA
        if (emitter) {
          const captchaMsg = emitter.createMessage({
            executionId,
            stepOrder: context.stepExecution.step_order,
            stepName: _step.step_name,
            stepType: 'scraping',
            type: 'action-required',
            role: 'system',
            content: 'CAPTCHA detected. Please resolve manually.',
            metadata: { actionType: 'captcha', taskId: browserTaskId },
          });
          emitter.emit(executionId, captchaMsg);
        }
        await browserService.waitForCaptchaResolution(browserTaskId);
        // Retry extraction
        const retryResult = await strategy.execute(page, urlList, onProgress);
        const output = JSON.stringify(retryResult.data, null, 2);

        // Emit completion event
        browserService.emit(task, 'complete', {
          output,
          reviewCount: retryResult.reviewCount,
        });

        logUsage(userId, 'browser', 'scrape', 1, retryResult.reviewCount || 0, {
          browserTaskId,
          platform,
        });

        return {
          success: retryResult.success,
          content: output,
          metadata: {
            service: 'browser',
            browserTaskId,
            platform,
            reviewCount: retryResult.reviewCount,
            stepType: 'scraping',
          },
          modelUsed: 'browser:scrape',
        };
      }

      const output = JSON.stringify(result.data, null, 2);
      const extractedRows = this.countExtractedReviewRows(result.data);
      const isWayfair = platform === 'wayfair';
      const hasAnyData = result.data !== null && result.data !== undefined;

      // Strict success criteria for review extraction:
      // - Wayfair: must contain at least one extracted review row
      // - Other platforms: allow executor-indicated success or concrete rows
      const treatAsSuccess = isWayfair
        ? extractedRows > 0
        : result.success || extractedRows > 0;

      if (!treatAsSuccess) {
        const reason = result.error
          || (isWayfair
            ? 'Wayfair extraction returned zero review rows.'
            : 'Extraction returned no usable rows.');
        onProgress(`Extraction failed: ${reason}`);
        browserService.emit(task, 'error', { error: reason });
        return {
          success: false,
          content: hasAnyData ? output : '',
          error: reason,
          metadata: {
            service: 'browser',
            browserTaskId,
            platform,
            reviewCount: result.reviewCount || 0,
            extractedRows,
            stepType: 'scraping',
          },
          modelUsed: 'browser:scrape',
        };
      }

      if (!result.success && extractedRows > 0) {
        onProgress('Extraction returned partial/error data; preserving extracted rows.');
      }

      // Emit completion event
      browserService.emit(task, 'complete', {
        output,
        reviewCount: result.reviewCount,
      });

      logUsage(userId, 'browser', 'scrape', 1, result.reviewCount || 0, {
        browserTaskId,
        platform,
      });

      return {
        success: treatAsSuccess,
        content: output,
        metadata: {
          service: 'browser',
          browserTaskId,
          platform,
          reviewCount: result.reviewCount,
          extractedRows,
          extractionSuccess: result.success,
          stepType: 'scraping',
        },
        modelUsed: 'browser:scrape',
      };
    } catch (error: any) {
      // Emit error event to UI
      browserService.emit(task, 'error', {
        error: `Browser scraping error: ${error.message}`,
      });

      return {
        success: false,
        content: '',
        error: `Browser scraping error: ${error.message}`,
      };
    } finally {
      // Don't destroy task immediately - keep it alive for 5 minutes so UI can connect
      console.log('[ScrapingExecutor] Scheduling task cleanup in 5 minutes...');
      setTimeout(async () => {
        console.log('[ScrapingExecutor] Cleaning up browser task:', browserTaskId);
        await browserService.destroyTask(browserTaskId);
      }, 5 * 60 * 1000);
    }
  }

  getConfigSchema(): ExecutorConfigSchema {
    const strategies = getAllStrategies();
    return {
      fields: [
        {
          name: 'platform',
          label: 'Platform',
          type: 'select',
          required: true,
          options: strategies.map(s => ({ value: s.platform, label: s.displayName })),
          helpText: 'Select the e-commerce platform to scrape reviews from.',
        },
        {
          name: 'urls',
          label: 'Product URLs',
          type: 'textarea',
          required: true,
          helpText: 'Product page URLs to extract reviews from, one per line.',
        },
        {
          name: 'maxReviews',
          label: 'Max Reviews',
          type: 'number',
          required: false,
          defaultValue: 100,
          helpText: 'Maximum number of reviews to extract per product (default: 100).',
        },
      ],
    };
  }

  private detectPlatform(url: string): string | null {
    const lower = url.toLowerCase();
    if (lower.includes('wayfair.com')) return 'wayfair';
    if (lower.includes('amazon.com')) return 'amazon';
    if (lower.includes('walmart.com')) return 'walmart';
    return null;
  }

  private countExtractedReviewRows(data: any): number {
    if (!data) return 0;
    if (Array.isArray(data)) {
      return data.reduce((sum, item) => sum + this.countExtractedReviewRows(item), 0);
    }
    if (Array.isArray(data.reviews)) {
      return data.reviews.length;
    }
    if (Array.isArray(data.data)) {
      return data.data.reduce((sum: number, item: any) => sum + this.countExtractedReviewRows(item), 0);
    }
    return 0;
  }
}
