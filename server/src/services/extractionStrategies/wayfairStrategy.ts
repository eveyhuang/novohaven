import { Page } from 'puppeteer';
import { ExtractionStrategy, ExtractionResult } from './index';

// Legacy fallback values kept for backward compatibility if runtime discovery fails.
const LEGACY_GRAPHQL_SHA256_HASH = 'fd486434f7f187089721b27eabba5632a38689ab17ee027f45913299f022cfc9';
const LEGACY_CLIENT_VERSION = 'f30378acf41d5de87e84b9159a0bd400ff4e7d2e';
const LEGACY_OPERATION_NAME = 'PDPReviewsMPLVByNodeIdDataQuery';

// nodeId always starts with base64 of "MarketplaceListingVariant:".
const NODE_ID_PATTERN = /TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudD[A-Za-z0-9+/=]+/;

type GraphqlDiscovery = {
  hashes: string[];
  clientVersions: string[];
  operationNames: string[];
};

type GraphqlFetchResult = {
  ok: boolean;
  status: number;
  error?: string;
  data?: any;
  diagnostics?: string[];
};

export class WayfairStrategy implements ExtractionStrategy {
  platform = 'wayfair';
  displayName = 'Wayfair Reviews';

  async execute(
    page: Page,
    urls: string[],
    onProgress: (message: string) => void,
  ): Promise<ExtractionResult> {
    const allResults: any[] = [];
    let successCount = 0;
    let totalReviews = 0;

    for (const url of urls) {
      try {
        const result = await this.extractFromUrl(page, url, onProgress);
        allResults.push(result);
        if (!result.error && Array.isArray(result.reviews) && result.reviews.length > 0) {
          successCount += 1;
        }
        totalReviews += Number(result.totalCount || result.reviews?.length || 0);
      } catch (error: any) {
        const message = this.toErrorMessage(error);
        onProgress(`Error extracting from ${url}: ${message}`);
        allResults.push({ url, error: message, reviews: [] });
      }
    }

    // If single URL, return its data directly; otherwise wrap in array
    const data = allResults.length === 1 ? allResults[0] : allResults;

    return {
      success: successCount > 0,
      data,
      reviewCount: totalReviews,
      error: successCount === 0 ? 'Failed to extract reviews from all provided Wayfair URLs.' : undefined,
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

    // Step 2: Scroll incrementally and expose reviews UI
    onProgress('Scrolling to load reviews section...');
    await this.scrollForReviews(page);
    await this.expandReviewSection(page);

    // Step 3: Extract dynamic GraphQL client config from page scripts.
    const discovery = await this.discoverGraphqlConfig(page);
    if (discovery.hashes.length > 0) {
      onProgress(`Discovered ${discovery.hashes.length} GraphQL hash candidate(s) from page runtime.`);
    }

    // Step 4: Pull total count hints from visible page content.
    onProgress('Getting total review count...');
    const pageStats = await this.extractPageStats(page);
    onProgress(`Visible page review hints: total=${pageStats.totalCount || 'unknown'}, avg=${pageStats.averageRating || 'unknown'}`);

    // Step 5: Try GraphQL first when nodeId is available.
    let graphqlError = '';
    const nodeId = await this.extractNodeId(page);
    if (nodeId) {
      onProgress(`Found nodeId: ${nodeId.slice(0, 40)}...`);
      onProgress('Fetching reviews via GraphQL...');
      const graphqlResult = await this.fetchReviewsViaGraphql(page, {
        nodeId,
        targetCount: Math.max(pageStats.totalCount || 0, 50),
        discovery,
      }, onProgress);

      if (graphqlResult.ok && graphqlResult.data) {
        const parsed = this.parseGraphqlReviews(url, graphqlResult.data);
        if (parsed.reviews.length > 0) {
          onProgress(`Extracted ${parsed.reviews.length} reviews via GraphQL.`);
          return {
            ...parsed,
            source: 'graphql',
            diagnostics: graphqlResult.diagnostics || [],
          };
        }
        graphqlError = 'GraphQL returned no review rows.';
      } else {
        graphqlError = graphqlResult.error || `GraphQL request failed (${graphqlResult.status}).`;
      }
    } else {
      graphqlError = 'Could not find product nodeId. Page structure may have changed or access is blocked.';
    }

    // Step 6: Fallback to DOM extraction when GraphQL path fails.
    onProgress(`GraphQL path unavailable: ${graphqlError} Trying DOM fallback extraction...`);
    const domResult = await this.extractReviewsFromDom(page, url);
    if (domResult.reviews.length > 0) {
      onProgress(`Extracted ${domResult.reviews.length} reviews via DOM fallback.`);
      return {
        ...domResult,
        source: 'dom',
        diagnostics: [graphqlError].filter(Boolean),
      };
    }

    throw new Error(
      `${graphqlError} DOM fallback also returned zero reviews. ` +
      'Likely causes: rate limiting, anti-bot wall, or updated review page structure.'
    );
  }

  private async scrollForReviews(page: Page): Promise<void> {
    for (let scrolled = 0; scrolled < 12000; scrolled += 1500) {
      await page.evaluate((step: number) => window.scrollBy(0, step), 1500);
      await this.sleep(600);
    }
  }

  private async expandReviewSection(page: Page): Promise<void> {
    // Try several rounds; each round may reveal additional controls.
    for (let round = 0; round < 8; round++) {
      const clicked = await page.evaluate(() => {
        const patterns = [
          /read all reviews/i,
          /see all reviews/i,
          /load more/i,
          /show more reviews/i,
          /more reviews/i,
          /reviews/i,
        ];

        const isVisible = (el: Element) => {
          const style = window.getComputedStyle(el as HTMLElement);
          const rect = (el as HTMLElement).getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        const candidates = Array.from(document.querySelectorAll('button, a, summary'));
        let clickCount = 0;
        for (const node of candidates) {
          if (clickCount >= 3) break;
          const el = node as HTMLElement;
          if (!isVisible(el)) continue;
          if (el.dataset.novohavenClicked === '1') continue;
          const text = (el.innerText || el.textContent || '').trim();
          if (!text) continue;
          if (!patterns.some((p) => p.test(text))) continue;
          el.dataset.novohavenClicked = '1';
          el.click();
          clickCount += 1;
        }
        return clickCount;
      });

      if (!clicked) break;
      await this.sleep(900);
      await page.evaluate(() => window.scrollBy(0, 900));
      await this.sleep(400);
    }
  }

  private async extractNodeId(page: Page): Promise<string | null> {
    return page.evaluate((pattern: string) => {
      const regex = new RegExp(pattern);
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = text.match(regex);
        if (match && match[0]) {
          return match[0];
        }
      }
      return null;
    }, NODE_ID_PATTERN.source);
  }

  private async extractPageStats(page: Page): Promise<{ totalCount: number; averageRating: number | null }> {
    return page.evaluate(() => {
      const text = document.body.innerText || '';
      const totalMatch = text.match(/(?:Based on |Showing \d+-\d+ of )?(\d{1,5})\s+[Rr]eviews?/);
      const avgMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of 5|\/\s*5|\bstars?\b)/i);
      return {
        totalCount: totalMatch ? parseInt(totalMatch[1], 10) : 0,
        averageRating: avgMatch ? parseFloat(avgMatch[1]) : null,
      };
    });
  }

  private async discoverGraphqlConfig(page: Page): Promise<GraphqlDiscovery> {
    const discovered = await page.evaluate(() => {
      const scriptText = Array.from(document.querySelectorAll('script'))
        .map((s) => s.textContent || '')
        .join('\n');

      const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

      const hashes: string[] = [];
      const hashRegex = /sha256Hash["']?\s*[:=]\s*["']([a-f0-9]{64})["']/gi;
      let hashMatch: RegExpExecArray | null;
      while ((hashMatch = hashRegex.exec(scriptText)) !== null) {
        hashes.push(hashMatch[1]);
      }

      const clientVersions: string[] = [];
      const versionRegex = /apollographql-client-version["']?\s*[:=]\s*["']([A-Za-z0-9._-]{8,128})["']/gi;
      let versionMatch: RegExpExecArray | null;
      while ((versionMatch = versionRegex.exec(scriptText)) !== null) {
        clientVersions.push(versionMatch[1]);
      }

      const operationNames: string[] = [];
      const opRegex = /operationName["']?\s*[:=]\s*["']([A-Za-z0-9_]{8,128})["']/gi;
      let opMatch: RegExpExecArray | null;
      while ((opMatch = opRegex.exec(scriptText)) !== null) {
        const op = opMatch[1];
        if (/review/i.test(op)) {
          operationNames.push(op);
        }
      }

      return {
        hashes: unique(hashes),
        clientVersions: unique(clientVersions),
        operationNames: unique(operationNames),
      };
    });

    return {
      hashes: this.unique([LEGACY_GRAPHQL_SHA256_HASH, ...discovered.hashes]),
      clientVersions: this.unique([LEGACY_CLIENT_VERSION, ...discovered.clientVersions]),
      operationNames: this.unique([LEGACY_OPERATION_NAME, ...discovered.operationNames]),
    };
  }

  private async fetchReviewsViaGraphql(
    page: Page,
    params: { nodeId: string; targetCount: number; discovery: GraphqlDiscovery },
    onProgress: (message: string) => void,
  ): Promise<GraphqlFetchResult> {
    const maxRetries = 3;
    const diagnostics: string[] = [];
    let lastError = 'GraphQL request failed';
    let lastStatus = 0;

    for (const operationName of params.discovery.operationNames) {
      for (const hash of params.discovery.hashes) {
        for (const clientVersion of params.discovery.clientVersions) {
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const attemptResult = await page.evaluate(
              async (payload: {
                nodeId: string;
                firstReview: number;
                hash: string;
                clientVersion: string;
                operationName: string;
              }) => {
                try {
                  const response = await fetch('https://www.wayfair.com/federation/graphql', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-oi-client': 'sf-ui-web',
                      'apollographql-client-name': '@wayfair/sf-ui-core-funnel',
                      'apollographql-client-version': payload.clientVersion,
                      'x-wayfair-locale': 'en-US',
                      'x-wf-way': 'true',
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                      operationName: payload.operationName,
                      variables: {
                        nodeId: payload.nodeId,
                        firstImage: 1,
                        firstReview: payload.firstReview,
                        sort: 'RELEVANCE_DESC',
                        includeImages: true,
                      },
                      extensions: {
                        persistedQuery: {
                          version: 1,
                          sha256Hash: payload.hash,
                        },
                      },
                    }),
                  });

                  if (!response.ok) {
                    return {
                      ok: false,
                      status: response.status,
                      error: `GraphQL request failed: ${response.status}`,
                    };
                  }

                  const json = await response.json();
                  const hasListing = !!json?.data?.listingVariant;
                  if (!hasListing) {
                    return {
                      ok: false,
                      status: response.status,
                      error: 'GraphQL response missing listingVariant',
                    };
                  }

                  return { ok: true, status: response.status, data: json };
                } catch (err: any) {
                  return { ok: false, status: 0, error: err?.message || 'GraphQL fetch failed' };
                }
              },
              {
                nodeId: params.nodeId,
                firstReview: Math.max(50, Math.min(params.targetCount || 50, 2000)),
                hash,
                clientVersion,
                operationName,
              }
            );

            if (attemptResult.ok) {
              diagnostics.push(`GraphQL success with op=${operationName}, hash=${hash.slice(0, 8)}..., version=${clientVersion}`);
              return {
                ok: true,
                status: attemptResult.status,
                data: attemptResult.data,
                diagnostics,
              };
            }

            lastError = attemptResult.error || lastError;
            lastStatus = attemptResult.status || lastStatus;
            diagnostics.push(
              `GraphQL failure op=${operationName}, hash=${hash.slice(0, 8)}..., version=${clientVersion}, status=${attemptResult.status}, attempt=${attempt}: ${attemptResult.error || 'unknown'}`
            );

            if (attemptResult.status === 429 && attempt < maxRetries) {
              const delayMs = attempt * 5000;
              onProgress(`Rate limited (429). Retrying in ${delayMs / 1000}s... (attempt ${attempt}/${maxRetries})`);
              await this.sleep(delayMs);
              continue;
            }
            break;
          }
        }
      }
    }

    return {
      ok: false,
      status: lastStatus,
      error: lastError,
      diagnostics,
    };
  }

  private parseGraphqlReviews(url: string, graphqlPayload: any): {
    url: string;
    totalCount: number;
    averageRating: number | null;
    ratingHistogram: any;
    reviews: any[];
  } {
    const listingVariant = graphqlPayload?.data?.listingVariant;
    const reviewEdges = Array.isArray(listingVariant?.reviewslist?.reviews?.edges)
      ? listingVariant.reviewslist.reviews.edges
      : [];
    const reviews = reviewEdges
      .map((edge: any) => edge?.node)
      .filter(Boolean)
      .map((r: any) => ({
        reviewId: r.reviewId || '',
        name: r.reviewerGivenName || '',
        location: r.reviewerLocation || '',
        rating: r.rating ?? '',
        date: r.formattedDate || '',
        body: r.body || '',
        badge: r.badge || '',
        badgeDescription: r.badgeDescription || '',
      }))
      .filter((r: any) => (r.body && String(r.body).trim().length > 0) || String(r.rating).length > 0);

    return {
      url,
      totalCount: listingVariant?.reviewslist?.reviews?.totalCount || reviews.length,
      averageRating: listingVariant?.reviewsRating?.reviews?.averageRating ?? null,
      ratingHistogram: listingVariant.reviewsHistogram?.reviews?.ratingHistogram,
      reviews,
    };
  }

  private async extractReviewsFromDom(page: Page, url: string): Promise<{
    url: string;
    totalCount: number;
    averageRating: number | null;
    ratingHistogram: null;
    reviews: any[];
  }> {
    await this.expandReviewSection(page);
    await this.sleep(700);

    const result = await page.evaluate(() => {
      const cardSelectors = [
        '[data-testid*="review"]',
        '[data-enzyme-id*="review"]',
        'article[class*="review"]',
        'div[class*="reviewCard"]',
        'li[class*="review"]',
      ];

      const uniqueElements: Element[] = [];
      const seen = new Set<Element>();
      for (const selector of cardSelectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (!seen.has(el)) {
            seen.add(el);
            uniqueElements.push(el);
          }
        }
      }

      const parseRating = (text: string): number | '' => {
        const m = text.match(/(\d(?:\.\d)?)\s*(?:out of 5|\/\s*5|\bstars?\b)/i);
        return m ? parseFloat(m[1]) : '';
      };

      const parseDate = (text: string): string => {
        const m = text.match(
          /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}/i
        );
        return m ? m[0] : '';
      };

      const extractBody = (el: Element): string => {
        const bodyCandidates = Array.from(el.querySelectorAll('p, span, div'))
          .map((node) => (node as HTMLElement).innerText?.trim() || '')
          .filter((t) => t.length >= 20);
        if (bodyCandidates.length === 0) {
          const fallback = (el as HTMLElement).innerText || '';
          return fallback.trim();
        }
        bodyCandidates.sort((a, b) => b.length - a.length);
        return bodyCandidates[0];
      };

      const reviews: Array<Record<string, any>> = [];
      const dedupe = new Set<string>();

      for (const card of uniqueElements) {
        const cardText = (card as HTMLElement).innerText?.trim() || '';
        if (cardText.length < 20) continue;

        const body = extractBody(card);
        const rating =
          parseRating((card as HTMLElement).getAttribute('aria-label') || '') || parseRating(cardText);
        const date = parseDate(cardText);
        const authorNode = card.querySelector(
          '[itemprop="author"], [class*="author"], [class*="reviewer"], strong, h3, h4'
        ) as HTMLElement | null;
        const name = authorNode?.innerText?.trim() || '';

        const key = `${name}|${date}|${rating}|${body.slice(0, 120)}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);

        if (String(body).trim().length === 0 && String(rating).trim().length === 0) continue;
        reviews.push({
          reviewId: '',
          name,
          location: '',
          rating,
          date,
          body: body.slice(0, 5000),
          badge: '',
          badgeDescription: '',
        });
      }

      const text = document.body.innerText || '';
      const totalMatch = text.match(/(?:Based on |Showing \d+-\d+ of )?(\d{1,5})\s+[Rr]eviews?/);
      const avgMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of 5|\/\s*5|\bstars?\b)/i);

      return {
        totalCount: totalMatch ? parseInt(totalMatch[1], 10) : reviews.length,
        averageRating: avgMatch ? parseFloat(avgMatch[1]) : null,
        reviews,
      };
    });

    return {
      url,
      totalCount: result.totalCount || result.reviews.length,
      averageRating: result.averageRating,
      ratingHistogram: null,
      reviews: result.reviews,
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error || 'Unknown extraction error');
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
