import React, { useState, useCallback } from 'react';
import api from '../../services/api';
import { ScrapingPlatform, ScrapingStatus, ReviewData, ScrapedProductData } from '../../types';

interface ReviewExtractorInputProps {
  onDataExtracted: (data: {
    reviews: ReviewData[];
    products: ScrapedProductData[];
    source: 'scraping' | 'csv' | 'both';
  }) => void;
  onError: (error: string) => void;
}

type InputMode = 'urls' | 'csv' | 'both';

// Only Amazon is supported for now
const platformInfo: Record<'amazon', { name: string; icon: string; color: string }> = {
  amazon: { name: 'Amazon', icon: '📦', color: 'bg-orange-100 text-orange-800 border-orange-200' },
};

export const ReviewExtractorInput: React.FC<ReviewExtractorInputProps> = ({
  onDataExtracted,
  onError,
}) => {
  const [inputMode, setInputMode] = useState<InputMode>('urls');
  const [urls, setUrls] = useState<string>('');
  const [csvContent, setCsvContent] = useState<string>('');
  const [csvFilename, setCsvFilename] = useState<string>('');
  const [csvPlatform, setCsvPlatform] = useState<ScrapingPlatform>('amazon');
  const [isLoading, setIsLoading] = useState(false);
  const [scrapingStatus, setScrapingStatus] = useState<ScrapingStatus | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  // Check scraping status on mount
  React.useEffect(() => {
    api.getScrapingStatus().then(setScrapingStatus).catch(console.error);
  }, []);

  // Validate and detect platforms from URLs
  const validateUrls = useCallback((urlText: string) => {
    const lines = urlText.split('\n').filter(line => line.trim());
    const results: { url: string; platform: ScrapingPlatform | null; valid: boolean }[] = [];

    for (const line of lines) {
      const url = line.trim();
      let platform: ScrapingPlatform | null = null;

      // Only Amazon is supported for now
      if (url.includes('amazon.')) platform = 'amazon';

      results.push({
        url,
        platform,
        valid: platform !== null && (url.startsWith('http://') || url.startsWith('https://')),
      });
    }

    return results;
  }, []);

  const urlValidation = React.useMemo(() => validateUrls(urls), [urls, validateUrls]);
  const validUrls = urlValidation.filter(u => u.valid);
  const invalidUrls = urlValidation.filter(u => !u.valid && u.url);

  // Handle file upload
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.csv')) {
      onError('Please upload a CSV file');
      return;
    }

    setCsvFilename(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      setCsvContent(e.target?.result as string);
    };
    reader.readAsText(file);
  };

  // Handle extraction
  const handleExtract = async () => {
    setIsLoading(true);
    setProgress(null);

    try {
      let scrapedData: ScrapedProductData[] = [];
      let csvReviews: ReviewData[] = [];

      // Scrape URLs if provided
      if ((inputMode === 'urls' || inputMode === 'both') && validUrls.length > 0) {
        setProgress({ current: 0, total: validUrls.length });

        const scrapingResult = await api.scrapeReviews(validUrls.map(u => u.url));

        if (!scrapingResult.success && !scrapingResult.data?.length) {
          throw new Error(scrapingResult.error || 'Scraping failed');
        }

        scrapedData = scrapingResult.data || [];
        setProgress({ current: validUrls.length, total: validUrls.length });

        if (scrapingResult.invalid_urls?.length) {
          console.warn('Invalid URLs:', scrapingResult.invalid_urls);
        }
      }

      // Parse CSV if provided
      if ((inputMode === 'csv' || inputMode === 'both') && csvContent) {
        const parseResult = await api.parseCSV(csvContent, csvPlatform);

        if (!parseResult.success) {
          throw new Error(parseResult.error || 'CSV parsing failed');
        }

        csvReviews = parseResult.data || [];

        if (parseResult.warnings?.length) {
          console.warn('CSV warnings:', parseResult.warnings);
        }
      }

      // Combine and normalize
      const allReviews: ReviewData[] = [
        ...scrapedData.flatMap(p => p.reviews),
        ...csvReviews,
      ];

      if (allReviews.length === 0) {
        throw new Error('No reviews were extracted. Check your inputs.');
      }

      onDataExtracted({
        reviews: allReviews,
        products: scrapedData,
        source: inputMode === 'both' ? 'both' : inputMode === 'urls' ? 'scraping' : 'csv',
      });

    } catch (err: any) {
      onError(err.message || 'Extraction failed');
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Input Mode Selector */}
      <div>
        <label className="block text-sm font-medium text-secondary-700 mb-2">
          Data Source
        </label>
        <div className="flex rounded-lg border border-secondary-200 overflow-hidden">
          <button
            onClick={() => setInputMode('urls')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              inputMode === 'urls'
                ? 'bg-primary-100 text-primary-700'
                : 'bg-white text-secondary-600 hover:bg-secondary-50'
            }`}
          >
            Scrape URLs
          </button>
          <button
            onClick={() => setInputMode('csv')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors border-l border-r border-secondary-200 ${
              inputMode === 'csv'
                ? 'bg-primary-100 text-primary-700'
                : 'bg-white text-secondary-600 hover:bg-secondary-50'
            }`}
          >
            Upload CSV
          </button>
          <button
            onClick={() => setInputMode('both')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              inputMode === 'both'
                ? 'bg-primary-100 text-primary-700'
                : 'bg-white text-secondary-600 hover:bg-secondary-50'
            }`}
          >
            Both
          </button>
        </div>
      </div>

      {/* URL Input */}
      {(inputMode === 'urls' || inputMode === 'both') && (
        <div>
          <label className="block text-sm font-medium text-secondary-700 mb-2">
            Product URLs
            <span className="text-secondary-500 font-normal ml-2">
              (one per line)
            </span>
          </label>

          {/* Supported Platforms */}
          <div className="flex items-center space-x-2 mb-2">
            <span className="text-xs text-secondary-500">Supported:</span>
            {Object.entries(platformInfo).map(([key, info]) => (
              <span
                key={key}
                className={`px-2 py-0.5 rounded text-xs border ${info.color}`}
              >
                {info.icon} {info.name}
              </span>
            ))}
          </div>

          <textarea
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="https://www.amazon.com/dp/B08N5WRWNW&#10;https://www.amazon.com/dp/B094NC89P9&#10;https://www.amazon.com/dp/..."
            rows={5}
            className="w-full px-3 py-2 border border-secondary-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />

          {/* URL Validation */}
          {urlValidation.length > 0 && (
            <div className="mt-2 space-y-1">
              {validUrls.length > 0 && (
                <div className="text-sm text-green-600">
                  ✓ {validUrls.length} valid URL{validUrls.length !== 1 ? 's' : ''} detected
                  <span className="text-secondary-500 ml-2">
                    ({validUrls.filter(u => u.platform === 'amazon').length} Amazon)
                  </span>
                </div>
              )}
              {invalidUrls.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm text-red-600">
                    ✗ {invalidUrls.length} invalid URL{invalidUrls.length !== 1 ? 's' : ''}
                    <span className="text-secondary-500 ml-2">
                      (unsupported platform or malformed)
                    </span>
                  </div>
                  {invalidUrls.some(u => !u.url.includes('amazon.')) && (
                    <div className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-2">
                      <span className="font-medium">Note:</span> Only Amazon product reviews are available right now. 
                      URLs from other platforms (Walmart, Wayfair, etc.) are not supported at this time.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* BrightData Status */}
          {scrapingStatus && !scrapingStatus.brightdata_configured && (
            <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
              <span className="font-medium text-yellow-800">Note:</span>
              <span className="text-yellow-700 ml-1">
                BrightData is not configured. Mock data will be used for testing.
              </span>
            </div>
          )}
        </div>
      )}

      {/* CSV Input */}
      {(inputMode === 'csv' || inputMode === 'both') && (
        <div>
          <label className="block text-sm font-medium text-secondary-700 mb-2">
            CSV File
          </label>

          <div className="border-2 border-dashed border-secondary-200 rounded-lg p-6 text-center hover:border-primary-300 transition-colors">
            {csvFilename ? (
              <div className="space-y-2">
                <div className="text-4xl">📄</div>
                <div className="font-medium text-secondary-900">{csvFilename}</div>
                <div className="text-sm text-secondary-500">
                  {csvContent.split('\n').length - 1} rows detected
                </div>
                <button
                  onClick={() => {
                    setCsvContent('');
                    setCsvFilename('');
                  }}
                  className="text-sm text-red-600 hover:text-red-700"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-4xl text-secondary-400">📁</div>
                <div className="text-secondary-600">
                  Drag and drop a CSV file, or{' '}
                  <label className="text-primary-600 hover:text-primary-700 cursor-pointer">
                    browse
                    <input
                      type="file"
                      accept=".csv"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>
                <div className="text-xs text-secondary-500">
                  Required columns: review_text, rating (or similar names)
                </div>
              </div>
            )}
          </div>

          {/* CSV Platform selector */}
          {csvContent && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-secondary-700 mb-1">
                Platform for CSV data
              </label>
              <select
                value={csvPlatform}
                onChange={(e) => setCsvPlatform(e.target.value as ScrapingPlatform)}
                className="px-3 py-2 border border-secondary-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
              >
                <option value="amazon">Amazon</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* Extract Button */}
      <div className="flex items-center justify-between pt-4 border-t border-secondary-200">
        <div className="text-sm text-secondary-500">
          {inputMode === 'urls' && validUrls.length > 0 && (
            <span>{validUrls.length} URL{validUrls.length !== 1 ? 's' : ''} ready to scrape</span>
          )}
          {inputMode === 'csv' && csvContent && (
            <span>CSV file ready to parse</span>
          )}
          {inputMode === 'both' && (
            <span>
              {validUrls.length > 0 && `${validUrls.length} URLs`}
              {validUrls.length > 0 && csvContent && ' + '}
              {csvContent && 'CSV file'}
            </span>
          )}
        </div>

        <button
          onClick={handleExtract}
          disabled={
            isLoading ||
            (inputMode === 'urls' && validUrls.length === 0) ||
            (inputMode === 'csv' && !csvContent) ||
            (inputMode === 'both' && validUrls.length === 0 && !csvContent)
          }
          className="px-6 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
        >
          {isLoading ? (
            <>
              <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
              <span>
                {progress
                  ? `Extracting ${progress.current}/${progress.total}...`
                  : 'Extracting...'}
              </span>
            </>
          ) : (
            <span>Extract Reviews</span>
          )}
        </button>
      </div>
    </div>
  );
};

export default ReviewExtractorInput;
