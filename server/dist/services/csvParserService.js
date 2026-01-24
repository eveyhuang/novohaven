"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseReviewCSV = parseReviewCSV;
exports.reviewsToCSV = reviewsToCSV;
exports.reviewsToJSON = reviewsToJSON;
// Common column name mappings for different CSV formats
const COLUMN_MAPPINGS = {
    review_text: ['review', 'review_text', 'text', 'content', 'body', 'comment', 'review_body', 'review_content'],
    rating: ['rating', 'star_rating', 'stars', 'score', 'star', 'review_rating'],
    review_title: ['title', 'review_title', 'headline', 'summary', 'subject'],
    reviewer_name: ['reviewer', 'author', 'name', 'reviewer_name', 'user', 'username', 'customer'],
    review_date: ['date', 'review_date', 'created_at', 'posted_date', 'timestamp', 'created', 'post_date'],
    product_name: ['product', 'product_name', 'item', 'item_name', 'product_title'],
    product_price: ['price', 'product_price', 'cost', 'amount'],
    verified_purchase: ['verified', 'verified_purchase', 'verified_buyer', 'is_verified'],
    helpful_votes: ['helpful', 'helpful_votes', 'upvotes', 'useful', 'helpful_count'],
    product_url: ['url', 'product_url', 'link', 'product_link'],
};
// Parse CSV content into rows
function parseCSV(content) {
    const lines = content.trim().split(/\r?\n/);
    if (lines.length < 2) {
        throw new Error('CSV must have at least a header row and one data row');
    }
    // Parse header
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
    // Parse data rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) {
            rows.push(parseCSVLine(lines[i]));
        }
    }
    return { headers, rows };
}
// Parse a single CSV line, handling quoted fields
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++;
            }
            else {
                // Toggle quote mode
                inQuotes = !inQuotes;
            }
        }
        else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        }
        else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}
// Find the best matching column index for a field
function findColumnIndex(headers, fieldName) {
    const possibleNames = COLUMN_MAPPINGS[fieldName] || [fieldName];
    for (const name of possibleNames) {
        const index = headers.findIndex(h => h === name || h.includes(name));
        if (index !== -1)
            return index;
    }
    return -1;
}
// Parse a rating value (could be "4/5", "4 stars", "4.5", etc.)
function parseRating(value) {
    if (!value)
        return 0;
    // Handle "X/5" format
    const slashMatch = value.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
    if (slashMatch)
        return parseFloat(slashMatch[1]);
    // Handle "X stars" format
    const starsMatch = value.match(/(\d+(?:\.\d+)?)\s*stars?/i);
    if (starsMatch)
        return parseFloat(starsMatch[1]);
    // Handle plain number
    const num = parseFloat(value);
    if (!isNaN(num)) {
        // If number is greater than 5, assume it's out of 10 or 100
        if (num > 5 && num <= 10)
            return (num / 10) * 5;
        if (num > 10 && num <= 100)
            return (num / 100) * 5;
        return Math.min(num, 5);
    }
    return 0;
}
// Parse boolean value
function parseBoolean(value) {
    if (!value)
        return false;
    const lower = value.toLowerCase().trim();
    return lower === 'true' || lower === 'yes' || lower === '1' || lower === 'verified';
}
// Parse date value
function parseDate(value) {
    if (!value)
        return undefined;
    try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
            return date.toISOString();
        }
    }
    catch {
        // Ignore parse errors
    }
    return value; // Return original if can't parse
}
// Main parsing function
function parseReviewCSV(content, platform = 'amazon', productUrl) {
    const warnings = [];
    try {
        const { headers, rows } = parseCSV(content);
        // Find column indices
        const reviewTextIdx = findColumnIndex(headers, 'review_text');
        const ratingIdx = findColumnIndex(headers, 'rating');
        const titleIdx = findColumnIndex(headers, 'review_title');
        const reviewerIdx = findColumnIndex(headers, 'reviewer_name');
        const dateIdx = findColumnIndex(headers, 'review_date');
        const productNameIdx = findColumnIndex(headers, 'product_name');
        const productPriceIdx = findColumnIndex(headers, 'product_price');
        const verifiedIdx = findColumnIndex(headers, 'verified_purchase');
        const helpfulIdx = findColumnIndex(headers, 'helpful_votes');
        const urlIdx = findColumnIndex(headers, 'product_url');
        // Check for required fields
        if (reviewTextIdx === -1) {
            return {
                success: false,
                error: 'Could not find review text column. Expected column names: ' + COLUMN_MAPPINGS.review_text.join(', '),
            };
        }
        if (ratingIdx === -1) {
            warnings.push('Rating column not found - ratings will be set to 0');
        }
        // Parse rows
        const reviews = [];
        let skippedRows = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const reviewText = row[reviewTextIdx]?.trim();
            // Skip empty reviews
            if (!reviewText) {
                skippedRows++;
                continue;
            }
            const review = {
                id: `csv-${Date.now()}-${i}`,
                platform,
                product_url: urlIdx !== -1 ? row[urlIdx] : (productUrl || ''),
                product_name: productNameIdx !== -1 ? row[productNameIdx] : undefined,
                product_price: productPriceIdx !== -1 ? row[productPriceIdx] : undefined,
                reviewer_name: reviewerIdx !== -1 ? row[reviewerIdx] : undefined,
                rating: ratingIdx !== -1 ? parseRating(row[ratingIdx]) : 0,
                review_title: titleIdx !== -1 ? row[titleIdx] : undefined,
                review_text: reviewText,
                review_date: dateIdx !== -1 ? parseDate(row[dateIdx]) : undefined,
                verified_purchase: verifiedIdx !== -1 ? parseBoolean(row[verifiedIdx]) : undefined,
                helpful_votes: helpfulIdx !== -1 ? parseInt(row[helpfulIdx]) || 0 : undefined,
            };
            reviews.push(review);
        }
        if (skippedRows > 0) {
            warnings.push(`Skipped ${skippedRows} rows with empty review text`);
        }
        if (reviews.length === 0) {
            return {
                success: false,
                error: 'No valid reviews found in CSV',
            };
        }
        return {
            success: true,
            data: reviews,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }
    catch (error) {
        return {
            success: false,
            error: `Failed to parse CSV: ${error.message}`,
        };
    }
}
// Convert reviews to CSV format for export
function reviewsToCSV(reviews) {
    if (reviews.length === 0)
        return '';
    const headers = [
        'id',
        'platform',
        'product_url',
        'product_name',
        'product_price',
        'reviewer_name',
        'rating',
        'review_title',
        'review_text',
        'review_date',
        'verified_purchase',
        'helpful_votes',
    ];
    const escapeCSV = (value) => {
        if (value === null || value === undefined)
            return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };
    const rows = reviews.map(review => [
        review.id,
        review.platform,
        review.product_url,
        review.product_name || '',
        review.product_price || '',
        review.reviewer_name || '',
        review.rating,
        review.review_title || '',
        review.review_text,
        review.review_date || '',
        review.verified_purchase ? 'true' : 'false',
        review.helpful_votes || 0,
    ].map(escapeCSV).join(','));
    return [headers.join(','), ...rows].join('\n');
}
// Convert reviews to JSON format for export
function reviewsToJSON(reviews) {
    return JSON.stringify(reviews, null, 2);
}
//# sourceMappingURL=csvParserService.js.map