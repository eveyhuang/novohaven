import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/novohaven.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db: SqlJsDatabase | null = null;

// Save database to file
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// Helper to get single row
function getOne(sql: string, params: any[] = []): any | undefined {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

// Initialize database
export async function initializeDatabase(): Promise<void> {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      api_keys TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_by INTEGER REFERENCES users(id),
      is_template BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recipe_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      ai_model TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      input_config TEXT,
      output_format TEXT DEFAULT 'text',
      model_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS company_standards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      standard_type TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER REFERENCES recipes(id),
      user_id INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending',
      current_step INTEGER DEFAULT 0,
      input_data TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS step_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER REFERENCES workflow_executions(id) ON DELETE CASCADE,
      step_id INTEGER REFERENCES recipe_steps(id),
      step_order INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      input_data TEXT,
      output_data TEXT,
      ai_model_used TEXT,
      prompt_used TEXT,
      approved BOOLEAN DEFAULT FALSE,
      error_message TEXT,
      executed_at DATETIME
    )
  `);

  // API Usage tracking table
  db.run(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      service TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      request_count INTEGER DEFAULT 1,
      records_fetched INTEGER DEFAULT 0,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_recipes_created_by ON recipes(created_by)');
  db.run('CREATE INDEX IF NOT EXISTS idx_recipe_steps_recipe_id ON recipe_steps(recipe_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_company_standards_user_id ON company_standards(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_workflow_executions_recipe_id ON workflow_executions(recipe_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_workflow_executions_user_id ON workflow_executions(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_step_executions_execution_id ON step_executions(execution_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_id ON api_usage(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_service ON api_usage(service)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at)');

  // Insert mock user for MVP
  const mockUser = db.exec("SELECT id FROM users WHERE email = 'demo@novohaven.com'");
  if (mockUser.length === 0 || mockUser[0].values.length === 0) {
    db.run("INSERT INTO users (email, password_hash) VALUES ('demo@novohaven.com', 'mock_password_hash')");
  }

  // Seed template recipes
  seedTemplateRecipes();

  // Save to file
  saveDatabase();
}

// Helper function to upsert a template recipe
function upsertTemplateRecipe(
  name: string,
  description: string,
  createdBy: number,
  steps: Array<{
    step_order: number;
    step_name: string;
    ai_model: string;
    prompt_template: string;
    output_format: string;
    model_config: string;
    input_config: string | null;
  }>
): number {
  if (!db) throw new Error('Database not initialized');

  // Check if template exists using getOne helper
  const existing = getOne('SELECT id FROM recipes WHERE name = ? AND is_template = 1', [name]);
  let recipeId: number;

  if (existing) {
    // Update existing template
    recipeId = existing.id;
    db.run(`
      UPDATE recipes 
      SET description = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [description, recipeId]);

    // Delete existing steps
    db.run('DELETE FROM recipe_steps WHERE recipe_id = ?', [recipeId]);
  } else {
    // Insert new template
    db.run(`
      INSERT INTO recipes (name, description, created_by, is_template)
      VALUES (?, ?, ?, 1)
    `, [name, description, createdBy]);
    recipeId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
  }

  // Insert/update steps
  steps.forEach(step => {
    db!.run(`
      INSERT INTO recipe_steps (recipe_id, step_order, step_name, ai_model, prompt_template, output_format, model_config, input_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [recipeId, step.step_order, step.step_name, step.ai_model, step.prompt_template, step.output_format, step.model_config, step.input_config]);
  });

  return recipeId;
}

// Helper function to upsert company standards
function upsertCompanyStandard(
  userId: number,
  standardType: string,
  name: string,
  content: string
): void {
  if (!db) throw new Error('Database not initialized');

  const existing = getOne(
    'SELECT id FROM company_standards WHERE user_id = ? AND standard_type = ? AND name = ?',
    [userId, standardType, name]
  );

  if (existing) {
    // Update existing standard
    db.run(`
      UPDATE company_standards 
      SET content = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [content, existing.id]);
  } else {
    // Insert new standard
    db.run(`
      INSERT INTO company_standards (user_id, standard_type, name, content)
      VALUES (?, ?, ?, ?)
    `, [userId, standardType, name, content]);
  }
}

function seedTemplateRecipes(): void {
  if (!db) return;

  const mockUserId = 1;

  // Template: Image Style Analyzer
  const imageStyleAnalyzerInputConfig = JSON.stringify({
    variables: {
      reference_image: {
        type: 'image',
        label: 'Reference Image',
        description: 'Upload a sample image to analyze its photographic style and technical settings',
        maxImageSize: 10
      }
    }
  });

  const imageStyleAnalyzerSteps = [
    {
      step_order: 1,
      step_name: 'Image Style Analysis',
      ai_model: 'gpt-4o',
      prompt_template: `Analyze this reference image in comprehensive detail for photography reproduction and AI image generation purposes.

{{reference_image}}

Provide a detailed technical analysis in the following JSON structure:

{
  "camera_settings": {
    "estimated_aperture": "f-stop value (e.g., f/1.8, f/2.8, f/8)",
    "estimated_focal_length": "in mm (e.g., 35mm, 50mm, 85mm, 200mm)",
    "estimated_shutter_speed": "fraction or seconds (e.g., 1/250, 1/60, 2s)",
    "estimated_iso": "ISO value (e.g., 100, 400, 1600, 6400)",
    "depth_of_field": "shallow/medium/deep with description",
    "lens_type": "prime/zoom, wide-angle/standard/telephoto",
    "lens_characteristics": "any notable bokeh, distortion, or optical qualities"
  },
  "lighting": {
    "primary_light_source": "natural/artificial, direction, quality",
    "lighting_style": "e.g., Rembrandt, butterfly, split, broad, short",
    "lighting_ratio": "contrast level between highlights and shadows",
    "color_temperature": "warm/neutral/cool with estimated Kelvin",
    "ambient_fill": "description of shadow fill and ambient light",
    "specular_highlights": "presence and quality of highlights",
    "shadows": "hard/soft, direction, density"
  },
  "film_and_processing": {
    "estimated_film_stock": "digital or film type emulation (e.g., Kodak Portra 400, Fuji Pro 400H, digital clean)",
    "grain_texture": "none/fine/medium/heavy with character description",
    "color_profile": "color science characteristics",
    "contrast_curve": "low/medium/high contrast with tonal description",
    "saturation_level": "muted/natural/vibrant",
    "color_grading": "any color shifts or grading applied",
    "black_point": "lifted/true black",
    "highlight_rolloff": "how highlights transition"
  },
  "composition": {
    "framing": "rule of thirds, centered, golden ratio, etc.",
    "perspective": "eye-level, low-angle, high-angle, dutch angle",
    "subject_placement": "where the subject sits in frame",
    "negative_space": "use and balance of empty space",
    "leading_lines": "any compositional lines guiding the eye",
    "layering": "foreground, midground, background elements",
    "crop_style": "tight, medium, wide, environmental"
  },
  "real_world_imperfections": {
    "lens_flare": "presence and style",
    "chromatic_aberration": "color fringing if present",
    "vignetting": "natural or added darkening at edges",
    "motion_blur": "any intentional or unintentional blur",
    "noise_pattern": "luminance and color noise characteristics",
    "dust_scratches": "any film-like artifacts",
    "optical_softness": "any areas of reduced sharpness"
  },
  "character_reference_notes": {
    "key_visual_elements": "distinctive features to maintain consistency",
    "color_palette": "dominant and accent colors with hex codes if possible",
    "mood_atmosphere": "emotional quality and ambiance",
    "style_keywords": "5-10 keywords for AI image generation",
    "negative_prompt_suggestions": "what to avoid to maintain this style"
  },
  "ai_reproduction_prompt": {
    "positive_prompt": "detailed prompt to recreate this style in AI image generators",
    "negative_prompt": "elements to exclude for style consistency",
    "recommended_settings": {
      "cfg_scale": "suggested value for Stable Diffusion",
      "sampling_steps": "suggested range",
      "upscale_method": "recommended upscaling approach"
    }
  }
}

Be specific and technical. Include real-world imperfections that give the image character. The analysis should enable someone to recreate this exact photographic style.`,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.3, maxTokens: 4000 }),
      input_config: imageStyleAnalyzerInputConfig
    }
  ];

  upsertTemplateRecipe(
    'Image Style Analyzer',
    'Analyze photography style, camera settings, lighting, and composition for AI image generation reference',
    mockUserId,
    imageStyleAnalyzerSteps
  );

  // Template: Product Image Generator

  const imageGenInputConfig = JSON.stringify({
    variables: {
      product_images: {
        type: 'image',
        label: 'Product Reference Images',
        description: 'Upload one or more product images to use as reference for AI generation',
        maxImageSize: 10
      },
      requirements: {
        type: 'file',
        label: 'Image Requirements (JSON)',
        description: 'Upload a JSON file with detailed requirements for the generated images',
        acceptedFileTypes: ['.json']
      }
    }
  });

  const imageGenSteps = [
    {
      step_order: 1,
      step_name: 'Generate Product Images',
      ai_model: 'gemini-2.5-flash-image',
      prompt_template: `Generate a professional product photography image based on the following specifications.

Product Reference: {{product_images}}

Requirements from JSON specification:
{{requirements}}

Create a high-quality, professional product image that:
1. Showcases the product clearly and attractively
2. Follows the style, lighting, and composition requirements specified
3. Has a clean, professional background as specified
4. Maintains accurate product details and proportions
5. Is suitable for e-commerce and marketing use

Generate the image according to the exact specifications provided in the requirements.`,
      output_format: 'image',
      model_config: JSON.stringify({ numberOfImages: 1, aspectRatio: '1:1' }),
      input_config: imageGenInputConfig
    }
  ];

  upsertTemplateRecipe(
    'Product Image Generator',
    'Generate professional product images using AI based on reference images and detailed requirements',
    mockUserId,
    imageGenSteps
  );

  // Template: Review Extractor

  const reviewExtractorInputConfig = JSON.stringify({
    variables: {
      product_urls: {
        type: 'url_list',
        label: 'Product URLs',
        description: 'Enter product page URLs from Amazon, Walmart, or Wayfair (one per line). Leave empty if uploading CSV.',
        placeholder: 'https://www.amazon.com/dp/...\nhttps://www.walmart.com/ip/...'
      },
      csv_file: {
        type: 'file',
        label: 'CSV Upload (Optional)',
        description: 'Alternatively, upload a CSV file with review data. Must have columns for review text and rating.',
        acceptedFileTypes: ['.csv'],
        optional: true
      }
    }
  });

  const reviewExtractorSteps = [
    {
      step_order: 1,
      step_name: 'Extract & Normalize Reviews',
      ai_model: 'gpt-4o',
      prompt_template: `You are a data processing assistant. Your task is to extract, normalize, and structure product review data.

INPUT DATA:
{{product_urls}}
{{csv_file}}

INSTRUCTIONS:
1. If URLs are provided, the system will have scraped reviews from those URLs. Process the scraped data.
2. If CSV data is provided, parse and normalize it to a standard format.
3. For each review, extract:
   - Product name and URL
   - Reviewer name (if available)
   - Rating (normalize to 1-5 scale)
   - Review title
   - Full review text
   - Review date
   - Verified purchase status
   - Helpful votes count

OUTPUT FORMAT:
Return a JSON object with this structure:
{
  "extraction_summary": {
    "total_products": number,
    "total_reviews": number,
    "platforms": ["amazon", "walmart", "wayfair"],
    "date_range": { "earliest": "YYYY-MM-DD", "latest": "YYYY-MM-DD" }
  },
  "products": [
    {
      "product_name": "string",
      "product_url": "string",
      "platform": "amazon|walmart|wayfair",
      "average_rating": number,
      "total_reviews": number,
      "rating_distribution": { "5": n, "4": n, "3": n, "2": n, "1": n }
    }
  ],
  "reviews": [
    {
      "id": "string",
      "product_name": "string",
      "platform": "string",
      "rating": number,
      "title": "string",
      "text": "string",
      "date": "YYYY-MM-DD",
      "verified": boolean,
      "helpful_votes": number,
      "sentiment": "positive|neutral|negative"
    }
  ]
}

Ensure all text is properly escaped for JSON. Classify each review's sentiment based on rating (4-5 = positive, 3 = neutral, 1-2 = negative).`,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.1, maxTokens: 8000 }),
      input_config: reviewExtractorInputConfig
    }
  ];

  upsertTemplateRecipe(
    'Review Extractor',
    'Extract and normalize product reviews from e-commerce URLs (Amazon, Walmart, Wayfair) or uploaded CSV files',
    mockUserId,
    reviewExtractorSteps
  );

  // Template: Review Analyzer

  const reviewAnalyzerInputConfig = JSON.stringify({
    variables: {
      review_data: {
        type: 'file',
        label: 'Review Data (JSON)',
        description: 'Upload the JSON output from Review Extractor, or paste review data in the expected format',
        acceptedFileTypes: ['.json']
      },
      analysis_focus: {
        type: 'textarea',
        label: 'Analysis Focus (Optional)',
        description: 'Specify particular aspects to focus on (e.g., "durability", "ease of use", "value for money")',
        optional: true
      }
    }
  });

  const reviewAnalyzerSteps = [
    {
      step_order: 1,
      step_name: 'Categorize Reviews',
      ai_model: 'claude-3-opus-20240229',
      prompt_template: `You are a market research analyst specializing in consumer feedback analysis. Analyze the following product reviews and categorize them.

REVIEW DATA:
{{review_data}}

ANALYSIS FOCUS:
{{analysis_focus}}

TASK:
Categorize each review into themes and extract key insights. For EACH review, identify:
1. Primary theme (e.g., "Quality", "Value", "Usability", "Design", "Customer Service", "Durability", "Performance")
2. Secondary themes if applicable
3. Specific features or aspects mentioned
4. Emotional tone (frustrated, satisfied, delighted, disappointed, neutral)

OUTPUT FORMAT (JSON):
{
  "categorized_reviews": [
    {
      "review_id": "string",
      "rating": number,
      "primary_theme": "string",
      "secondary_themes": ["string"],
      "features_mentioned": ["string"],
      "emotional_tone": "string",
      "key_quote": "string (most representative sentence)",
      "sentiment": "positive|neutral|negative"
    }
  ],
  "theme_summary": {
    "theme_name": {
      "count": number,
      "avg_rating": number,
      "sentiment_breakdown": { "positive": n, "neutral": n, "negative": n }
    }
  }
}`,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.2, maxTokens: 8000 }),
      input_config: reviewAnalyzerInputConfig
    },
    {
      step_order: 2,
      step_name: 'Analyze Positive Reviews',
      ai_model: 'claude-3-opus-20240229',
      prompt_template: `You are a market research analyst. Based on the categorized review data, perform deep analysis on POSITIVE reviews (ratings 4-5).

CATEGORIZED DATA:
{{step_1_output}}

ANALYSIS FOCUS:
{{analysis_focus}}

TASK:
Analyze all positive reviews to understand what customers LOVE about this product. Identify:

1. **Top Praised Features** - What specific features/aspects get the most positive mentions?
2. **Unexpected Delights** - What positive aspects surprised customers?
3. **Use Cases** - How are satisfied customers using the product?
4. **Comparison Wins** - What makes this better than alternatives (when mentioned)?
5. **Emotional Triggers** - What creates strong positive emotional responses?

OUTPUT FORMAT (JSON):
{
  "positive_analysis": {
    "total_positive_reviews": number,
    "average_positive_rating": number,
    "top_praised_features": [
      {
        "feature": "string",
        "mention_count": number,
        "percentage_of_positive": number,
        "representative_quotes": ["string", "string"],
        "why_customers_love_it": "string"
      }
    ],
    "unexpected_delights": [
      {
        "aspect": "string",
        "description": "string",
        "quotes": ["string"]
      }
    ],
    "common_use_cases": [
      {
        "use_case": "string",
        "frequency": "common|occasional|rare",
        "satisfaction_level": "high|medium"
      }
    ],
    "competitive_advantages": [
      {
        "advantage": "string",
        "compared_to": "string (if mentioned)",
        "quotes": ["string"]
      }
    ],
    "emotional_highlights": [
      {
        "emotion": "string",
        "trigger": "string",
        "example_quotes": ["string"]
      }
    ],
    "key_takeaways": ["string", "string", "string"]
  }
}`,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.3, maxTokens: 6000 }),
      input_config: null
    },
    {
      step_order: 3,
      step_name: 'Analyze Negative Reviews',
      ai_model: 'claude-3-opus-20240229',
      prompt_template: `You are a market research analyst. Based on the categorized review data, perform deep analysis on NEGATIVE reviews (ratings 1-2).

CATEGORIZED DATA:
{{step_1_output}}

ANALYSIS FOCUS:
{{analysis_focus}}

TASK:
Analyze all negative reviews to understand customer pain points and improvement opportunities. Identify:

1. **Critical Issues** - What problems cause the most frustration?
2. **Unmet Expectations** - Where did the product fail to meet customer expectations?
3. **Feature Gaps** - What features do customers wish existed?
4. **Quality Concerns** - Specific quality or durability issues
5. **Comparison Losses** - What makes alternatives better (when mentioned)?

OUTPUT FORMAT (JSON):
{
  "negative_analysis": {
    "total_negative_reviews": number,
    "average_negative_rating": number,
    "critical_issues": [
      {
        "issue": "string",
        "severity": "critical|major|minor",
        "mention_count": number,
        "percentage_of_negative": number,
        "representative_quotes": ["string", "string"],
        "impact_on_customer": "string"
      }
    ],
    "unmet_expectations": [
      {
        "expectation": "string",
        "reality": "string",
        "gap_description": "string",
        "quotes": ["string"]
      }
    ],
    "requested_features": [
      {
        "feature": "string",
        "request_frequency": "common|occasional|rare",
        "potential_impact": "high|medium|low",
        "quotes": ["string"]
      }
    ],
    "quality_concerns": [
      {
        "concern": "string",
        "frequency": number,
        "typical_timeframe": "string (e.g., 'after 2 months')",
        "quotes": ["string"]
      }
    ],
    "competitive_disadvantages": [
      {
        "disadvantage": "string",
        "compared_to": "string",
        "quotes": ["string"]
      }
    ],
    "key_improvement_areas": ["string", "string", "string"]
  }
}`,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.3, maxTokens: 6000 }),
      input_config: null
    },
    {
      step_order: 4,
      step_name: 'Generate Executive Summary',
      ai_model: 'claude-3-opus-20240229',
      prompt_template: `You are a market research analyst preparing an executive summary. Synthesize all previous analysis into actionable insights.

POSITIVE ANALYSIS:
{{step_2_output}}

NEGATIVE ANALYSIS:
{{step_3_output}}

TASK:
Create a comprehensive executive summary that:
1. Highlights the most important findings
2. Provides actionable recommendations
3. Prioritizes improvements by impact
4. Identifies quick wins vs long-term investments

OUTPUT FORMAT (Markdown):

# Product Review Analysis - Executive Summary

## Overview
- Total Reviews Analyzed: [number]
- Overall Sentiment: [positive/mixed/negative]
- Average Rating: [X.X/5]

## What Customers Love (Top 3)
1. **[Feature/Aspect]** - [Brief explanation with supporting data]
2. **[Feature/Aspect]** - [Brief explanation with supporting data]
3. **[Feature/Aspect]** - [Brief explanation with supporting data]

## Critical Pain Points (Top 3)
1. **[Issue]** - [Brief explanation with severity and frequency]
2. **[Issue]** - [Brief explanation with severity and frequency]
3. **[Issue]** - [Brief explanation with severity and frequency]

## Improvement Recommendations

### Quick Wins (High Impact, Lower Effort)
| Recommendation | Expected Impact | Evidence |
|----------------|-----------------|----------|
| ... | ... | ... |

### Strategic Investments (High Impact, Higher Effort)
| Recommendation | Expected Impact | Evidence |
|----------------|-----------------|----------|
| ... | ... | ... |

## Feature Wishlist (Customer Requests)
1. [Feature] - Requested by X% of reviewers
2. [Feature] - Requested by X% of reviewers
3. [Feature] - Requested by X% of reviewers

## Competitive Positioning
- **Strengths vs Competition:** [List]
- **Weaknesses vs Competition:** [List]

## Key Quotes

### Positive
> "[Quote]" - [Rating] stars

### Negative
> "[Quote]" - [Rating] stars

## Next Steps
1. [Actionable recommendation]
2. [Actionable recommendation]
3. [Actionable recommendation]`,
      output_format: 'markdown',
      model_config: JSON.stringify({ temperature: 0.4, maxTokens: 4000 }),
      input_config: null
    }
  ];

  upsertTemplateRecipe(
    'Review Analyzer',
    'Perform qualitative analysis on product reviews to understand customer sentiment, pain points, and feature preferences',
    mockUserId,
    reviewAnalyzerSteps
  );

  // Insert/update sample company standards
  upsertCompanyStandard(
    mockUserId,
    'voice',
    'Default Brand Voice',
    JSON.stringify({
      tone: 'Professional yet approachable',
      style: 'Clear, concise, and benefit-focused',
      guidelines: [
        'Use active voice',
        'Avoid jargon unless industry-specific',
        'Focus on customer benefits over features',
        'Maintain consistency across all content'
      ],
      examples: [
        'Instead of "Our product utilizes advanced technology", say "Get results faster with our smart technology"'
      ]
    })
  );

  upsertCompanyStandard(
    mockUserId,
    'platform',
    'Amazon Requirements',
    JSON.stringify({
      platform: 'Amazon',
      requirements: [
        'Title: Max 200 characters, brand name first',
        'Bullet points: 5 bullets, start with capital letter, no ending punctuation',
        'Description: Max 2000 characters, can use basic HTML',
        'No competitor mentions or external URLs'
      ],
      characterLimits: {
        title: 200,
        bulletPoint: 500,
        description: 2000
      }
    })
  );

  upsertCompanyStandard(
    mockUserId,
    'image',
    'Product Photography Style',
    JSON.stringify({
      style: 'Clean, professional, lifestyle-oriented',
      dimensions: '2000x2000px minimum for main images',
      guidelines: [
        'White background for main product shots',
        'Natural lighting preferred',
        'Show product in context for lifestyle shots',
        'Include size reference when helpful'
      ]
    })
  );
}

// Helper to get all rows
function getAll(sql: string, params: any[] = []): any[] {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper to run insert/update/delete
function run(sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  const lastId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] as number || 0;
  const changes = db.getRowsModified();
  saveDatabase();
  return { lastInsertRowid: lastId, changes };
}

// Database access functions
export const queries = {
  // Users
  getUserById: (id: number) => getOne('SELECT * FROM users WHERE id = ?', [id]),
  getUserByEmail: (email: string) => getOne('SELECT * FROM users WHERE email = ?', [email]),
  createUser: (email: string, passwordHash: string, apiKeys?: string) =>
    run('INSERT INTO users (email, password_hash, api_keys) VALUES (?, ?, ?)', [email, passwordHash, apiKeys || null]),
  updateUserApiKeys: (apiKeys: string, id: number) =>
    run('UPDATE users SET api_keys = ? WHERE id = ?', [apiKeys, id]),

  // Recipes
  getAllRecipes: () => getAll('SELECT * FROM recipes ORDER BY updated_at DESC'),
  getRecipesByUser: (userId: number) =>
    getAll('SELECT * FROM recipes WHERE created_by = ? OR is_template = 1 ORDER BY updated_at DESC', [userId]),
  getRecipeById: (id: number) => getOne('SELECT * FROM recipes WHERE id = ?', [id]),
  createRecipe: (name: string, description: string | null, createdBy: number, isTemplate: boolean) =>
    run('INSERT INTO recipes (name, description, created_by, is_template) VALUES (?, ?, ?, ?)',
      [name, description, createdBy, isTemplate ? 1 : 0]),
  updateRecipe: (name: string, description: string | null, id: number) =>
    run('UPDATE recipes SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, description, id]),
  updateRecipeWithTemplate: (name: string, description: string | null, isTemplate: boolean, id: number) =>
    run('UPDATE recipes SET name = ?, description = ?, is_template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, description, isTemplate ? 1 : 0, id]),
  deleteRecipe: (id: number) => run('DELETE FROM recipes WHERE id = ?', [id]),

  // Recipe Steps
  getStepsByRecipeId: (recipeId: number) =>
    getAll('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_order', [recipeId]),
  getStepById: (id: number) => getOne('SELECT * FROM recipe_steps WHERE id = ?', [id]),
  createStep: (recipeId: number, stepOrder: number, stepName: string, aiModel: string,
    promptTemplate: string, inputConfig: string | null, outputFormat: string, modelConfig: string | null) =>
    run(`INSERT INTO recipe_steps (recipe_id, step_order, step_name, ai_model, prompt_template, input_config, output_format, model_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [recipeId, stepOrder, stepName, aiModel, promptTemplate, inputConfig, outputFormat, modelConfig]),
  updateStep: (stepName: string, aiModel: string, promptTemplate: string, inputConfig: string | null,
    outputFormat: string, modelConfig: string | null, id: number) =>
    run(`UPDATE recipe_steps SET step_name = ?, ai_model = ?, prompt_template = ?, input_config = ?, output_format = ?, model_config = ?
      WHERE id = ?`, [stepName, aiModel, promptTemplate, inputConfig, outputFormat, modelConfig, id]),
  deleteStep: (id: number) => run('DELETE FROM recipe_steps WHERE id = ?', [id]),
  deleteStepsByRecipeId: (recipeId: number) => run('DELETE FROM recipe_steps WHERE recipe_id = ?', [recipeId]),

  // Company Standards
  getStandardsByUser: (userId: number) =>
    getAll('SELECT * FROM company_standards WHERE user_id = ? ORDER BY standard_type, name', [userId]),
  getStandardById: (id: number) => getOne('SELECT * FROM company_standards WHERE id = ?', [id]),
  getStandardsByType: (userId: number, standardType: string) =>
    getAll('SELECT * FROM company_standards WHERE user_id = ? AND standard_type = ?', [userId, standardType]),
  createStandard: (userId: number, standardType: string, name: string, content: string) =>
    run('INSERT INTO company_standards (user_id, standard_type, name, content) VALUES (?, ?, ?, ?)',
      [userId, standardType, name, content]),
  updateStandard: (name: string, content: string, id: number) =>
    run('UPDATE company_standards SET name = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, content, id]),
  deleteStandard: (id: number) => run('DELETE FROM company_standards WHERE id = ?', [id]),

  // Workflow Executions
  getExecutionsByUser: (userId: number) =>
    getAll('SELECT * FROM workflow_executions WHERE user_id = ? ORDER BY created_at DESC', [userId]),
  getExecutionById: (id: number) => getOne('SELECT * FROM workflow_executions WHERE id = ?', [id]),
  getExecutionsByRecipe: (recipeId: number) =>
    getAll('SELECT * FROM workflow_executions WHERE recipe_id = ? ORDER BY created_at DESC', [recipeId]),
  createExecution: (recipeId: number, userId: number, inputData: string) =>
    run(`INSERT INTO workflow_executions (recipe_id, user_id, status, input_data, started_at)
      VALUES (?, ?, 'running', ?, CURRENT_TIMESTAMP)`, [recipeId, userId, inputData]),
  updateExecutionStatus: (status: string, currentStep: number, id: number) =>
    run('UPDATE workflow_executions SET status = ?, current_step = ? WHERE id = ?', [status, currentStep, id]),
  completeExecution: (status: string, id: number) =>
    run('UPDATE workflow_executions SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id]),
  cancelExecution: (id: number) =>
    run('UPDATE workflow_executions SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', ['cancelled', id]),
  deleteExecution: (id: number) => {
    run('DELETE FROM step_executions WHERE execution_id = ?', [id]);
    return run('DELETE FROM workflow_executions WHERE id = ?', [id]);
  },

  // Step Executions
  getStepExecutionsByExecutionId: (executionId: number) =>
    getAll('SELECT * FROM step_executions WHERE execution_id = ? ORDER BY step_order', [executionId]),
  getStepExecutionById: (id: number) => getOne('SELECT * FROM step_executions WHERE id = ?', [id]),
  createStepExecution: (executionId: number, stepId: number, stepOrder: number, inputData: string) =>
    run(`INSERT INTO step_executions (execution_id, step_id, step_order, status, input_data)
      VALUES (?, ?, ?, 'pending', ?)`, [executionId, stepId, stepOrder, inputData]),
  updateStepExecution: (status: string, outputData: string | null, aiModelUsed: string | null,
    promptUsed: string | null, id: number) =>
    run(`UPDATE step_executions SET status = ?, output_data = ?, ai_model_used = ?, prompt_used = ?, executed_at = CURRENT_TIMESTAMP
      WHERE id = ?`, [status, outputData, aiModelUsed, promptUsed, id]),
  approveStepExecution: (approved: boolean, status: string, id: number) =>
    run('UPDATE step_executions SET approved = ?, status = ? WHERE id = ?', [approved ? 1 : 0, status, id]),
  setStepExecutionError: (status: string, errorMessage: string, id: number) =>
    run('UPDATE step_executions SET status = ?, error_message = ? WHERE id = ?', [status, errorMessage, id]),

  // Outputs - Get all completed step outputs for a user
  getAllOutputsByUser: (userId: number) =>
    getAll(`
      SELECT
        se.id,
        se.execution_id,
        se.step_id,
        se.step_order,
        se.output_data,
        se.ai_model_used,
        se.executed_at,
        we.recipe_id,
        r.name as recipe_name,
        rs.step_name,
        rs.output_format
      FROM step_executions se
      JOIN workflow_executions we ON se.execution_id = we.id
      JOIN recipes r ON we.recipe_id = r.id
      LEFT JOIN recipe_steps rs ON se.step_id = rs.id
      WHERE we.user_id = ?
        AND se.status IN ('completed', 'awaiting_review')
        AND se.output_data IS NOT NULL
      ORDER BY se.executed_at DESC
    `, [userId]),

  // API Usage tracking
  logApiUsage: (userId: number, service: string, endpoint: string, requestCount: number, recordsFetched: number, metadata?: string) =>
    run(`INSERT INTO api_usage (user_id, service, endpoint, request_count, records_fetched, metadata)
      VALUES (?, ?, ?, ?, ?, ?)`, [userId, service, endpoint, requestCount, recordsFetched, metadata || null]),

  getUsageByUser: (userId: number) =>
    getAll('SELECT * FROM api_usage WHERE user_id = ? ORDER BY created_at DESC', [userId]),

  getUsageByUserAndService: (userId: number, service: string) =>
    getAll('SELECT * FROM api_usage WHERE user_id = ? AND service = ? ORDER BY created_at DESC', [userId, service]),

  getUsageStats: (userId: number) =>
    getOne(`
      SELECT
        COUNT(*) as total_requests,
        SUM(records_fetched) as total_records,
        SUM(CASE WHEN date(created_at) = date('now') THEN request_count ELSE 0 END) as today_requests,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN request_count ELSE 0 END) as week_requests,
        SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN request_count ELSE 0 END) as month_requests
      FROM api_usage WHERE user_id = ?
    `, [userId]),

  getUsageByService: (userId: number) =>
    getAll(`
      SELECT
        service,
        SUM(request_count) as total_requests,
        SUM(records_fetched) as total_records
      FROM api_usage
      WHERE user_id = ?
      GROUP BY service
    `, [userId]),

  getAllUsageAdmin: () =>
    getAll(`
      SELECT
        u.id as user_id,
        u.email,
        au.service,
        SUM(au.request_count) as total_requests,
        SUM(au.records_fetched) as total_records,
        MAX(au.created_at) as last_used
      FROM api_usage au
      JOIN users u ON au.user_id = u.id
      GROUP BY u.id, au.service
      ORDER BY total_requests DESC
    `),
};

export default db;
