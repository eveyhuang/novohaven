const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

async function scrapeWayfairReviews() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const url = 'https://www.wayfair.com/furniture/pdp/orren-ellis-bachman-extendable-45-to-105-solid-wood-dining-table-with-hiden-storage-space-w111552936.html?piid=1040019282';

  console.log('Navigating to product page...');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('Navigation timeout, continuing...');
  }

  await page.waitForTimeout(5000);

  // Check for CAPTCHA
  const content = await page.content();
  if (content.includes('Before we continue') || content.includes('Press & Hold')) {
    console.log('CAPTCHA detected! Waiting for manual solve...');
    await page.waitForTimeout(45000);
  }

  await page.waitForTimeout(3000);

  // Scroll to find reviews section
  console.log('Scrolling to find reviews section...');
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(300);
  }

  // Click on reviews to open the drawer
  console.log('Opening reviews drawer...');
  try {
    const reviewLink = await page.$('[data-hb-id="ReviewsStars"]') ||
                       await page.$('text=/\\d+\\s*Reviews/i') ||
                       await page.$('a:has-text("Reviews")');
    if (reviewLink) {
      await reviewLink.click();
      await page.waitForTimeout(3000);
    }
  } catch (e) {
    console.log('Could not click reviews link');
  }

  await page.waitForTimeout(2000);

  // Extract reviews by scrolling through the drawer
  console.log('Extracting all reviews...');
  const allReviews = [];
  let prevCount = 0;
  let stableCount = 0;
  let pageNum = 1;

  // Function to extract reviews from current view
  const extractReviews = async () => {
    return await page.evaluate(() => {
      const results = [];

      // Find all review cards - they have specific structure
      // Look for elements containing review info
      document.querySelectorAll('div').forEach((el) => {
        const text = el.innerText || '';

        // Must have a date in format MM/DD/YYYY
        const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (!dateMatch) return;

        // Must have a rating
        const ratingMatch = text.match(/Rated?\s*(\d+)\s*out of\s*5/i);
        if (!ratingMatch) return;

        // Skip containers that are too large (probably parent containers)
        if (text.length > 2000) return;

        // Skip if has price (product cards)
        if (text.includes('$')) return;

        // Must have Verified Purchaser or reasonable length content
        const hasVerified = text.toLowerCase().includes('verified');
        const contentLength = text.split('\n').filter(l => l.length > 30).length;

        if (!hasVerified && contentLength < 1) return;

        // Parse the review
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        let rating = ratingMatch[1];
        let date = dateMatch[1];
        let author = '';
        let location = '';
        let content = '';
        let verified = hasVerified;

        // Find author and location (usually in format "Name Location, ST on date")
        for (const line of lines) {
          // Skip common UI text
          if (line.match(/^(Rated|stars|Verified|Report|Helpful|Yes|No|Share|Filter|Sort)/i)) continue;

          // Check for location line with date
          const locDateMatch = line.match(/^(.+?),\s*([A-Z]{2})\s+on\s+\d{1,2}\/\d{1,2}\/\d{4}/);
          if (locDateMatch) {
            location = `${locDateMatch[1]}, ${locDateMatch[2]}`;
            continue;
          }

          // Author name (short, capitalized)
          if (!author && line.length > 2 && line.length < 30) {
            if (line.match(/^[A-Z][a-z]+(\s+[A-Z]\.?)?$/) && !line.match(/^(Customer|Reviews|Verified)/i)) {
              author = line;
              continue;
            }
          }

          // Review content - longer text that's not UI
          if (line.length > 40 && !line.match(/^(Show|Hide|Read|Filter|Sort|Verified|Customer Reviews)/i)) {
            if (!content || line.length > content.length) {
              content = line;
            }
          }
        }

        if (content && content.length > 30) {
          results.push({
            rating,
            author: author || 'Anonymous',
            date,
            location,
            content: content.substring(0, 2000),
            verified
          });
        }
      });

      // Deduplicate
      const seen = new Set();
      return results.filter(r => {
        const key = r.content.substring(0, 60);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
  };

  // Extract from first page
  let reviews = await extractReviews();
  allReviews.push(...reviews);
  console.log(`Page 1: Found ${reviews.length} reviews`);

  // Try pagination - look for page buttons in the drawer
  while (pageNum < 20) {
    // Look for Next button or page numbers
    const nextBtn = await page.$('button[aria-label*="Next"], button[aria-label*="next"]') ||
                    await page.$(`button:has-text("${pageNum + 1}")`) ||
                    await page.$('[class*="Pagination"] button:not([disabled]):last-of-type');

    if (nextBtn) {
      try {
        // Check if it's disabled
        const isDisabled = await nextBtn.evaluate(el =>
          el.disabled ||
          el.getAttribute('disabled') !== null ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled')
        );

        if (isDisabled) {
          console.log('Reached last page (button disabled)');
          break;
        }

        await nextBtn.click();
        await page.waitForTimeout(2000);
        pageNum++;

        reviews = await extractReviews();
        const newReviews = reviews.filter(r => {
          const key = r.content.substring(0, 60);
          return !allReviews.some(existing => existing.content.substring(0, 60) === key);
        });

        if (newReviews.length === 0) {
          stableCount++;
          if (stableCount >= 2) {
            console.log('No new reviews found, stopping');
            break;
          }
        } else {
          stableCount = 0;
          allReviews.push(...newReviews);
          console.log(`Page ${pageNum}: Found ${newReviews.length} new reviews (total: ${allReviews.length})`);
        }
      } catch (e) {
        console.log('Error clicking next:', e.message);
        break;
      }
    } else {
      // Try scrolling in drawer instead
      const scrollResult = await page.evaluate(() => {
        const containers = [
          document.querySelector('[class*="Drawer"]'),
          document.querySelector('[class*="Modal"]'),
          document.querySelector('[class*="ReviewsList"]'),
          document.querySelector('[role="dialog"]')
        ].filter(Boolean);

        for (const container of containers) {
          const scrollBefore = container.scrollTop;
          container.scrollTop += 500;
          if (container.scrollTop !== scrollBefore) {
            return true;
          }
        }
        return false;
      });

      if (!scrollResult) {
        console.log('Cannot scroll further');
        break;
      }

      await page.waitForTimeout(1500);
      pageNum++;

      reviews = await extractReviews();
      const newReviews = reviews.filter(r => {
        const key = r.content.substring(0, 60);
        return !allReviews.some(existing => existing.content.substring(0, 60) === key);
      });

      if (newReviews.length > 0) {
        allReviews.push(...newReviews);
        console.log(`Scroll ${pageNum}: Found ${newReviews.length} new reviews (total: ${allReviews.length})`);
        stableCount = 0;
      } else {
        stableCount++;
        if (stableCount >= 3) break;
      }
    }
  }

  console.log(`\n=== Total reviews extracted: ${allReviews.length} ===`);

  // Clean up the data
  const cleanedReviews = allReviews.map((r, i) => ({
    序号: i + 1,
    评分: r.rating,
    评价人: r.author,
    日期: r.date,
    地点: r.location,
    评价内容: r.content,
    是否验证购买: r.verified ? '是' : '否'
  }));

  require('fs').writeFileSync('wayfair_reviews.json', JSON.stringify(cleanedReviews, null, 2));
  console.log('Saved to wayfair_reviews.json');

  await page.screenshot({ path: 'wayfair_final.png' });
  await page.waitForTimeout(2000);
  await browser.close();

  return cleanedReviews;
}

scrapeWayfairReviews().catch(console.error);
