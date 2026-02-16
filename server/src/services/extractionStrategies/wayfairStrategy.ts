import { Page } from 'puppeteer';
import { ExtractionStrategy, ExtractionResult } from './index';

// Persisted query hash — update when Wayfair deploys new frontend
const GRAPHQL_SHA256_HASH = 'fd486434f7f187089721b27eabba5632a38689ab17ee027f45913299f022cfc9';

// Client version header — may also need periodic updates
const CLIENT_VERSION = 'f30378acf41d5de87e84b9159a0bd400ff4e7d2e';

// nodeId always starts with base64 of "MarketplaceListingVariant:"
const NODE_ID_PATTERN = /TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudD[A-Za-z0-9+/=]+/;

export class WayfairStrategy implements ExtractionStrategy {
  platform = 'wayfair';
  displayName = 'Wayfair Reviews';

  async execute(
    page: Page,
    urls: string[],
    onProgress: (message: string) => void,
  ): Promise<ExtractionResult> {
    const allResults: any[] = [];

    for (const url of urls) {
      try {
        const result = await this.extractFromUrl(page, url, onProgress);
        allResults.push(result);
      } catch (error: any) {
        onProgress(`Error extracting from ${url}: ${error.message}`);
        allResults.push({ url, error: error.message });
      }
    }

    // If single URL, return its data directly; otherwise wrap in array
    const data = allResults.length === 1 ? allResults[0] : allResults;
    const totalReviews = allResults.reduce((sum, r) => sum + (r.totalCount || 0), 0);

    return {
      success: allResults.some(r => !r.error),
      data,
      reviewCount: totalReviews,
    };
  }

  private async extractFromUrl(
    page: Page,
    url: string,
    onProgress: (message: string) => void,
  ): Promise<any> {
    // Step 1: Navigate to product page
    onProgress(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Step 2: Scroll incrementally to load reviews section
    onProgress('Scrolling to load reviews section...');
    for (let scrolled = 0; scrolled < 8000; scrolled += 2000) {
      await page.evaluate((step: number) => {
        window.scrollBy(0, step);
      }, 2000);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Step 3: Extract nodeId from SSR script tags
    onProgress('Extracting product nodeId...');
    const nodeId = await page.evaluate((pattern: string) => {
      const regex = new RegExp(pattern);
      const scripts = Array.from(document.querySelectorAll('script'));
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        const match = text.match(regex);
        if (match) return match[0];
      }
      return null;
    }, NODE_ID_PATTERN.source);

    if (!nodeId) {
      throw new Error('Could not find product nodeId. The page may have changed or CAPTCHA may be blocking.');
    }
    onProgress(`Found nodeId: ${nodeId.slice(0, 40)}...`);

    // Step 4: Get total review count from page content
    onProgress('Getting total review count...');
    const totalCount = await page.evaluate(() => {
      const text = document.body.innerText;
      // Look for patterns like "64 Reviews" or "Based on 64 reviews"
      const match = text.match(/(?:Based on |Showing \d+-\d+ of )?(\d+)\s+[Rr]eviews?/);
      return match ? parseInt(match[1], 10) : 100; // default to 100 if not found
    });
    onProgress(`Total reviews found: ${totalCount}`);

    // Step 5: Fetch all reviews via GraphQL API (executed inside page context)
    onProgress('Fetching all reviews via GraphQL...');
    const graphqlResult: any = await page.evaluate(
      async (params: { nodeId: string; totalCount: number; hash: string; clientVersion: string }) => {
        try {
          const response = await fetch('https://www.wayfair.com/federation/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-oi-client': 'sf-ui-web',
              'apollographql-client-name': '@wayfair/sf-ui-core-funnel',
              'apollographql-client-version': params.clientVersion,
              'x-wayfair-locale': 'en-US',
              'x-wf-way': 'true',
            },
            credentials: 'include',
            body: JSON.stringify({
              operationName: 'PDPReviewsMPLVByNodeIdDataQuery',
              variables: {
                nodeId: params.nodeId,
                firstImage: 1,
                firstReview: params.totalCount,
                sort: 'RELEVANCE_DESC',
                includeImages: true,
              },
              extensions: {
                persistedQuery: {
                  version: 1,
                  sha256Hash: params.hash,
                },
              },
            }),
          });

          if (!response.ok) {
            return { error: `GraphQL request failed: ${response.status} ${response.statusText}` };
          }

          const data = await response.json();
          return data;
        } catch (err: any) {
          return { error: err.message || 'GraphQL fetch failed' };
        }
      },
      { nodeId, totalCount, hash: GRAPHQL_SHA256_HASH, clientVersion: CLIENT_VERSION },
    );

    if (graphqlResult.error) {
      throw new Error(graphqlResult.error);
    }

    // Step 6: Parse response
    onProgress('Parsing review data...');
    const listingVariant = graphqlResult?.data?.listingVariant;
    if (!listingVariant) {
      throw new Error('Unexpected GraphQL response structure — missing listingVariant');
    }

    const reviewEdges = listingVariant.reviewslist?.reviews?.edges || [];
    const reviews = reviewEdges.map((edge: any) => {
      const r = edge.node;
      return {
        reviewId: r.reviewId,
        name: r.reviewerGivenName,
        location: r.reviewerLocation,
        rating: r.rating,
        date: r.formattedDate,
        body: r.body,
        badge: r.badge,
        badgeDescription: r.badgeDescription,
      };
    });

    const result = {
      url,
      totalCount: listingVariant.reviewslist?.reviews?.totalCount || reviews.length,
      averageRating: listingVariant.reviewsRating?.reviews?.averageRating,
      ratingHistogram: listingVariant.reviewsHistogram?.reviews?.ratingHistogram,
      reviews,
    };

    onProgress(`Extracted ${reviews.length} reviews (avg rating: ${result.averageRating})`);
    return result;
  }
}
