import { WayfairStrategy } from '../../services/extractionStrategies/wayfairStrategy';

function createMockPage(overrides: Record<string, any> = {}) {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn(),
    ...overrides,
  } as any;
}

function buildGraphqlPayload(reviews: Array<Record<string, any>>) {
  return {
    data: {
      listingVariant: {
        reviewslist: {
          reviews: {
            totalCount: reviews.length,
            edges: reviews.map((r) => ({ node: r })),
          },
        },
        reviewsRating: { reviews: { averageRating: 4.3 } },
        reviewsHistogram: { reviews: { ratingHistogram: [] } },
      },
    },
  };
}

describe('WayfairStrategy', () => {
  let strategy: WayfairStrategy;
  let onProgress: jest.Mock;

  jest.setTimeout(20000);

  beforeEach(() => {
    strategy = new WayfairStrategy();
    onProgress = jest.fn();
  });

  test('extracts reviews via GraphQL when GraphQL call succeeds', async () => {
    const mockPage = createMockPage();

    mockPage.evaluate.mockImplementation((fn: any, arg: any) => {
      const src = String(fn);

      if (src.includes('window.scrollBy')) return Promise.resolve();
      if (src.includes('novohavenClicked')) return Promise.resolve(0);
      if (src.includes('sha256Hash') && src.includes('operationNames')) {
        return Promise.resolve({ hashes: [], clientVersions: [], operationNames: [] });
      }
      if (typeof arg === 'string') {
        return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
      }
      if (src.includes('federation/graphql')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: buildGraphqlPayload([
            {
              reviewId: '1',
              reviewerGivenName: 'Alice',
              reviewerLocation: 'CA',
              rating: 5,
              formattedDate: 'Jan 1, 2026',
              body: 'Excellent quality',
            },
            {
              reviewId: '2',
              reviewerGivenName: 'Bob',
              reviewerLocation: 'WA',
              rating: 4,
              formattedDate: 'Jan 2, 2026',
              body: 'Solid value',
            },
          ]),
        });
      }
      if (src.includes('cardSelectors')) {
        return Promise.resolve({ totalCount: 0, averageRating: null, reviews: [] });
      }
      if (src.includes('totalMatch') && src.includes('averageRating')) {
        return Promise.resolve({ totalCount: 2, averageRating: 4.3 });
      }
      return Promise.resolve(null);
    });

    const result = await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

    expect(result.success).toBe(true);
    expect(result.reviewCount).toBe(2);
    expect(result.data.reviews).toHaveLength(2);
    expect(result.data.source).toBe('graphql');
  });

  test('falls back to DOM extraction when GraphQL fails', async () => {
    const mockPage = createMockPage();

    mockPage.evaluate.mockImplementation((fn: any, arg: any) => {
      const src = String(fn);

      if (src.includes('window.scrollBy')) return Promise.resolve();
      if (src.includes('novohavenClicked')) return Promise.resolve(0);
      if (src.includes('sha256Hash') && src.includes('operationNames')) {
        return Promise.resolve({ hashes: [], clientVersions: [], operationNames: [] });
      }
      if (typeof arg === 'string') {
        return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
      }
      if (src.includes('federation/graphql')) {
        return Promise.resolve({ ok: false, status: 400, error: 'GraphQL request failed: 400' });
      }
      if (src.includes('cardSelectors')) {
        return Promise.resolve({
          totalCount: 2,
          averageRating: 4.5,
          reviews: [
            { name: 'Dina', rating: 5, body: 'Great table', date: 'Jan 3, 2026' },
            { name: 'Evan', rating: 4, body: 'Looks nice', date: 'Jan 4, 2026' },
          ],
        });
      }
      if (src.includes('totalMatch') && src.includes('averageRating')) {
        return Promise.resolve({ totalCount: 20, averageRating: 4.1 });
      }
      return Promise.resolve(null);
    });

    const result = await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

    expect(result.success).toBe(true);
    expect(result.data.reviews).toHaveLength(2);
    expect(result.data.source).toBe('dom');
  });

  test('returns a descriptive error when both GraphQL and DOM paths fail', async () => {
    const mockPage = createMockPage();

    mockPage.evaluate.mockImplementation((fn: any, arg: any) => {
      const src = String(fn);
      if (src.includes('window.scrollBy')) return Promise.resolve();
      if (src.includes('novohavenClicked')) return Promise.resolve(0);
      if (src.includes('sha256Hash') && src.includes('operationNames')) {
        return Promise.resolve({ hashes: [], clientVersions: [], operationNames: [] });
      }
      if (typeof arg === 'string') {
        return Promise.resolve(null); // nodeId not found
      }
      if (src.includes('cardSelectors')) {
        return Promise.resolve({ totalCount: 0, averageRating: null, reviews: [] });
      }
      if (src.includes('totalMatch') && src.includes('averageRating')) {
        return Promise.resolve({ totalCount: 0, averageRating: null });
      }
      return Promise.resolve(null);
    });

    const result = await strategy.execute(mockPage, ['https://www.wayfair.com/product/test.html'], onProgress);

    expect(result.success).toBe(false);
    expect(result.data.error).toContain('nodeId');
    expect(result.data.error).toContain('DOM fallback');
  });

  test('handles multiple URLs and reports success when at least one URL succeeds', async () => {
    const mockPage = createMockPage();
    let graphqlCalls = 0;

    mockPage.evaluate.mockImplementation((fn: any, arg: any) => {
      const src = String(fn);
      if (src.includes('window.scrollBy')) return Promise.resolve();
      if (src.includes('novohavenClicked')) return Promise.resolve(0);
      if (src.includes('sha256Hash') && src.includes('operationNames')) {
        return Promise.resolve({ hashes: [], clientVersions: [], operationNames: [] });
      }
      if (typeof arg === 'string') {
        return Promise.resolve('TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudDoxMjM=');
      }
      if (src.includes('federation/graphql')) {
        graphqlCalls += 1;
        if (graphqlCalls === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            data: buildGraphqlPayload([
              {
                reviewId: '1',
                reviewerGivenName: 'A',
                reviewerLocation: '',
                rating: 5,
                formattedDate: 'Jan 1, 2026',
                body: 'Great',
              },
            ]),
          });
        }
        return Promise.resolve({ ok: false, status: 400, error: 'GraphQL request failed: 400' });
      }
      if (src.includes('cardSelectors')) {
        return Promise.resolve({ totalCount: 0, averageRating: null, reviews: [] });
      }
      if (src.includes('totalMatch') && src.includes('averageRating')) {
        return Promise.resolve({ totalCount: 1, averageRating: 4.0 });
      }
      return Promise.resolve(null);
    });

    const result = await strategy.execute(
      mockPage,
      ['https://www.wayfair.com/product/a.html', 'https://www.wayfair.com/product/b.html'],
      onProgress
    );

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.reviewCount).toBe(1);
  });
});
