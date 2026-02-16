# Wayfair Review Extraction Guide

A step-by-step guide for extracting all user reviews from any Wayfair product page using Chrome DevTools MCP + Lark/Feishu MCP.

---

## Overview

Wayfair uses a **GraphQL persisted query** system to load reviews. Reviews are lazy-loaded — only 5 show initially. The key is to intercept the GraphQL request, then replay it with a higher `firstReview` count to get all reviews at once.

## Prerequisites

- Chrome DevTools MCP connected
- Lark MCP connected (if creating Feishu doc)
- The Wayfair product page URL

---

## Step 1: Navigate to the Product Page

```
Navigate to the Wayfair product URL using Chrome DevTools MCP navigate_page.
```

**Important**: Use the default viewport size. Do NOT resize to unusual dimensions — Wayfair's PerimeterX bot detection will trigger a "Press & Hold" CAPTCHA if it detects anomalous browser behavior (e.g., 8000px viewport height).

If CAPTCHA is triggered, the user must manually solve it before continuing.

## Step 2: Scroll Down to Load the Reviews Section

Reviews are lazy-loaded. You must scroll the page to trigger them:

```javascript
// Scroll slowly in increments to trigger lazy loading
window.scrollTo(0, 2000);
// Wait, then continue scrolling
window.scrollTo(0, 4000);
window.scrollTo(0, 6000);
// Keep going until you see "Customer Reviews" in the page snapshot
```

Take a snapshot after scrolling to confirm the reviews section has loaded (look for "Customer Reviews" or "Showing 1-5 of N reviews").

## Step 3: Extract the nodeId from the Page

The `nodeId` is a base64-encoded identifier for the product listing variant. Extract it from the page's Next.js SSR data:

```javascript
// Method 1: From network requests (preferred)
// Look for GraphQL requests containing "PDPReviewsMPLVByNodeIdDataQuery"

// Method 2: From SSR embedded data
const scripts = document.querySelectorAll('script');
let nodeId = null;
for (const script of scripts) {
  const text = script.textContent || '';
  const match = text.match(/"nodeId"\s*:\s*"(TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudD[^"]+)"/);
  if (match) {
    nodeId = match[1];
    break;
  }
}
```

The `nodeId` always starts with `TWFya2V0cGxhY2VMaXN0aW5nVmFyaWFudD` (base64 for "MarketplaceListingVariant:").

## Step 4: Get the Total Review Count

From the page snapshot or SSR data, find the total number of reviews (e.g., "64 reviews"). This will be used as `firstReview` to fetch all at once.

## Step 5: Fetch All Reviews via GraphQL API

This is the key step. Execute this fetch from **within the page context** (via `evaluate_script`) to inherit cookies and auth headers:

```javascript
const response = await fetch('https://www.wayfair.com/federation/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-oi-client': 'sf-ui-web',
    'apollographql-client-name': '@wayfair/sf-ui-core-funnel',
    'apollographql-client-version': 'f30378acf41d5de87e84b9159a0bd400ff4e7d2e',
    'x-wayfair-locale': 'en-US',
    'x-wf-way': 'true'
  },
  credentials: 'include',
  body: JSON.stringify({
    operationName: 'PDPReviewsMPLVByNodeIdDataQuery',
    variables: {
      nodeId: '<PASTE_NODE_ID_HERE>',
      firstImage: 1,
      firstReview: 100,          // Set to total review count or higher
      sort: 'RELEVANCE_DESC',
      includeImages: true
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'fd486434f7f187089721b27eabba5632a38689ab17ee027f45913299f022cfc9'
      }
    }
  })
});

const data = await response.json();
const reviews = data.data.listingVariant.reviewslist.reviews.edges.map(e => e.node);
JSON.stringify({
  totalCount: data.data.listingVariant.reviewslist.reviews.totalCount,
  averageRating: data.data.listingVariant.reviewsRating.reviews.averageRating,
  histogram: data.data.listingVariant.reviewsHistogram.reviews.ratingHistogram,
  reviews: reviews.map(r => ({
    name: r.reviewerGivenName,
    location: r.reviewerLocation,
    rating: r.rating,
    date: r.formattedDate,
    body: r.body,
    badge: r.badge
  }))
});
```

### Key Parameters

| Parameter | Description |
|-----------|-------------|
| `nodeId` | Base64-encoded product listing variant ID (unique per product/variant) |
| `firstReview` | Number of reviews to fetch — set to total count or higher |
| `sort` | `RELEVANCE_DESC` (default), can also try `DATE_DESC` |
| `firstImage` | Number of images per review to include |
| `sha256Hash` | Persisted query hash — `fd486434f7f187089721b27eabba5632a38689ab17ee027f45913299f022cfc9` |

### Response Structure

```
data.listingVariant
├── reviewsHistogram.reviews.ratingHistogram[]  → { rating, totalCount }
├── reviewsRating.reviews
│   ├── averageRating  → e.g. 4.28
│   └── totalCount     → e.g. 64
└── reviewslist.reviews.edges[]
    └── node
        ├── reviewId
        ├── reviewerGivenName
        ├── reviewerLocation
        ├── rating (1-5)
        ├── formattedDate (e.g. "01/26/2026")
        ├── body (review text)
        ├── badge (e.g. "Neighbors Program")
        ├── badgeDescription
        ├── images[] → { imageId }
        ├── locale
        ├── isTranslatable
        └── isTranslated
```

## Step 6: Create Feishu Document (Optional)

Use the Lark MCP `docx_builtin_import` tool:

- **file_name**: Max 27 characters! Keep it short.
- **file_type**: `"md"` (markdown)
- **content**: Markdown string with all reviews formatted

Example markdown structure:
```markdown
# Product Name - Customer Reviews

**Average Rating**: 4.28/5 (64 reviews)

## Rating Distribution
| Stars | Count |
|-------|-------|
| ⭐⭐⭐⭐⭐ | 38 |
| ⭐⭐⭐⭐ | 15 |
| ⭐⭐⭐ | 5 |
| ⭐⭐ | 3 |
| ⭐ | 3 |

## All Reviews

### Review #1
- **Reviewer**: Name — Location
- **Rating**: ⭐⭐⭐⭐⭐ (5/5)
- **Date**: 01/26/2026
- **Badge**: Neighbors Program

> Review text here...

---
(repeat for all reviews)
```

---

## Troubleshooting

### Bot Detection / CAPTCHA
- **Cause**: Unusual viewport sizes, rapid navigation, or too many requests
- **Fix**: User must manually solve the "Press & Hold" CAPTCHA. Then continue.

### 400 Bad Request on GraphQL
- **Cause**: Wrong headers or query format
- **Fix**: Must use the exact persisted query hash. Custom GraphQL queries are rejected.

### 429 Too Many Requests
- **Cause**: CDN rate limiting
- **Fix**: Wait a moment and retry. Execute from within the page context (not external).

### Reviews Section Not Loading
- **Cause**: Lazy loading not triggered
- **Fix**: Scroll the page incrementally (2000px at a time) and wait between scrolls.

### "Show More Reviews" Button Doesn't Work
- Don't bother with the button. It triggers complex React state management and auth flows.
- Use the GraphQL API directly (Step 5) — it's faster and more reliable.

---

## Notes

- The `sha256Hash` for the persisted query may change if Wayfair updates their frontend. If the hash stops working, intercept network requests again to find the new hash.
- The `apollographql-client-version` header may also need updating over time.
- Always execute the fetch from within the page context (`evaluate_script`) to inherit session cookies.
- The `nodeId` changes per product variant (e.g., different colors/sizes of the same product).
