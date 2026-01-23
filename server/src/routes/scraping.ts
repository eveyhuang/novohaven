import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  scrapeReviewsWithFallback,
  isBrightDataConfigured,
  detectPlatform,
} from '../services/brightDataService';
import { parseReviewCSV, reviewsToCSV, reviewsToJSON } from '../services/csvParserService';
import { logUsage } from '../services/usageTrackingService';
import { ScrapingPlatform, ReviewData, ScrapedProductData } from '../types';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/scraping/status - Check scraping service status
router.get('/status', (req: Request, res: Response) => {
  res.json({
    brightdata_configured: isBrightDataConfigured(),
    supported_platforms: ['amazon', 'walmart', 'wayfair'],
    csv_upload_enabled: true,
  });
});

// POST /api/scraping/reviews - Scrape reviews from URLs
router.post('/reviews', async (req: Request, res: Response) => {
  try {
    const { urls } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      res.status(400).json({ error: 'urls array is required' });
      return;
    }

    // Validate URLs and detect platforms
    const validatedUrls: { url: string; platform: ScrapingPlatform }[] = [];
    const invalidUrls: string[] = [];

    for (const url of urls) {
      const platform = detectPlatform(url);
      if (platform) {
        validatedUrls.push({ url, platform });
      } else {
        invalidUrls.push(url);
      }
    }

    if (validatedUrls.length === 0) {
      res.status(400).json({
        error: 'No valid URLs provided',
        invalid_urls: invalidUrls,
        supported_platforms: ['amazon', 'walmart', 'wayfair'],
      });
      return;
    }

    // Scrape reviews
    const result = await scrapeReviewsWithFallback(validatedUrls.map(v => v.url));

    // Log usage
    if (result.usage) {
      logUsage(
        userId,
        'brightdata',
        'scrape_reviews',
        result.usage.requests_made,
        result.usage.reviews_fetched,
        { urls: validatedUrls.map(v => v.url) }
      );
    }

    // Return result with any warnings about invalid URLs
    res.json({
      ...result,
      invalid_urls: invalidUrls.length > 0 ? invalidUrls : undefined,
    });

  } catch (error: any) {
    console.error('Scraping error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/scraping/csv/parse - Parse uploaded CSV
router.post('/csv/parse', (req: Request, res: Response) => {
  try {
    const { content, platform, product_url } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!content) {
      res.status(400).json({ error: 'CSV content is required' });
      return;
    }

    const result = parseReviewCSV(
      content,
      platform || 'amazon',
      product_url
    );

    // Log usage (CSV parsing is free, but we track it)
    if (result.success && result.data) {
      logUsage(
        userId,
        'csv_upload',
        'parse_reviews',
        1,
        result.data.length
      );
    }

    res.json(result);

  } catch (error: any) {
    console.error('CSV parse error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/scraping/export - Export reviews to CSV or JSON
router.post('/export', (req: Request, res: Response) => {
  try {
    const { reviews, format } = req.body;

    if (!reviews || !Array.isArray(reviews)) {
      res.status(400).json({ error: 'reviews array is required' });
      return;
    }

    const exportFormat = format || 'json';

    if (exportFormat === 'csv') {
      const csv = reviewsToCSV(reviews);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=reviews.csv');
      res.send(csv);
    } else {
      const json = reviewsToJSON(reviews);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=reviews.json');
      res.send(json);
    }

  } catch (error: any) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/scraping/normalize - Normalize mixed review data to standard format
router.post('/normalize', (req: Request, res: Response) => {
  try {
    const { scraped_data, csv_reviews } = req.body;

    const allReviews: ReviewData[] = [];

    // Add reviews from scraped data
    if (scraped_data && Array.isArray(scraped_data)) {
      for (const product of scraped_data as ScrapedProductData[]) {
        allReviews.push(...product.reviews);
      }
    }

    // Add reviews from CSV
    if (csv_reviews && Array.isArray(csv_reviews)) {
      allReviews.push(...csv_reviews);
    }

    // Return normalized data grouped by product
    const byProduct: Record<string, {
      product_name: string;
      product_url: string;
      platform: ScrapingPlatform;
      reviews: ReviewData[];
      average_rating: number;
    }> = {};

    for (const review of allReviews) {
      const key = review.product_url || review.product_name || 'unknown';
      if (!byProduct[key]) {
        byProduct[key] = {
          product_name: review.product_name || 'Unknown Product',
          product_url: review.product_url,
          platform: review.platform,
          reviews: [],
          average_rating: 0,
        };
      }
      byProduct[key].reviews.push(review);
    }

    // Calculate average ratings
    for (const key of Object.keys(byProduct)) {
      const ratings = byProduct[key].reviews
        .map(r => r.rating)
        .filter(r => r > 0);
      if (ratings.length > 0) {
        byProduct[key].average_rating =
          ratings.reduce((a, b) => a + b, 0) / ratings.length;
      }
    }

    res.json({
      success: true,
      total_reviews: allReviews.length,
      products: Object.values(byProduct),
      all_reviews: allReviews,
    });

  } catch (error: any) {
    console.error('Normalize error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
