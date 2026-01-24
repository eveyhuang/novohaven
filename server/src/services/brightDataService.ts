import { ScrapingPlatform, ScrapedProductData, ReviewData, ScrapingResponse } from '../types';

// BrightData configuration
const BRIGHTDATA_API_BASE = 'https://api.brightdata.com';

// Read API key lazily to ensure dotenv has loaded it
function getBrightDataApiKey(): string | undefined {
  return process.env.BRIGHTDATA_API_KEY;
}

// Dataset IDs for each platform (these are BrightData's pre-built e-commerce scrapers)
// Default dataset ID from the official example - update with your actual dataset IDs
const PLATFORM_DATASETS: Record<ScrapingPlatform, string> = {
  amazon: process.env.BRIGHTDATA_AMAZON_DATASET || 'gd_le8e811kzy4ggddlq',
  walmart: process.env.BRIGHTDATA_WALMART_DATASET || 'gd_le8e811kzy4ggddlq', // Update with actual Walmart dataset
  wayfair: process.env.BRIGHTDATA_WAYFAIR_DATASET || 'gd_le8e811kzy4ggddlq', // Update with actual Wayfair dataset
};

// Detect platform from URL
export function detectPlatform(url: string): ScrapingPlatform | null {
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.includes('amazon.')) return 'amazon';
  if (normalizedUrl.includes('walmart.')) return 'walmart';
  if (normalizedUrl.includes('wayfair.')) return 'wayfair';
  return null;
}

// Check if BrightData is configured
export function isBrightDataConfigured(): boolean {
  const apiKey = getBrightDataApiKey();
  // Debug logging (remove in production if needed)
  if (!apiKey) {
    console.log('[BrightData] API key not found in process.env.BRIGHTDATA_API_KEY');
    console.log('[BrightData] Available env vars with BRIGHTDATA:', Object.keys(process.env).filter(k => k.includes('BRIGHT')));
  }
  return !!apiKey;
}

// Helper function to make HTTPS requests
function makeHttpsRequest(options: any, data?: string, timeoutMs: number = 120000): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const https = require('https');
    let isResolved = false;

    console.log(`[BrightData] Making ${options.method || 'GET'} request to: ${options.hostname}${options.path}`);
    
    const req = https.request(options, (res: any) => {
      let responseData = '';
      
      console.log(`[BrightData] Response received: status ${res.statusCode}, headers:`, res.headers);
      
      res.on('data', (chunk: Buffer) => {
        responseData += chunk.toString();
      });
      
      res.on('end', () => {
        if (isResolved) return;
        isResolved = true;
        console.log(`[BrightData] Response complete: ${responseData.length} bytes`);
        resolve({ statusCode: res.statusCode || 0, data: responseData });
      });
    });

    req.on('error', (error: Error) => {
      if (isResolved) return;
      isResolved = true;
      console.error(`[BrightData] Request error:`, error.message);
      reject(error);
    });

    req.setTimeout(timeoutMs, () => {
      if (isResolved) return;
      isResolved = true;
      console.error(`[BrightData] Request timeout after ${timeoutMs}ms`);
      req.destroy();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    if (data) {
      req.write(data);
    }
    req.end();
  });
}

// Poll for snapshot progress - primarily check download endpoint (most reliable)
async function pollSnapshotProgress(apiKey: string, snapshotId: string): Promise<boolean> {
  const maxAttempts = 120; // Poll for up to 10 minutes (120 * 5 seconds)
  const pollInterval = 5000; // 5 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Primary check: Try to download the snapshot
      // This is the most reliable way - 200 means ready, 202 means not ready
      const downloadOptions = {
        hostname: 'api.brightdata.com',
        path: `/datasets/v3/snapshot/${snapshotId}?format=json`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      };

      const downloadResponse = await makeHttpsRequest(downloadOptions, undefined, 10000);
      
      if (downloadResponse.statusCode === 200) {
        console.log(`[BrightData] Snapshot is ready! (attempt ${attempt + 1}/${maxAttempts})`);
        return true;
      } else if (downloadResponse.statusCode === 202) {
        // 202 means "accepted but not ready yet"
        try {
          const retryData = JSON.parse(downloadResponse.data);
          console.log(`[BrightData] Progress check ${attempt + 1}/${maxAttempts}: Not ready yet - ${retryData.message || 'Waiting...'}`);
        } catch (e) {
          console.log(`[BrightData] Progress check ${attempt + 1}/${maxAttempts}: Not ready yet (202 response)`);
        }
      } else {
        console.error(`[BrightData] Unexpected download response: ${downloadResponse.statusCode} - ${downloadResponse.data}`);
      }

      // Secondary check: Also check progress endpoint for status info (every 3rd attempt)
      if (attempt % 3 === 0) {
        try {
          const progressOptions = {
            hostname: 'api.brightdata.com',
            path: `/datasets/v3/progress/${snapshotId}`,
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
            },
          };

          const progressResponse = await makeHttpsRequest(progressOptions, undefined, 10000);
          if (progressResponse.statusCode === 200) {
            const progressData = JSON.parse(progressResponse.data);
            const status = progressData.status?.toLowerCase();
            
            // Check for error status
            if (status === 'failed' || status === 'error' || progressData.error) {
              console.error(`[BrightData] Snapshot failed:`, progressData);
              return false;
            }
            
            // Log status for debugging
            if (attempt % 6 === 0) { // Log every 6th attempt to avoid spam
              console.log(`[BrightData] Progress status: ${status}`);
            }
          }
        } catch (progressErr) {
          // Ignore progress check errors, continue with download polling
        }
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error: any) {
      console.error(`[BrightData] Error checking progress (attempt ${attempt + 1}):`, error.message);
      // Continue polling on error
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  console.error(`[BrightData] Polling timeout after ${maxAttempts} attempts (${maxAttempts * pollInterval / 1000} seconds)`);
  return false;
}

// Download snapshot data
async function downloadSnapshot(apiKey: string, snapshotId: string): Promise<any> {
  const options = {
    hostname: 'api.brightdata.com',
    path: `/datasets/v3/snapshot/${snapshotId}?format=json`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  };

  const response = await makeHttpsRequest(options);
  
  if (response.statusCode === 202) {
    // 202 means not ready yet - this shouldn't happen if polling worked correctly
    const retryData = JSON.parse(response.data);
    throw new Error(`Snapshot not ready: ${retryData.message || 'Please wait and try again'}`);
  }
  
  if (response.statusCode !== 200) {
    throw new Error(`Failed to download snapshot: ${response.statusCode} - ${response.data}`);
  }

  console.log(`[BrightData] Successfully downloaded snapshot data: ${response.data.length} bytes`);
  return JSON.parse(response.data);
}

// Scrape reviews from a single URL
async function scrapeUrl(url: string, platform: ScrapingPlatform): Promise<ScrapedProductData | null> {
  const apiKey = getBrightDataApiKey();
  if (!apiKey) {
    throw new Error('BRIGHTDATA_API_KEY is not configured');
  }

  const datasetId = PLATFORM_DATASETS[platform];

  try {
    // Step 1: Trigger the scraping job
    const requestBody = {
      input: [{
        url: url,
        reviews_to_not_include: []
      }]
    };

    const data = JSON.stringify(requestBody);
    const path = `/datasets/v3/scrape?dataset_id=${datasetId}&notify=false&include_errors=true`;

    console.log(`[BrightData] Triggering scrape for: ${url}`);
    console.log(`[BrightData] Dataset ID: ${datasetId}`);
    console.log(`[BrightData] Request path: ${path}`);

    const options = {
      hostname: 'api.brightdata.com',
      path: path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };

    // Initial trigger request - should return quickly with snapshot ID
    // Use 5 minute timeout for initial request (BrightData may take time to queue)
    const triggerResponse = await makeHttpsRequest(options, data, 300000);
    
    console.log(`[BrightData] Trigger response status: ${triggerResponse.statusCode}`);
    console.log(`[BrightData] Trigger response data (first 500 chars):`, triggerResponse.data.substring(0, 500));
    
    if (triggerResponse.statusCode !== 200 && triggerResponse.statusCode !== 201 && triggerResponse.statusCode !== 202) {
      console.error(`[BrightData] Trigger failed (status ${triggerResponse.statusCode}):`, triggerResponse.data);
      return null;
    }

    // Parse response to get snapshot ID
    let snapshotId: string;
    try {
      const triggerData = JSON.parse(triggerResponse.data);
      snapshotId = triggerData.snapshot_id || triggerData.snapshotId || triggerData.id;
      
      if (!snapshotId) {
        // Sometimes the snapshot ID might be in the response directly
        // Check if response is already the data (for synchronous responses)
        if (Array.isArray(triggerData) || (triggerData.data && Array.isArray(triggerData.data))) {
          // Data is already available, process it directly
          let reviewsArray: any[] = Array.isArray(triggerData) ? triggerData : triggerData.data;
          if (reviewsArray && reviewsArray.length > 0) {
            console.log(`[BrightData] Received data immediately, processing ${reviewsArray.length} reviews`);
            return transformBrightDataReviewsArray(reviewsArray, url, platform);
          }
        }
        
        console.error(`[BrightData] No snapshot ID in response:`, triggerResponse.data);
        return null;
      }
    } catch (parseErr: any) {
      console.error(`[BrightData] Error parsing trigger response:`, parseErr.message);
      console.error(`[BrightData] Response:`, triggerResponse.data);
      return null;
    }

    console.log(`[BrightData] Snapshot ID: ${snapshotId}, polling for completion...`);

    // Step 2: Poll for completion
    const isReady = await pollSnapshotProgress(apiKey, snapshotId);
    
    if (!isReady) {
      console.error(`[BrightData] Snapshot ${snapshotId} did not complete within timeout`);
      return null;
    }

    console.log(`[BrightData] Snapshot ${snapshotId} is ready, downloading data...`);

    // Step 3: Download the snapshot data
    const snapshotData = await downloadSnapshot(apiKey, snapshotId);

    // Step 4: Process the data
    let reviewsArray: any[] = [];

    if (Array.isArray(snapshotData)) {
      reviewsArray = snapshotData;
    } else if (snapshotData.data && Array.isArray(snapshotData.data)) {
      reviewsArray = snapshotData.data;
    } else {
      console.error(`[BrightData] Unexpected snapshot data structure:`, Object.keys(snapshotData));
      return null;
    }

    if (!reviewsArray || reviewsArray.length === 0) {
      console.error(`[BrightData] No reviews found in snapshot`);
      return null;
    }

    console.log(`[BrightData] Successfully downloaded ${reviewsArray.length} reviews`);

    // Transform the array of reviews into our format
    return transformBrightDataReviewsArray(reviewsArray, url, platform);
  } catch (error: any) {
    console.error(`[BrightData] Error scraping ${url}:`, error.message);
    console.error(`[BrightData] Error type:`, error.constructor.name);
    console.error(`[BrightData] Stack:`, error.stack);
    
    // Provide more specific error information
    if (error.message.includes('timeout')) {
      console.error(`[BrightData] Request timed out - BrightData API may be slow or unresponsive`);
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      console.error(`[BrightData] Network error - cannot reach BrightData API`);
    } else if (error.message.includes('Unexpected token') || error.message.includes('JSON')) {
      console.error(`[BrightData] JSON parsing error - response may be malformed`);
    }
    
    return null;
  }
}

// Transform BrightData response array to our format
// BrightData returns an array where each element is a review object
function transformBrightDataReviewsArray(
  reviewsArray: any[],
  url: string,
  platform: ScrapingPlatform
): ScrapedProductData {
  if (reviewsArray.length === 0) {
    return {
      url,
      platform,
      product_name: 'Unknown Product',
      reviews: [],
      scraped_at: new Date().toISOString(),
    };
  }

  // Get product info from the first review (all reviews are for the same product)
  const firstReview = reviewsArray[0];
  const productName = firstReview.product_name || 'Unknown Product';
  const productRating = firstReview.product_rating;
  const productRatingCount = firstReview.product_rating_count;

  // Transform each review object to our ReviewData format
  const reviews: ReviewData[] = reviewsArray.map((review: any, index: number) => ({
    id: review.review_id || `${platform}-${Date.now()}-${index}`,
    platform,
    product_url: review.url || url,
    product_name: review.product_name || productName,
    product_price: review.product_price?.toString(),
    reviewer_name: review.author_name || 'Anonymous',
    rating: parseFloat(review.rating) || 0,
    review_title: review.review_header || '',
    review_text: review.review_text || '',
    review_date: review.review_posted_date || review.timestamp,
    verified_purchase: review.is_verified ?? false,
    helpful_votes: parseInt(review.helpful_count) || 0,
  }));

  // Extract product features/categories if available
  const features: string[] = [];
  if (firstReview.categories && Array.isArray(firstReview.categories)) {
    features.push(...firstReview.categories);
  }
  if (firstReview.department) {
    features.push(`Department: ${firstReview.department}`);
  }
  if (firstReview.brand) {
    features.push(`Brand: ${firstReview.brand}`);
  }

  return {
    url: firstReview.url || url,
    platform,
    product_name: productName,
    product_price: firstReview.product_price?.toString(),
    product_features: features.length > 0 ? features : undefined,
    average_rating: productRating ? parseFloat(productRating.toString()) : undefined,
    total_reviews: productRatingCount ? parseInt(productRatingCount.toString()) : reviews.length,
    reviews,
    scraped_at: new Date().toISOString(),
  };
}

// Main scraping function - scrape multiple URLs
export async function scrapeReviews(urls: string[]): Promise<ScrapingResponse> {
  console.log(`[BrightData] scrapeReviews called with ${urls.length} URL(s):`, urls);
  
  if (!isBrightDataConfigured()) {
    console.error(`[BrightData] Not configured - API key missing`);
    return {
      success: false,
      error: 'BrightData is not configured. Please set BRIGHTDATA_API_KEY environment variable.',
    };
  }

  console.log(`[BrightData] API key found, proceeding with scraping...`);

  const results: ScrapedProductData[] = [];
  let totalReviews = 0;
  const errors: string[] = [];

  for (const url of urls) {
    console.log(`[BrightData] Processing URL ${urls.indexOf(url) + 1}/${urls.length}: ${url}`);
    const platform = detectPlatform(url);

    if (!platform) {
      errors.push(`Unsupported platform for URL: ${url}`);
      continue;
    }

    try {
      const data = await scrapeUrl(url, platform);
      if (data) {
        results.push(data);
        totalReviews += data.reviews.length;
      } else {
        // Check server logs for detailed error - this is a generic failure message
        errors.push(`Failed to scrape: ${url} (check server logs for details)`);
      }
    } catch (error: any) {
      errors.push(`Error scraping ${url}: ${error.message}`);
    }
  }

  return {
    success: results.length > 0,
    data: results,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    usage: {
      requests_made: urls.length,
      reviews_fetched: totalReviews,
    },
  };
}

// Mock scraping for testing (when BrightData is not configured)
export async function scrapeReviewsMock(urls: string[]): Promise<ScrapingResponse> {
  await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate delay

  const results: ScrapedProductData[] = urls.map((url, urlIndex) => {
    const platform = detectPlatform(url) || 'amazon';
    const reviewCount = 5 + Math.floor(Math.random() * 10);

    const reviews: ReviewData[] = Array.from({ length: reviewCount }, (_, i) => ({
      id: `mock-${urlIndex}-${i}`,
      platform,
      product_url: url,
      product_name: `Sample Product ${urlIndex + 1}`,
      product_price: `$${(29.99 + Math.random() * 100).toFixed(2)}`,
      reviewer_name: `Reviewer ${i + 1}`,
      rating: Math.floor(Math.random() * 5) + 1,
      review_title: i % 2 === 0 ? 'Great product!' : 'Could be better',
      review_text: i % 2 === 0
        ? 'This product exceeded my expectations. The quality is excellent and it arrived quickly. Highly recommend!'
        : 'The product is okay but I expected better quality for the price. Shipping was slow and packaging could be improved.',
      review_date: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
      verified_purchase: Math.random() > 0.3,
      helpful_votes: Math.floor(Math.random() * 50),
    }));

    return {
      url,
      platform,
      product_name: `Sample Product ${urlIndex + 1}`,
      product_price: `$${(29.99 + Math.random() * 100).toFixed(2)}`,
      product_features: ['Feature 1', 'Feature 2', 'Feature 3'],
      average_rating: 3.5 + Math.random() * 1.5,
      total_reviews: reviewCount,
      reviews,
      scraped_at: new Date().toISOString(),
    };
  });

  const totalReviews = results.reduce((sum, r) => sum + r.reviews.length, 0);

  return {
    success: true,
    data: results,
    usage: {
      requests_made: urls.length,
      reviews_fetched: totalReviews,
    },
  };
}

// Export function that uses mock when BrightData is not configured
export async function scrapeReviewsWithFallback(
  urls: string[],
  platform?: 'amazon' | 'walmart' | 'wayfair'
): Promise<ScrapingResponse> {
  // Note: platform parameter is available for future use when BrightData
  // supports platform-specific endpoints
  if (isBrightDataConfigured()) {
    return scrapeReviews(urls);
  }
  console.log('BrightData not configured, using mock data');
  return scrapeReviewsMock(urls);
}
