import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';

interface ReviewAnalysisDisplayProps {
  data: any;
  type: 'categorized' | 'positive' | 'negative' | 'summary';
}

// Categorized Reviews Display
const CategorizedReviewsDisplay: React.FC<{ data: any }> = ({ data }) => {
  const [activeTheme, setActiveTheme] = useState<string | null>(null);

  const themes = useMemo(() => {
    if (!data?.theme_summary) return [];
    return Object.entries(data.theme_summary).map(([name, info]: [string, any]) => ({
      name,
      count: info.count,
      avgRating: info.avg_rating,
      sentiment: info.sentiment_breakdown,
    }));
  }, [data]);

  const reviewsByTheme = useMemo(() => {
    if (!data?.categorized_reviews || !activeTheme) return [];
    return data.categorized_reviews.filter(
      (r: any) => r.primary_theme === activeTheme
    );
  }, [data, activeTheme]);

  return (
    <div className="space-y-6">
      {/* Theme Overview */}
      <div>
        <h3 className="text-lg font-semibold text-secondary-900 mb-4">Theme Distribution</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {themes.map((theme) => (
            <button
              key={theme.name}
              onClick={() => setActiveTheme(activeTheme === theme.name ? null : theme.name)}
              className={`p-4 rounded-lg border text-left transition-all ${
                activeTheme === theme.name
                  ? 'border-primary-500 bg-primary-50 ring-2 ring-primary-200'
                  : 'border-secondary-200 hover:border-primary-300 hover:bg-secondary-50'
              }`}
            >
              <div className="font-medium text-secondary-900">{theme.name}</div>
              <div className="text-2xl font-bold text-primary-600">{theme.count}</div>
              <div className="text-xs text-secondary-500">
                Avg: {theme.avgRating?.toFixed(1) || '-'} stars
              </div>
              {theme.sentiment && (
                <div className="flex items-center space-x-1 mt-2">
                  <span className="w-2 h-2 rounded-full bg-green-500" title="Positive" />
                  <span className="text-xs text-secondary-600">{theme.sentiment.positive || 0}</span>
                  <span className="w-2 h-2 rounded-full bg-gray-400 ml-1" title="Neutral" />
                  <span className="text-xs text-secondary-600">{theme.sentiment.neutral || 0}</span>
                  <span className="w-2 h-2 rounded-full bg-red-500 ml-1" title="Negative" />
                  <span className="text-xs text-secondary-600">{theme.sentiment.negative || 0}</span>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Reviews for Selected Theme */}
      {activeTheme && reviewsByTheme.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-secondary-900 mb-4">
            Reviews about "{activeTheme}" ({reviewsByTheme.length})
          </h3>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {reviewsByTheme.map((review: any, idx: number) => (
              <div
                key={idx}
                className="p-4 bg-secondary-50 rounded-lg border border-secondary-200"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      review.sentiment === 'positive' ? 'bg-green-100 text-green-800' :
                      review.sentiment === 'negative' ? 'bg-red-100 text-red-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {review.sentiment}
                    </span>
                    <span className="text-sm text-secondary-600">
                      {review.rating} stars
                    </span>
                  </div>
                  <span className="text-xs text-secondary-500">
                    {review.emotional_tone}
                  </span>
                </div>
                {review.key_quote && (
                  <blockquote className="text-secondary-700 italic border-l-2 border-primary-300 pl-3">
                    "{review.key_quote}"
                  </blockquote>
                )}
                {review.features_mentioned && review.features_mentioned.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {review.features_mentioned.map((feature: string, fIdx: number) => (
                      <span
                        key={fIdx}
                        className="px-2 py-0.5 bg-secondary-200 text-secondary-700 rounded text-xs"
                      >
                        {feature}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Positive Analysis Display
const PositiveAnalysisDisplay: React.FC<{ data: any }> = ({ data }) => {
  const analysis = data?.positive_analysis;
  if (!analysis) return <div className="text-secondary-500">No positive analysis data available.</div>;

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-green-50 rounded-lg p-4 border border-green-200">
          <div className="text-3xl font-bold text-green-700">{analysis.total_positive_reviews}</div>
          <div className="text-sm text-green-600">Positive Reviews</div>
        </div>
        <div className="bg-green-50 rounded-lg p-4 border border-green-200">
          <div className="text-3xl font-bold text-green-700">{analysis.average_positive_rating?.toFixed(1)}</div>
          <div className="text-sm text-green-600">Average Rating</div>
        </div>
      </div>

      {/* Top Praised Features */}
      {analysis.top_praised_features && analysis.top_praised_features.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-secondary-900 mb-3 flex items-center">
            <span className="text-green-500 mr-2">★</span>
            Top Praised Features
          </h3>
          <div className="space-y-3">
            {analysis.top_praised_features.map((feature: any, idx: number) => (
              <div key={idx} className="bg-white border border-secondary-200 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <h4 className="font-medium text-secondary-900">{feature.feature}</h4>
                  <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-sm">
                    {feature.mention_count} mentions ({feature.percentage_of_positive?.toFixed(0)}%)
                  </span>
                </div>
                <p className="text-secondary-600 text-sm mb-2">{feature.why_customers_love_it}</p>
                {feature.representative_quotes && feature.representative_quotes.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {feature.representative_quotes.slice(0, 2).map((quote: string, qIdx: number) => (
                      <blockquote key={qIdx} className="text-sm text-secondary-500 italic pl-3 border-l-2 border-green-300">
                        "{quote}"
                      </blockquote>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unexpected Delights */}
      {analysis.unexpected_delights && analysis.unexpected_delights.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-secondary-900 mb-3 flex items-center">
            <span className="mr-2">✨</span>
            Unexpected Delights
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {analysis.unexpected_delights.map((delight: any, idx: number) => (
              <div key={idx} className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                <h4 className="font-medium text-purple-900">{delight.aspect}</h4>
                <p className="text-sm text-purple-700 mt-1">{delight.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Takeaways */}
      {analysis.key_takeaways && analysis.key_takeaways.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <h3 className="font-semibold text-green-900 mb-2">Key Takeaways</h3>
          <ul className="space-y-1">
            {analysis.key_takeaways.map((takeaway: string, idx: number) => (
              <li key={idx} className="flex items-start">
                <span className="text-green-500 mr-2">✓</span>
                <span className="text-green-800">{takeaway}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

// Negative Analysis Display
const NegativeAnalysisDisplay: React.FC<{ data: any }> = ({ data }) => {
  const analysis = data?.negative_analysis;
  if (!analysis) return <div className="text-secondary-500">No negative analysis data available.</div>;

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-red-50 rounded-lg p-4 border border-red-200">
          <div className="text-3xl font-bold text-red-700">{analysis.total_negative_reviews}</div>
          <div className="text-sm text-red-600">Negative Reviews</div>
        </div>
        <div className="bg-red-50 rounded-lg p-4 border border-red-200">
          <div className="text-3xl font-bold text-red-700">{analysis.average_negative_rating?.toFixed(1)}</div>
          <div className="text-sm text-red-600">Average Rating</div>
        </div>
      </div>

      {/* Critical Issues */}
      {analysis.critical_issues && analysis.critical_issues.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-secondary-900 mb-3 flex items-center">
            <span className="text-red-500 mr-2">⚠</span>
            Critical Issues
          </h3>
          <div className="space-y-3">
            {analysis.critical_issues.map((issue: any, idx: number) => (
              <div key={idx} className="bg-white border border-secondary-200 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <h4 className="font-medium text-secondary-900">{issue.issue}</h4>
                  <div className="flex items-center space-x-2">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      issue.severity === 'critical' ? 'bg-red-100 text-red-800' :
                      issue.severity === 'major' ? 'bg-orange-100 text-orange-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {issue.severity}
                    </span>
                    <span className="px-2 py-1 bg-red-100 text-red-800 rounded text-sm">
                      {issue.mention_count} mentions
                    </span>
                  </div>
                </div>
                <p className="text-secondary-600 text-sm mb-2">{issue.impact_on_customer}</p>
                {issue.representative_quotes && issue.representative_quotes.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {issue.representative_quotes.slice(0, 2).map((quote: string, qIdx: number) => (
                      <blockquote key={qIdx} className="text-sm text-secondary-500 italic pl-3 border-l-2 border-red-300">
                        "{quote}"
                      </blockquote>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Requested Features */}
      {analysis.requested_features && analysis.requested_features.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-secondary-900 mb-3 flex items-center">
            <span className="mr-2">💡</span>
            Feature Requests
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {analysis.requested_features.map((feature: any, idx: number) => (
              <div key={idx} className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <div className="flex items-start justify-between">
                  <h4 className="font-medium text-blue-900">{feature.feature}</h4>
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    feature.potential_impact === 'high' ? 'bg-blue-200 text-blue-800' :
                    feature.potential_impact === 'medium' ? 'bg-blue-100 text-blue-700' :
                    'bg-blue-50 text-blue-600'
                  }`}>
                    {feature.potential_impact} impact
                  </span>
                </div>
                <p className="text-xs text-blue-600 mt-1">Frequency: {feature.request_frequency}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Improvement Areas */}
      {analysis.key_improvement_areas && analysis.key_improvement_areas.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="font-semibold text-red-900 mb-2">Key Improvement Areas</h3>
          <ul className="space-y-1">
            {analysis.key_improvement_areas.map((area: string, idx: number) => (
              <li key={idx} className="flex items-start">
                <span className="text-red-500 mr-2">•</span>
                <span className="text-red-800">{area}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

// Summary Display (Markdown)
const SummaryDisplay: React.FC<{ data: string }> = ({ data }) => {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown>{data}</ReactMarkdown>
    </div>
  );
};

export const ReviewAnalysisDisplay: React.FC<ReviewAnalysisDisplayProps> = ({
  data,
  type,
}) => {
  // Try to parse if data is a string
  let parsedData = data;
  if (typeof data === 'string') {
    try {
      parsedData = JSON.parse(data);
    } catch {
      // Keep as string for summary/markdown
    }
  }

  switch (type) {
    case 'categorized':
      return <CategorizedReviewsDisplay data={parsedData} />;
    case 'positive':
      return <PositiveAnalysisDisplay data={parsedData} />;
    case 'negative':
      return <NegativeAnalysisDisplay data={parsedData} />;
    case 'summary':
      return <SummaryDisplay data={typeof data === 'string' ? data : JSON.stringify(data, null, 2)} />;
    default:
      return <pre className="text-sm overflow-auto">{JSON.stringify(parsedData, null, 2)}</pre>;
  }
};

export default ReviewAnalysisDisplay;
