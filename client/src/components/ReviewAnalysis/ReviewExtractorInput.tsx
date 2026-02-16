import React, { useState } from 'react';
import { BrowserChat } from '../BrowserChat/BrowserChat';

interface ReviewExtractorInputProps {
  onDataExtracted: (data: {
    result: string;
    source: 'browser';
  }) => void;
  onError: (error: string) => void;
}

export const ReviewExtractorInput: React.FC<ReviewExtractorInputProps> = ({
  onDataExtracted,
  onError,
}) => {
  const [urls, setUrls] = useState('');
  const [platform, setPlatform] = useState('wayfair');
  const [showChat, setShowChat] = useState(false);
  const [chatResult, setChatResult] = useState<string | null>(null);

  const handleStartScraping = () => {
    const urlList = urls.split('\n').map(u => u.trim()).filter(Boolean);
    if (urlList.length === 0) {
      onError('Please enter at least one product URL');
      return;
    }
    setChatResult(null);
    setShowChat(true);
  };

  const handleChatComplete = (result: { output: string; reviewCount?: number }) => {
    setChatResult(result.output);
  };

  const handleSubmit = () => {
    if (chatResult) {
      onDataExtracted({
        result: chatResult,
        source: 'browser',
      });
    }
  };

  const handleReset = () => {
    setShowChat(false);
    setChatResult(null);
  };

  const urlList = urls.split('\n').map(u => u.trim()).filter(Boolean);

  return (
    <div className="space-y-6">
      {/* Browser Scraping Status */}
      <div className="flex items-center space-x-2 p-3 rounded-lg border bg-green-50 border-green-200">
        <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
        <span className="text-sm font-medium text-green-800">
          Browser Scraping Ready (Puppeteer)
        </span>
      </div>

      {!showChat ? (
        <>
          {/* Platform Selection */}
          <div>
            <label className="block text-sm font-medium text-secondary-700 mb-2">
              Platform
            </label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full px-3 py-2 border border-secondary-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="wayfair">Wayfair</option>
            </select>
          </div>

          {/* URL Input */}
          <div>
            <label className="block text-sm font-medium text-secondary-700 mb-2">
              Product URLs
              <span className="text-red-500 ml-1">*</span>
              <span className="text-secondary-500 font-normal ml-2">(one per line)</span>
            </label>
            <textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder="https://www.wayfair.com/furniture/pdp/product-name-w123456789.html"
              rows={4}
              className="w-full px-3 py-2 border border-secondary-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-secondary-200">
            <div className="text-sm text-secondary-500">
              {urlList.length > 0
                ? `${urlList.length} URL${urlList.length > 1 ? 's' : ''} ready to scrape`
                : 'Enter product URLs to begin'}
            </div>
            <button
              onClick={handleStartScraping}
              disabled={urlList.length === 0}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start Scraping
            </button>
          </div>
        </>
      ) : (
        <>
          {/* BrowserChat */}
          <BrowserChat
            platform={platform}
            urls={urlList}
            onComplete={handleChatComplete}
            onError={onError}
          />

          {/* Result preview + actions */}
          {chatResult && (
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-2">
                Result Preview
              </label>
              <div className="bg-secondary-50 border border-secondary-200 rounded-lg p-4 max-h-60 overflow-y-auto">
                <pre className="text-sm text-secondary-800 whitespace-pre-wrap">{chatResult.slice(0, 2000)}</pre>
                {chatResult.length > 2000 && (
                  <div className="text-xs text-secondary-500 mt-2">
                    ...truncated ({chatResult.length} characters total)
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-secondary-200">
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-secondary-300 text-secondary-700 rounded-lg font-medium hover:bg-secondary-50"
            >
              New Scrape
            </button>
            {chatResult && (
              <button
                onClick={handleSubmit}
                className="px-6 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700"
              >
                Use Result
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default ReviewExtractorInput;
