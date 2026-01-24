"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectPlatform = detectPlatform;
exports.isBrightDataConfigured = isBrightDataConfigured;
exports.scrapeReviews = scrapeReviews;
exports.scrapeReviewsMock = scrapeReviewsMock;
exports.scrapeReviewsWithFallback = scrapeReviewsWithFallback;
// BrightData configuration
const BRIGHTDATA_API_URL = process.env.BRIGHTDATA_API_URL || 'https://api.brightdata.com/datasets/v3';
const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY;
// Dataset IDs for each platform (these are BrightData's pre-built e-commerce scrapers)
const PLATFORM_DATASETS = {
    amazon: process.env.BRIGHTDATA_AMAZON_DATASET || 'gd_l7q7dkf244hwjntr0',
    walmart: process.env.BRIGHTDATA_WALMART_DATASET || 'gd_l7q7dkf244hwjntr1',
    wayfair: process.env.BRIGHTDATA_WAYFAIR_DATASET || 'gd_l7q7dkf244hwjntr2',
};
// Detect platform from URL
function detectPlatform(url) {
    const normalizedUrl = url.toLowerCase();
    if (normalizedUrl.includes('amazon.'))
        return 'amazon';
    if (normalizedUrl.includes('walmart.'))
        return 'walmart';
    if (normalizedUrl.includes('wayfair.'))
        return 'wayfair';
    return null;
}
// Check if BrightData is configured
function isBrightDataConfigured() {
    return !!BRIGHTDATA_API_KEY;
}
// Scrape reviews from a single URL
async function scrapeUrl(url, platform) {
    if (!BRIGHTDATA_API_KEY) {
        throw new Error('BRIGHTDATA_API_KEY is not configured');
    }
    const datasetId = PLATFORM_DATASETS[platform];
    try {
        // Trigger the scraping job
        const triggerResponse = await fetch(`${BRIGHTDATA_API_URL}/trigger`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                dataset_id: datasetId,
                url: url,
                // Request all available data including reviews
                include_reviews: true,
                format: 'json',
            }),
        });
        if (!triggerResponse.ok) {
            const errorText = await triggerResponse.text();
            console.error(`BrightData trigger failed for ${url}:`, errorText);
            return null;
        }
        const triggerResult = await triggerResponse.json();
        const snapshotId = triggerResult.snapshot_id;
        if (!snapshotId) {
            console.error('No snapshot_id returned from BrightData');
            return null;
        }
        // Poll for results (with timeout)
        const maxAttempts = 30;
        const pollInterval = 2000; // 2 seconds
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            const statusResponse = await fetch(`${BRIGHTDATA_API_URL}/snapshot/${snapshotId}?format=json`, {
                headers: {
                    'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
                },
            });
            if (statusResponse.status === 200) {
                const data = await statusResponse.json();
                return transformBrightDataResponse(data, url, platform);
            }
            else if (statusResponse.status === 202) {
                // Still processing, continue polling
                continue;
            }
            else {
                console.error(`BrightData status check failed:`, await statusResponse.text());
                return null;
            }
        }
        console.error(`BrightData scraping timed out for ${url}`);
        return null;
    }
    catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        return null;
    }
}
// Transform BrightData response to our format
function transformBrightDataResponse(data, url, platform) {
    // BrightData returns different structures per platform, normalize here
    const product = Array.isArray(data) ? data[0] : data;
    const reviews = (product.reviews || []).map((review, index) => ({
        id: review.id || `${platform}-${Date.now()}-${index}`,
        platform,
        product_url: url,
        product_name: product.title || product.name,
        product_price: product.price?.toString(),
        reviewer_name: review.author || review.reviewer_name || 'Anonymous',
        rating: parseFloat(review.rating) || 0,
        review_title: review.title || review.headline,
        review_text: review.text || review.body || review.content || '',
        review_date: review.date || review.review_date,
        verified_purchase: review.verified_purchase ?? review.verified ?? false,
        helpful_votes: parseInt(review.helpful_votes) || 0,
    }));
    // Extract product features
    const features = [];
    if (product.features && Array.isArray(product.features)) {
        features.push(...product.features);
    }
    if (product.specifications && typeof product.specifications === 'object') {
        Object.entries(product.specifications).forEach(([key, value]) => {
            features.push(`${key}: ${value}`);
        });
    }
    return {
        url,
        platform,
        product_name: product.title || product.name || 'Unknown Product',
        product_price: product.price?.toString() || product.final_price?.toString(),
        product_features: features.length > 0 ? features : undefined,
        average_rating: parseFloat(product.rating) || parseFloat(product.average_rating) || undefined,
        total_reviews: parseInt(product.reviews_count) || parseInt(product.total_reviews) || reviews.length,
        reviews,
        scraped_at: new Date().toISOString(),
    };
}
// Main scraping function - scrape multiple URLs
async function scrapeReviews(urls) {
    if (!isBrightDataConfigured()) {
        return {
            success: false,
            error: 'bdts.js: BrightData is not configured. Please set BRIGHTDATA_API_KEY environment variable.',
        };
    }
    const results = [];
    let totalReviews = 0;
    const errors = [];
    for (const url of urls) {
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
            }
            else {
                errors.push(`Failed to scrape: ${url}`);
            }
        }
        catch (error) {
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
async function scrapeReviewsMock(urls) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate delay
    const results = urls.map((url, urlIndex) => {
        const platform = detectPlatform(url) || 'amazon';
        const reviewCount = 5 + Math.floor(Math.random() * 10);
        const reviews = Array.from({ length: reviewCount }, (_, i) => ({
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
async function scrapeReviewsWithFallback(urls, platform) {
    // Note: platform parameter is available for future use when BrightData
    // supports platform-specific endpoints
    if (isBrightDataConfigured()) {
        return scrapeReviews(urls);
    }
    console.log('BrightData not configured, using mock data');
    return scrapeReviewsMock(urls);
}
//# sourceMappingURL=brightDataService.js.map