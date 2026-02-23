import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/novohaven.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db: Database.Database | null = null;

// No-op: better-sqlite3 persists to file automatically
export function saveDatabase() {}

// Helper to get single row
function getOne(sql: string, params: any[] = []): any | undefined {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).get(...params);
}

// Helper to get all rows
function getAll(sql: string, params: any[] = []): any[] {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).all(...params);
}

// Helper to run insert/update/delete
function run(sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } {
  if (!db) throw new Error('Database not initialized');
  const result = db.prepare(sql).run(...params);
  return {
    lastInsertRowid: Number(result.lastInsertRowid),
    changes: result.changes,
  };
}

// Get raw database instance
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Initialize database (synchronous with better-sqlite3)
export function initializeDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      api_keys TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS recipe_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      step_type TEXT DEFAULT 'ai',
      ai_model TEXT,
      prompt_template TEXT,
      input_config TEXT,
      output_format TEXT DEFAULT 'text',
      model_config TEXT,
      api_config TEXT,
      executor_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS manus_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      task_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      output_text TEXT,
      files TEXT,
      credits_used REAL,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_recipes_created_by ON recipes(created_by)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recipe_steps_recipe_id ON recipe_steps(recipe_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_company_standards_user_id ON company_standards(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_executions_recipe_id ON workflow_executions(recipe_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_executions_user_id ON workflow_executions(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_step_executions_execution_id ON step_executions(execution_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_user_id ON api_usage(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_service ON api_usage(service)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manus_outputs_user_id ON manus_outputs(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manus_outputs_task_id ON manus_outputs(task_id)');

  // --- New gateway tables ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      thread_id TEXT,
      agent_pid INTEGER,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','idle','closed')),
      agent_config_id INTEGER,
      active_execution_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_execution_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      task_boundary_id INTEGER,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('skill','workflow')),
      asset_id INTEGER NOT NULL,
      asset_name TEXT,
      execution_id INTEGER,
      execution_status TEXT,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      step_outputs_json TEXT NOT NULL DEFAULT '[]',
      latest_output_summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      default_model TEXT NOT NULL,
      system_prompt TEXT,
      allowed_tools TEXT DEFAULT '[]',
      allowed_channels TEXT DEFAULT '[]',
      max_turns_per_session INTEGER DEFAULT 50,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_name TEXT UNIQUE NOT NULL,
      plugin_type TEXT NOT NULL CHECK(plugin_type IN ('channel','tool','memory','provider')),
      enabled BOOLEAN DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_skill_id INTEGER,
      skill_type TEXT NOT NULL CHECK(skill_type IN ('skill','workflow')),
      proposed_by_session TEXT,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT NOT NULL,
      change_summary TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_session_execution_memory_session ON session_execution_memory(session_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_execution_memory_asset ON session_execution_memory(session_id, asset_type, asset_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_execution_memory_execution ON session_execution_memory(execution_id)');

  // Insert mock user for MVP and get the user ID
  let mockUserId: number;
  const mockUser = getOne("SELECT id FROM users WHERE email = 'demo@novohaven.com'");
  if (!mockUser) {
    run("INSERT INTO users (email, password_hash) VALUES ('demo@novohaven.com', 'mock_password_hash')");
    const insertedUser = getOne("SELECT id FROM users WHERE email = 'demo@novohaven.com'");
    if (!insertedUser || !insertedUser.id) {
      throw new Error('Failed to create mock user');
    }
    mockUserId = insertedUser.id;
  } else {
    if (!mockUser.id) {
      throw new Error('Mock user exists but has no ID');
    }
    mockUserId = mockUser.id;
  }

  // Verify user exists before seeding
  const verifyUser = getOne('SELECT id FROM users WHERE id = ?', [mockUserId]);
  if (!verifyUser) {
    throw new Error(`User with ID ${mockUserId} does not exist`);
  }

  // Run migrations (recipes → skills/workflows)
  runMigrations();

  // Seed default skills/workflows only once per seed version.
  // We claim a one-time seed lock row so concurrent initializers do not reseed.
  const defaultSkillsSeedKey = 'default_assets_seeded_v2';
  const seedClaim = run(
    'INSERT OR IGNORE INTO app_metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
    [defaultSkillsSeedKey, 'claimed']
  );
  if (seedClaim.changes > 0) {
    seedDefaultAssets(mockUserId);
    run(
      'UPDATE app_metadata SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
      ['completed', defaultSkillsSeedKey]
    );
  }

  const DEFAULT_AGENT_MODEL = 'gemini-3-flash-preview';

  // Seed default agent config
  const defaultAgent = getOne('SELECT id FROM agent_configs WHERE name = ?', ['Default Agent']);
  if (!defaultAgent) {
    run(`INSERT INTO agent_configs (name, description, default_model, system_prompt, allowed_tools, allowed_channels)
      VALUES (?, ?, ?, ?, ?, ?)`,
      ['Default Agent', 'Default agent configuration',
       DEFAULT_AGENT_MODEL,
       'You are a helpful AI assistant with access to skills and workflows. When a user asks you to do something, search for relevant skills first. If a skill exists, use it. If not, help the user directly or propose creating a new skill.',
       '["tool-browser","tool-bash","tool-fileops","tool-skill-manager"]',
       '["channel-web","channel-lark"]']);
  }

  // Keep the default agent model aligned with the current preferred low-latency model.
  const currentDefault = getOne('SELECT default_model FROM agent_configs WHERE name = ?', ['Default Agent']);
  if (currentDefault && currentDefault.default_model !== DEFAULT_AGENT_MODEL) {
    run('UPDATE agent_configs SET default_model = ? WHERE name = ?', [DEFAULT_AGENT_MODEL, 'Default Agent']);
    console.log(`[Database] Updated default agent model to ${DEFAULT_AGENT_MODEL}`);
  }
}

function runMigrations(): void {
  if (!db) return;

  // Check if migration already ran
  const hasSkillsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='skills'"
  ).get();
  if (hasSkillsTable) return;

  db.transaction(() => {
    // Create skills table
    db!.exec(`
      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id),
        status TEXT DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
        tags TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create workflows table
    db!.exec(`
      CREATE TABLE workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id),
        status TEXT DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
        tags TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create skill_steps table
    db!.exec(`
      CREATE TABLE skill_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER NOT NULL,
        parent_type TEXT NOT NULL CHECK(parent_type IN ('skill','workflow')),
        step_order INTEGER NOT NULL,
        step_name TEXT,
        step_type TEXT DEFAULT 'ai',
        ai_model TEXT,
        prompt_template TEXT,
        input_config TEXT DEFAULT '{}',
        output_format TEXT DEFAULT 'text',
        model_config TEXT DEFAULT '{}',
        executor_config TEXT DEFAULT '{}',
        UNIQUE(parent_id, parent_type, step_order)
      )
    `);

    // Migrate data: templates → skills
    db!.exec(`
      INSERT INTO skills (id, name, description, created_by, status, created_at)
      SELECT id, name, description, created_by, 'active', created_at
      FROM recipes WHERE is_template = 1
    `);

    // Migrate data: non-templates → workflows
    db!.exec(`
      INSERT INTO workflows (id, name, description, created_by, status, created_at)
      SELECT id, name, description, created_by, 'active', created_at
      FROM recipes WHERE is_template = 0
    `);

    // Migrate recipe_steps → skill_steps
    db!.exec(`
      INSERT INTO skill_steps (id, parent_id, parent_type, step_order, step_name, step_type,
        ai_model, prompt_template, input_config, output_format, model_config, executor_config)
      SELECT rs.id, rs.recipe_id,
        CASE WHEN r.is_template = 1 THEN 'skill' ELSE 'workflow' END,
        rs.step_order, rs.step_name, rs.step_type, rs.ai_model, rs.prompt_template,
        rs.input_config, rs.output_format, rs.model_config,
        COALESCE(rs.executor_config, '{}')
      FROM recipe_steps rs
      JOIN recipes r ON rs.recipe_id = r.id
    `);
  })();

  console.log('[Migration] recipes → skills/workflows migration complete');
}

type SeedStepDefinition = {
  step_order: number;
  step_name: string;
  step_type?: string;
  ai_model: string | null;
  prompt_template: string | null;
  output_format: string;
  model_config?: string | null;
  input_config?: string | null;
  executor_config?: string | null;
};

function upsertGraphDefinition(
  parentType: 'skill' | 'workflow',
  name: string,
  description: string,
  createdBy: number,
  steps: SeedStepDefinition[]
): number {
  if (!db) throw new Error('Database not initialized');

  const parentTable = parentType === 'skill' ? 'skills' : 'workflows';
  const existing = getOne(`SELECT id FROM ${parentTable} WHERE name = ? AND created_by = ?`, [name, createdBy]);
  let parentId: number;

  if (existing) {
    parentId = existing.id;
    run(`
      UPDATE ${parentTable}
      SET description = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [description, parentId]);
    run('DELETE FROM skill_steps WHERE parent_id = ? AND parent_type = ?', [parentId, parentType]);
  } else {
    const result = run(`
      INSERT INTO ${parentTable} (name, description, created_by, status, tags)
      VALUES (?, ?, ?, 'active', '[]')
    `, [name, description, createdBy]);
    parentId = result.lastInsertRowid;
  }

  steps.forEach((step) => {
    run(`
      INSERT INTO skill_steps (
        parent_id, parent_type, step_order, step_name, step_type, ai_model, prompt_template, output_format, model_config, input_config, executor_config
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      parentId,
      parentType,
      step.step_order,
      step.step_name,
      step.step_type || 'ai',
      step.ai_model,
      step.prompt_template,
      step.output_format,
      step.model_config ?? '{}',
      step.input_config ?? '{}',
      step.executor_config ?? '{}',
    ]);
  });

  return parentId;
}

function upsertSkillDefinition(
  name: string,
  description: string,
  createdBy: number,
  steps: SeedStepDefinition[]
): number {
  return upsertGraphDefinition('skill', name, description, createdBy, steps);
}

function upsertWorkflowDefinition(
  name: string,
  description: string,
  createdBy: number,
  steps: SeedStepDefinition[]
): number {
  return upsertGraphDefinition('workflow', name, description, createdBy, steps);
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
    run(`
      UPDATE company_standards
      SET content = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [content, existing.id]);
  } else {
    run(`
      INSERT INTO company_standards (user_id, standard_type, name, content)
      VALUES (?, ?, ?, ?)
    `, [userId, standardType, name, content]);
  }
}

function seedDefaultAssets(mockUserId: number): void {
  if (!db) return;

  const imageStyleAnalysisPrompt = `Analyze this reference image in comprehensive detail for photography reproduction and AI image generation purposes.

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

Be specific and technical. Include real-world imperfections that give the image character. The analysis should enable someone to recreate this exact photographic style.`;

  // Skills
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
      step_type: 'ai',
      ai_model: 'gemini-3-pro-image-preview',
      prompt_template: imageStyleAnalysisPrompt,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.3, maxTokens: 4000 }),
      input_config: imageStyleAnalyzerInputConfig,
      executor_config: '{}',
    }
  ];

  upsertSkillDefinition(
    'Image Style Analyzer',
    'Analyze photography style, camera settings, lighting, and composition for AI image generation reference',
    mockUserId,
    imageStyleAnalyzerSteps
  );

  const modifyImagesInputConfig = JSON.stringify({
    variables: {
      reference_images: {
        type: 'image',
        placeholder: '',
        description: '',
      },
    }
  });

  const modifyImagesSteps = [
    {
      step_order: 1,
      step_name: 'Generate Product Images',
      step_type: 'ai',
      ai_model: 'gemini-3-pro-image-preview',
      prompt_template: 'Generate an image that modifies or combines this reference image {{reference_images}} based on these requirements: {{requirement}}',
      output_format: 'image',
      model_config: JSON.stringify({ numberOfImages: 1, aspectRatio: '1:1', temperature: 0.1 }),
      input_config: modifyImagesInputConfig,
      executor_config: '{}',
    }
  ];

  upsertSkillDefinition(
    'Modify Images',
    'Modify provided images using AI based on detailed requirements',
    mockUserId,
    modifyImagesSteps
  );

  // Workflows
  const generatedProductImagesStep2Prompt = `Generate a professional product photography image based on the following specifications.

Product Reference: {{product_images}}

If there are multiple product images uploaded, combine them into one single image that is aligned with the style analysis from step 1:
{{step_1_output}}

Create a high-quality, professional product image that:
1. Showcases the product clearly and attractively
2. Follows the style, lighting, and composition requirements specified in the style analysis
3. Has a clean, professional background as specified
4. Maintains accurate product details and proportions
5. Is suitable for e-commerce and marketing use

Generate the image according to the analyzed style and product reference.`;

  const generatedProductImagesSteps: SeedStepDefinition[] = [
    {
      step_order: 1,
      step_name: 'Image Style Analysis',
      step_type: 'ai',
      ai_model: 'gemini-3-pro-image-preview',
      prompt_template: imageStyleAnalysisPrompt,
      output_format: 'json',
      model_config: JSON.stringify({ temperature: 0.3, maxTokens: 4000 }),
      input_config: imageStyleAnalyzerInputConfig,
      executor_config: '{}',
    },
    {
      step_order: 2,
      step_name: 'Generate Product Images',
      step_type: 'ai',
      ai_model: 'gemini-3-pro-image-preview',
      prompt_template: generatedProductImagesStep2Prompt,
      output_format: 'image',
      model_config: JSON.stringify({ numberOfImages: 1, aspectRatio: '1:1', temperature: 0.5 }),
      input_config: JSON.stringify({
        variables: {
          product_images: {
            type: 'image',
            label: 'Product Reference Images',
            description: 'Upload one or more product images to use as reference for AI generation',
            maxImageSize: 10,
          },
        },
      }),
      executor_config: '{}',
    },
  ];

  upsertWorkflowDefinition(
    '生成产品图片',
    'AI先分析用户提供的样本图, 再按照分析结果，把用户提供的图片生成类似样本的新图片。',
    mockUserId,
    generatedProductImagesSteps
  );

  const reviewMergeScript = `import sys
import json
import csv
import io

def process():
    input_data = json.load(sys.stdin)
    files_input = input_data.get('review_files', [])

    # 兼容处理：如果是字符串（测试输入），转为列表格式
    if isinstance(files_input, str):
        files = [{'content': files_input}]
    else:
        files = files_input

    positive_reviews = []
    negative_reviews = []

    for file_info in files:
        content = file_info.get('content', '')
        if not content: continue

        f = io.StringIO(content)
        reader = csv.DictReader(f)

        for row in reader:
            # 匹配常见的列名，增加对测试数据的支持
            text = row.get('Comment') or row.get('review_body') or row.get('review_text') or row.get('content') or row.get('评论内容')
            rating_str = row.get('Rating') or row.get('star_rating') or row.get('rating') or row.get('score') or row.get('评分')

            if not text or not rating_str:
                continue

            try:
                rating = float(rating_str)
                if rating >= 5:
                    positive_reviews.append(text.strip())
                elif rating <= 3:
                    negative_reviews.append(text.strip())
            except:
                continue

    # 限制样本数量防止超出Token限制
    output = {
        "pos": positive_reviews[:50],
        "neg": negative_reviews[:50]
    }
    print(json.dumps(output))

process()`;

  const ecommerceReviewAnalysisPrompt = `你是一名资深市场分析专家。请根据以下评论数据进行深度动机分析：

### 【5星评论内容】（用于提炼购买动机）：
{{step_1_output.pos}}

### 【1-3星评论内容】（用于提炼购买顾虑与退货原因）：
{{step_1_output.neg}}

### 任务要求：
1. 从5星评论中提炼真实的【购买动机】。
2. 从1-3星评论中提炼【购买顾虑】（用户下单前后的担忧）和【退货原因】（导致最终不满的核心因素）。
3. 总结提炼用户最关注的【关注点】。
4. 每一条分析结论必须紧跟对应的【评论原文摘录】作为证据。

### 输出格式：
请严格按以下JSON数组格式输出，不要包含任何Markdown代码块标签：
[
  {"category": "购买动机", "insight": "观点描述", "excerpt": "评论原文摘录"},
  {"category": "购买顾虑", "insight": "观点描述", "excerpt": "评论原文摘录"},
  {"category": "退货原因", "insight": "观点描述", "excerpt": "评论原文摘录"}
]`;

  const reviewCsvScript = `import sys
import json
import csv
import io

def generate_csv():
    try:
        input_data = json.load(sys.stdin)
        # 获取AI输出，可能是列表也可能是字符串化的JSON
        analysis_results = input_data.get('step_2_output', [])

        if isinstance(analysis_results, str):
            analysis_results = json.loads(analysis_results)

        output = io.StringIO()
        fieldnames = ["category", "insight", "excerpt"]
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()

        if isinstance(analysis_results, list):
            for row in analysis_results:
                if isinstance(row, dict):
                    # 确保只写入定义的字段，防止KeyError
                    filtered_row = {k: row.get(k, "") for k in fieldnames}
                    writer.writerow(filtered_row)

        # 输出CSV字符串内容
        print(output.getvalue())
    except Exception as e:
        # 发生错误时输出错误信息，便于调试
        print(f"Error generating CSV: {str(e)}", file=sys.stderr)
        sys.exit(1)

generate_csv()`;

  const ecommerceReviewWorkflowSteps: SeedStepDefinition[] = [
    {
      step_order: 1,
      step_name: '合并与过滤评论数据',
      step_type: 'script',
      ai_model: null,
      prompt_template: '',
      output_format: 'file',
      model_config: '{}',
      input_config: '{}',
      executor_config: JSON.stringify({
        runtime: 'python3',
        script: reviewMergeScript,
        timeout: 30000,
      }),
    },
    {
      step_order: 2,
      step_name: 'AI 动机与原因分析',
      step_type: 'ai',
      ai_model: 'gemini-3-pro-preview',
      prompt_template: ecommerceReviewAnalysisPrompt,
      output_format: 'text',
      model_config: JSON.stringify({ temperature: 0.3 }),
      input_config: '{}',
      executor_config: JSON.stringify({
        ai_model: 'gpt-4o',
        prompt_template: ecommerceReviewAnalysisPrompt,
        output_format: 'json',
        temperature: 0.3,
      }),
    },
    {
      step_order: 3,
      step_name: '生成CSV分析报告',
      step_type: 'script',
      ai_model: null,
      prompt_template: '',
      output_format: 'file',
      model_config: '{}',
      input_config: '{}',
      executor_config: JSON.stringify({
        runtime: 'python3',
        script: reviewCsvScript,
        timeout: 10000,
      }),
    },
  ];

  upsertWorkflowDefinition(
    '电商评论动机分析',
    '上传一个或多个产品评价CSV，自动分析5星与低分评论，提炼购买动机、弃购原因及退货诱因，并生成带原文摘录的CSV报告。',
    mockUserId,
    ecommerceReviewWorkflowSteps
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
        'Focus on customer benefits, value, and outcomesover features',
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
    'Amazon Platform Requirements',
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
  createStep: (recipeId: number, stepOrder: number, stepName: string, aiModel: string | null,
    promptTemplate: string | null, inputConfig: string | null, outputFormat: string, modelConfig: string | null,
    stepType: string = 'ai', apiConfig: string | null = null, executorConfig: string | null = null) =>
    run(`INSERT INTO recipe_steps (recipe_id, step_order, step_name, ai_model, prompt_template, input_config, output_format, model_config, step_type, api_config, executor_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [recipeId, stepOrder, stepName, aiModel, promptTemplate, inputConfig, outputFormat, modelConfig, stepType, apiConfig, executorConfig]),
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
  deleteAllExecutionsByUser: (userId: number) => {
    run(
      'DELETE FROM step_executions WHERE execution_id IN (SELECT id FROM workflow_executions WHERE user_id = ?)',
      [userId]
    );
    return run('DELETE FROM workflow_executions WHERE user_id = ?', [userId]);
  },

  // Step Executions
  getStepExecutionsByExecutionId: (executionId: number) =>
    getAll('SELECT * FROM step_executions WHERE execution_id = ? ORDER BY step_order', [executionId]),
  getStepExecutionById: (id: number) => getOne('SELECT * FROM step_executions WHERE id = ?', [id]),
  createStepExecution: (executionId: number, stepId: number, stepOrder: number, inputData: string) =>
    run(`INSERT INTO step_executions (execution_id, step_id, step_order, status, input_data)
      VALUES (?, ?, ?, 'pending', ?)`, [executionId, stepId, stepOrder, inputData]),
  updateStepExecution: (status: string, outputData: string | null, aiModelUsed: string | null,
    promptUsed: string | null, id: number) => {
    console.log(`[DB] updateStepExecution: id=${id}, status=${status}, outputData=${outputData?.substring(0, 100)}`);
    return run(`UPDATE step_executions SET status = ?, output_data = ?, ai_model_used = ?, prompt_used = ?, executed_at = CURRENT_TIMESTAMP
      WHERE id = ?`, [status, outputData, aiModelUsed, promptUsed, id]);
  },
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

  // Manus Outputs
  createManusOutput: (userId: number, taskId: string, prompt: string, outputText: string, files: string | null, creditsUsed: number | null) =>
    run(`INSERT INTO manus_outputs (user_id, task_id, prompt, output_text, files, credits_used)
      VALUES (?, ?, ?, ?, ?, ?)`, [userId, taskId, prompt, outputText, files, creditsUsed]),

  getManusOutputsByUser: (userId: number) =>
    getAll('SELECT * FROM manus_outputs WHERE user_id = ? ORDER BY created_at DESC', [userId]),

  getManusOutputById: (id: number) =>
    getOne('SELECT * FROM manus_outputs WHERE id = ?', [id]),
};

export default db;
