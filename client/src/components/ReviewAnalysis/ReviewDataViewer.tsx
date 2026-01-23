import React, { useState, useMemo } from 'react';
import { ReviewData, ScrapingPlatform } from '../../types';

interface ReviewDataViewerProps {
  reviews: ReviewData[];
  title?: string;
  showFilters?: boolean;
  showExport?: boolean;
  onExport?: (format: 'csv' | 'json') => void;
}

type SortField = 'rating' | 'review_date' | 'helpful_votes';
type SortOrder = 'asc' | 'desc';
type ViewMode = 'table' | 'cards';

const platformColors: Record<ScrapingPlatform, string> = {
  amazon: 'bg-orange-100 text-orange-800',
  walmart: 'bg-blue-100 text-blue-800',
  wayfair: 'bg-purple-100 text-purple-800',
};

const sentimentColors: Record<string, string> = {
  positive: 'bg-green-100 text-green-800',
  neutral: 'bg-gray-100 text-gray-800',
  negative: 'bg-red-100 text-red-800',
};

const StarRating: React.FC<{ rating: number }> = ({ rating }) => {
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating % 1 >= 0.5;
  const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

  return (
    <div className="flex items-center">
      {[...Array(fullStars)].map((_, i) => (
        <span key={`full-${i}`} className="text-yellow-400">★</span>
      ))}
      {hasHalfStar && <span className="text-yellow-400">☆</span>}
      {[...Array(emptyStars)].map((_, i) => (
        <span key={`empty-${i}`} className="text-gray-300">★</span>
      ))}
      <span className="ml-1 text-sm text-secondary-600">({rating.toFixed(1)})</span>
    </div>
  );
};

export const ReviewDataViewer: React.FC<ReviewDataViewerProps> = ({
  reviews,
  title = 'Reviews',
  showFilters = true,
  showExport = true,
  onExport,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [sortField, setSortField] = useState<SortField>('rating');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filterPlatform, setFilterPlatform] = useState<ScrapingPlatform | 'all'>('all');
  const [filterSentiment, setFilterSentiment] = useState<string>('all');
  const [filterRating, setFilterRating] = useState<number | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedReviews, setExpandedReviews] = useState<Set<string>>(new Set());

  // Get unique platforms
  const platforms = useMemo(() => {
    const unique = new Set(reviews.map(r => r.platform));
    return Array.from(unique);
  }, [reviews]);

  // Filter and sort reviews
  const filteredReviews = useMemo(() => {
    let result = [...reviews];

    // Apply filters
    if (filterPlatform !== 'all') {
      result = result.filter(r => r.platform === filterPlatform);
    }
    if (filterSentiment !== 'all') {
      result = result.filter(r => r.sentiment === filterSentiment);
    }
    if (filterRating !== 'all') {
      result = result.filter(r => Math.floor(r.rating) === filterRating);
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(r =>
        r.review_text.toLowerCase().includes(term) ||
        r.review_title?.toLowerCase().includes(term) ||
        r.product_name?.toLowerCase().includes(term)
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case 'rating':
          aVal = a.rating;
          bVal = b.rating;
          break;
        case 'review_date':
          aVal = a.review_date ? new Date(a.review_date).getTime() : 0;
          bVal = b.review_date ? new Date(b.review_date).getTime() : 0;
          break;
        case 'helpful_votes':
          aVal = a.helpful_votes || 0;
          bVal = b.helpful_votes || 0;
          break;
        default:
          return 0;
      }
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return result;
  }, [reviews, filterPlatform, filterSentiment, filterRating, searchTerm, sortField, sortOrder]);

  // Stats
  const stats = useMemo(() => {
    const total = reviews.length;
    const avgRating = total > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / total
      : 0;
    const positive = reviews.filter(r => r.sentiment === 'positive' || r.rating >= 4).length;
    const negative = reviews.filter(r => r.sentiment === 'negative' || r.rating <= 2).length;
    const verified = reviews.filter(r => r.verified_purchase).length;

    return { total, avgRating, positive, negative, verified };
  }, [reviews]);

  const toggleExpanded = (id: string) => {
    const newExpanded = new Set(expandedReviews);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedReviews(newExpanded);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-secondary-200">
      {/* Header */}
      <div className="p-4 border-b border-secondary-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-secondary-900">{title}</h2>
          <div className="flex items-center space-x-2">
            {/* View Mode Toggle */}
            <div className="flex rounded-lg border border-secondary-200 overflow-hidden">
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 text-sm ${viewMode === 'table' ? 'bg-primary-100 text-primary-700' : 'bg-white text-secondary-600 hover:bg-secondary-50'}`}
              >
                Table
              </button>
              <button
                onClick={() => setViewMode('cards')}
                className={`px-3 py-1.5 text-sm ${viewMode === 'cards' ? 'bg-primary-100 text-primary-700' : 'bg-white text-secondary-600 hover:bg-secondary-50'}`}
              >
                Cards
              </button>
            </div>
            {/* Export Buttons */}
            {showExport && onExport && (
              <div className="flex space-x-1">
                <button
                  onClick={() => onExport('csv')}
                  className="px-3 py-1.5 text-sm bg-secondary-100 text-secondary-700 rounded-lg hover:bg-secondary-200"
                >
                  Export CSV
                </button>
                <button
                  onClick={() => onExport('json')}
                  className="px-3 py-1.5 text-sm bg-secondary-100 text-secondary-700 rounded-lg hover:bg-secondary-200"
                >
                  Export JSON
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-5 gap-4 mb-4">
          <div className="bg-secondary-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-secondary-900">{stats.total}</div>
            <div className="text-xs text-secondary-600">Total Reviews</div>
          </div>
          <div className="bg-secondary-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-secondary-900">{stats.avgRating.toFixed(1)}</div>
            <div className="text-xs text-secondary-600">Avg Rating</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-green-700">{stats.positive}</div>
            <div className="text-xs text-green-600">Positive</div>
          </div>
          <div className="bg-red-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-red-700">{stats.negative}</div>
            <div className="text-xs text-red-600">Negative</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-blue-700">{stats.verified}</div>
            <div className="text-xs text-blue-600">Verified</div>
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[200px]">
              <input
                type="text"
                placeholder="Search reviews..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-secondary-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <select
              value={filterPlatform}
              onChange={(e) => setFilterPlatform(e.target.value as ScrapingPlatform | 'all')}
              className="px-3 py-2 text-sm border border-secondary-200 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Platforms</option>
              {platforms.map(p => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
            <select
              value={filterSentiment}
              onChange={(e) => setFilterSentiment(e.target.value)}
              className="px-3 py-2 text-sm border border-secondary-200 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Sentiment</option>
              <option value="positive">Positive</option>
              <option value="neutral">Neutral</option>
              <option value="negative">Negative</option>
            </select>
            <select
              value={filterRating}
              onChange={(e) => setFilterRating(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
              className="px-3 py-2 text-sm border border-secondary-200 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Ratings</option>
              {[5, 4, 3, 2, 1].map(r => (
                <option key={r} value={r}>{r} Stars</option>
              ))}
            </select>
            <select
              value={`${sortField}-${sortOrder}`}
              onChange={(e) => {
                const [field, order] = e.target.value.split('-');
                setSortField(field as SortField);
                setSortOrder(order as SortOrder);
              }}
              className="px-3 py-2 text-sm border border-secondary-200 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="rating-desc">Rating (High to Low)</option>
              <option value="rating-asc">Rating (Low to High)</option>
              <option value="review_date-desc">Date (Newest)</option>
              <option value="review_date-asc">Date (Oldest)</option>
              <option value="helpful_votes-desc">Most Helpful</option>
            </select>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        <div className="text-sm text-secondary-600 mb-3">
          Showing {filteredReviews.length} of {reviews.length} reviews
        </div>

        {viewMode === 'table' ? (
          /* Table View */
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-secondary-200">
                  <th className="text-left py-2 px-3 font-medium text-secondary-700">Platform</th>
                  <th className="text-left py-2 px-3 font-medium text-secondary-700">Rating</th>
                  <th className="text-left py-2 px-3 font-medium text-secondary-700">Title</th>
                  <th className="text-left py-2 px-3 font-medium text-secondary-700 max-w-md">Review</th>
                  <th className="text-left py-2 px-3 font-medium text-secondary-700">Date</th>
                  <th className="text-left py-2 px-3 font-medium text-secondary-700">Verified</th>
                </tr>
              </thead>
              <tbody>
                {filteredReviews.slice(0, 50).map((review) => (
                  <tr key={review.id} className="border-b border-secondary-100 hover:bg-secondary-50">
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${platformColors[review.platform]}`}>
                        {review.platform}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      <StarRating rating={review.rating} />
                    </td>
                    <td className="py-2 px-3 font-medium text-secondary-900">
                      {review.review_title || '-'}
                    </td>
                    <td className="py-2 px-3 max-w-md">
                      <div
                        className={`text-secondary-600 ${!expandedReviews.has(review.id) ? 'line-clamp-2' : ''}`}
                      >
                        {review.review_text}
                      </div>
                      {review.review_text.length > 150 && (
                        <button
                          onClick={() => toggleExpanded(review.id)}
                          className="text-primary-600 text-xs hover:underline mt-1"
                        >
                          {expandedReviews.has(review.id) ? 'Show less' : 'Show more'}
                        </button>
                      )}
                    </td>
                    <td className="py-2 px-3 text-secondary-600 whitespace-nowrap">
                      {review.review_date
                        ? new Date(review.review_date).toLocaleDateString()
                        : '-'}
                    </td>
                    <td className="py-2 px-3">
                      {review.verified_purchase ? (
                        <span className="text-green-600">✓</span>
                      ) : (
                        <span className="text-secondary-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredReviews.length > 50 && (
              <div className="text-center py-4 text-secondary-600 text-sm">
                Showing first 50 reviews. Export to see all {filteredReviews.length} reviews.
              </div>
            )}
          </div>
        ) : (
          /* Cards View */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredReviews.slice(0, 20).map((review) => (
              <div
                key={review.id}
                className="border border-secondary-200 rounded-lg p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${platformColors[review.platform]}`}>
                      {review.platform}
                    </span>
                    {review.sentiment && (
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${sentimentColors[review.sentiment]}`}>
                        {review.sentiment}
                      </span>
                    )}
                    {review.verified_purchase && (
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                        Verified
                      </span>
                    )}
                  </div>
                  <StarRating rating={review.rating} />
                </div>
                {review.review_title && (
                  <h4 className="font-medium text-secondary-900 mb-1">{review.review_title}</h4>
                )}
                <p className={`text-secondary-600 text-sm ${!expandedReviews.has(review.id) ? 'line-clamp-3' : ''}`}>
                  {review.review_text}
                </p>
                {review.review_text.length > 200 && (
                  <button
                    onClick={() => toggleExpanded(review.id)}
                    className="text-primary-600 text-xs hover:underline mt-1"
                  >
                    {expandedReviews.has(review.id) ? 'Show less' : 'Show more'}
                  </button>
                )}
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-secondary-100 text-xs text-secondary-500">
                  <span>{review.reviewer_name || 'Anonymous'}</span>
                  <span>
                    {review.review_date
                      ? new Date(review.review_date).toLocaleDateString()
                      : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {filteredReviews.length === 0 && (
          <div className="text-center py-8 text-secondary-500">
            No reviews match your filters.
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewDataViewer;
