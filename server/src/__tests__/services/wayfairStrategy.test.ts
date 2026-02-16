import { WayfairStrategy } from '../../services/extractionStrategies/wayfairStrategy';

// Mock Puppeteer Page object
function createMockPage(overrides: Record<string, any> = {}) {
  const mockPage: any = {
    goto: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn(),
    content: jest.fn().mockResolvedValue('<html></html>'),
    ...overrides,
  };
  return mockPage;
}

// Each test triggers scroll delays (4 x 1s per URL), so extend timeout
jest.setTimeout(15000);

describe('WayfairStrategy', () => {
  let strategy: WayfairStrategy;
  let onProgress: jest.Mock;

  beforeEach(() => {
    strategy = new WayfairStrategy();
    onProgress = jest.fn();
  });

  test('has correct platform identifier', () => {
    expect(strategy.platform).toBe('wayfair');
  });

  test('has a display name', () => {
    expect(strategy.displayName).toBeTruthy();
  });

  describe('execute', () => {
    test('successfully extracts reviews from a single URL', async () => {
      const mockReviews = [
        { reviewId: '1', reviewerGivenName: 'Alice', rating: 5, body: 'Great!', formattedDate: '01/01/2026' },
        { reviewId: '2', reviewerGivenName: 'Bob', rating: 3, body: 'Okay', formattedDate: '02/01/2026' },
      ];

      const mockPage = createMockPage();
      // navigate
      mockPage.goto.mockResolvedValue(undefined);

      let evaluateCallCount = 0;
      mockPage.evaluate.mockImplementation((fn: any, ...args: any[]) => {
        evaluateCallCount++;

        // Call 1-4: scroll (window.scrollBy)
        if (evaluateCallCount <= 4) return Promise.resolve();

        // Call 5: extract nodeId
        if (evaluateCallCount === 5) {
          return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
        }

        // Call 6: get total review count
        if (evaluateCallCount === 6) {
          return Promise.resolve(2);
        }

        // Call 7: GraphQL fetch
        if (evaluateCallCount === 7) {
          return Promise.resolve({
            data: {
              listingVariant: {
                reviewslist: {
                  reviews: {
                    totalCount: 2,
                    edges: mockReviews.map(r => ({ node: r })),
                  },
                },
                reviewsRating: { reviews: { averageRating: 4.0 } },
                reviewsHistogram: { reviews: { ratingHistogram: [] } },
              },
            },
          });
        }

        return Promise.resolve(null);
      });

      const result = await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

      expect(result.success).toBe(true);
      expect(result.data.reviews).toHaveLength(2);
      expect(result.data.totalCount).toBe(2);
      expect(result.data.averageRating).toBe(4.0);
      expect(result.reviewCount).toBe(2);
    });

    test('throws error when nodeId is not found', async () => {
      const mockPage = createMockPage();
      let evaluateCallCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        evaluateCallCount++;
        if (evaluateCallCount <= 4) return Promise.resolve(); // scroll
        if (evaluateCallCount === 5) return Promise.resolve(null); // no nodeId
        return Promise.resolve(null);
      });

      const result = await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

      // Should have an error in the result
      expect(result.data.error).toBeDefined();
      expect(result.data.error).toContain('nodeId');
    });

    test('throws error when GraphQL returns error', async () => {
      const mockPage = createMockPage();
      let evaluateCallCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        evaluateCallCount++;
        if (evaluateCallCount <= 4) return Promise.resolve(); // scroll
        if (evaluateCallCount === 5) return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
        if (evaluateCallCount === 6) return Promise.resolve(10);
        if (evaluateCallCount === 7) return Promise.resolve({ error: 'GraphQL request failed: 400 Bad Request' });
        return Promise.resolve(null);
      });

      const result = await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

      expect(result.data.error).toBeDefined();
      expect(result.data.error).toContain('GraphQL');
    });

    test('calls onProgress with status messages', async () => {
      const mockPage = createMockPage();
      let evaluateCallCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        evaluateCallCount++;
        if (evaluateCallCount <= 4) return Promise.resolve();
        if (evaluateCallCount === 5) return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
        if (evaluateCallCount === 6) return Promise.resolve(5);
        if (evaluateCallCount === 7) {
          return Promise.resolve({
            data: {
              listingVariant: {
                reviewslist: { reviews: { totalCount: 5, edges: [] } },
                reviewsRating: { reviews: { averageRating: 4.5 } },
                reviewsHistogram: { reviews: { ratingHistogram: [] } },
              },
            },
          });
        }
        return Promise.resolve(null);
      });

      await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

      // Check that onProgress was called with meaningful messages
      const messages = onProgress.mock.calls.map((c: any) => c[0]);
      expect(messages.some((m: string) => m.includes('Navigating'))).toBe(true);
      expect(messages.some((m: string) => m.includes('Scrolling'))).toBe(true);
      expect(messages.some((m: string) => m.includes('nodeId'))).toBe(true);
      expect(messages.some((m: string) => m.includes('GraphQL'))).toBe(true);
    });

    test('handles multiple URLs', async () => {
      const mockPage = createMockPage();
      let evaluateCallCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        evaluateCallCount++;
        // For each URL: 4 scroll + nodeId + totalCount + graphQL = 7 calls
        const urlIndex = Math.floor((evaluateCallCount - 1) / 7);
        const callInUrl = ((evaluateCallCount - 1) % 7) + 1;

        if (callInUrl <= 4) return Promise.resolve();
        if (callInUrl === 5) return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
        if (callInUrl === 6) return Promise.resolve(1);
        if (callInUrl === 7) {
          return Promise.resolve({
            data: {
              listingVariant: {
                reviewslist: { reviews: { totalCount: 1, edges: [{ node: { reviewId: String(urlIndex), rating: 5, body: 'Good' } }] } },
                reviewsRating: { reviews: { averageRating: 5.0 } },
                reviewsHistogram: { reviews: { ratingHistogram: [] } },
              },
            },
          });
        }
        return Promise.resolve(null);
      });

      const result = await strategy.execute(
        mockPage,
        ['https://www.wayfair.com/product/a.html', 'https://www.wayfair.com/product/b.html'],
        onProgress,
      );

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(2);
    }, 30000);

    test('navigates to each URL', async () => {
      const mockPage = createMockPage();
      // Make nodeId extraction fail immediately so we don't need full mock chain
      mockPage.evaluate.mockResolvedValue(null);

      await strategy.execute(
        mockPage,
        ['https://www.wayfair.com/product/a.html'],
        onProgress,
      );

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://www.wayfair.com/product/a.html',
        expect.objectContaining({ waitUntil: 'networkidle2' }),
      );
    });
  });
});
