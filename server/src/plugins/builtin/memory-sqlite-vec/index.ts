/**
 * memory-sqlite-vec — Vector search + keyword search for skills and session memory.
 *
 * Uses sqlite-vec for vector similarity search and BM25 keyword search.
 * Falls back to keyword-only search if sqlite-vec is not available or no embedding provider is configured.
 */
import Database from 'better-sqlite3';
import path from 'path';
import {
  MemoryPlugin, PluginManifest, SkillIndexEntry, SearchResult, SearchOptions, MemoryEntry,
} from '../../types';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../../../data/novohaven.db');

class SqliteVecMemoryPlugin implements MemoryPlugin {
  manifest: PluginManifest;
  private db: Database.Database | null = null;
  private vecAvailable = false;
  private embeddingProvider: string = 'provider-openai';
  private dimensions: number = 1536;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.embeddingProvider = config.embeddingProvider || 'provider-openai';
    this.dimensions = config.embeddingDimensions || 1536;

    this.db = new Database(DB_PATH, { readonly: false });
    this.db.pragma('journal_mode = WAL');

    // Create keyword search tables (always available)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id INTEGER NOT NULL,
        skill_type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        step_summary TEXT,
        tags TEXT DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Try to load sqlite-vec extension
    try {
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(this.db);
      this.vecAvailable = true;

      // Create vector tables
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS skill_embeddings USING vec0(
          skill_index_id INTEGER PRIMARY KEY,
          embedding float[${this.dimensions}]
        )
      `);

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
          memory_id INTEGER PRIMARY KEY,
          embedding float[${this.dimensions}]
        )
      `);

      console.log('[memory-sqlite-vec] sqlite-vec loaded, vector search enabled');
    } catch (err: any) {
      console.warn('[memory-sqlite-vec] sqlite-vec not available, falling back to keyword search:', err.message);
    }

    // Index existing skills on first load
    await this.indexExistingSkills();
  }

  async shutdown(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  /**
   * Index a skill/workflow for search.
   */
  async index(item: SkillIndexEntry): Promise<void> {
    if (!this.db) return;

    // Upsert into skill_index
    const existing = this.db.prepare(
      'SELECT id FROM skill_index WHERE skill_id = ? AND skill_type = ?'
    ).get(item.skillId, item.skillType) as any;

    let indexId: number;
    if (existing) {
      this.db.prepare(`
        UPDATE skill_index SET name = ?, description = ?, step_summary = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(item.name, item.description, item.stepSummary, JSON.stringify(item.tags), existing.id);
      indexId = existing.id;
    } else {
      const result = this.db.prepare(`
        INSERT INTO skill_index (skill_id, skill_type, name, description, step_summary, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(item.skillId, item.skillType, item.name, item.description, item.stepSummary, JSON.stringify(item.tags));
      indexId = Number(result.lastInsertRowid);
    }

    // Vector embedding (if available)
    if (this.vecAvailable) {
      try {
        const embedding = await this.getEmbedding(
          `${item.name} ${item.description} ${item.stepSummary} ${item.tags.join(' ')}`
        );
        if (embedding) {
          this.db.prepare(
            'INSERT OR REPLACE INTO skill_embeddings (skill_index_id, embedding) VALUES (?, ?)'
          ).run(indexId, Buffer.from(new Float32Array(embedding).buffer));
        }
      } catch (err: any) {
        console.warn(`[memory-sqlite-vec] Failed to embed skill ${item.skillId}:`, err.message);
      }
    }
  }

  /**
   * Search for skills/workflows.
   * Combines vector similarity (if available) with keyword matching.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.db) return [];

    const limit = options?.limit || 5;
    const typeFilter = options?.skillType;

    // Keyword search (always available)
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let keywordResults: any[] = [];

    if (words.length > 0) {
      const likeClause = words.map(() => '(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(step_summary) LIKE ?)').join(' OR ');
      const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);

      let sql = `SELECT skill_id, skill_type, name, description FROM skill_index WHERE (${likeClause})`;
      if (typeFilter) {
        sql += ` AND skill_type = ?`;
        params.push(typeFilter);
      }
      sql += ` LIMIT ${limit * 2}`;

      keywordResults = this.db.prepare(sql).all(...params) as any[];
    }

    // Vector search (if available)
    let vecResults: any[] = [];
    if (this.vecAvailable && words.length > 0) {
      try {
        const embedding = await this.getEmbedding(query);
        if (embedding) {
          const embBuf = Buffer.from(new Float32Array(embedding).buffer);
          vecResults = this.db.prepare(`
            SELECT si.skill_id, si.skill_type, si.name, si.description,
                   se.distance as vec_distance
            FROM skill_embeddings se
            JOIN skill_index si ON si.id = se.skill_index_id
            WHERE se.embedding MATCH ?
            ORDER BY se.distance
            LIMIT ?
          `).all(embBuf, limit) as any[];
        }
      } catch {
        // Fall through to keyword-only
      }
    }

    // Merge and deduplicate results
    const seen = new Set<string>();
    const results: SearchResult[] = [];

    // Vector results get higher priority
    for (const r of vecResults) {
      const key = `${r.skill_type}:${r.skill_id}`;
      if (seen.has(key)) continue;
      if (typeFilter && r.skill_type !== typeFilter) continue;
      seen.add(key);
      results.push({
        skillId: r.skill_id,
        skillType: r.skill_type,
        name: r.name,
        description: r.description || '',
        score: 1.0 - (r.vec_distance || 0), // Convert distance to similarity
      });
    }

    // Add keyword results
    for (const r of keywordResults) {
      const key = `${r.skill_type}:${r.skill_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Score keyword results based on how many words match
      const nameAndDesc = `${r.name} ${r.description}`.toLowerCase();
      const matchCount = words.filter(w => nameAndDesc.includes(w)).length;
      results.push({
        skillId: r.skill_id,
        skillType: r.skill_type,
        name: r.name,
        description: r.description || '',
        score: matchCount / words.length * 0.5, // Max 0.5 for keyword-only
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).filter(r => !options?.minScore || r.score >= options.minScore);
  }

  /**
   * Store a memory entry for a session.
   */
  async storeMemory(sessionId: string, content: string, embedding?: number[]): Promise<void> {
    if (!this.db) return;

    const result = this.db.prepare(
      'INSERT INTO session_memory (session_id, content) VALUES (?, ?)'
    ).run(sessionId, content);

    if (this.vecAvailable) {
      const emb = embedding || await this.getEmbedding(content);
      if (emb) {
        this.db.prepare(
          'INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)'
        ).run(Number(result.lastInsertRowid), Buffer.from(new Float32Array(emb).buffer));
      }
    }
  }

  /**
   * Search session memory.
   */
  async searchMemory(sessionId: string, query: string, limit: number = 5): Promise<MemoryEntry[]> {
    if (!this.db) return [];

    // Keyword search
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) {
      // Return most recent
      return this.db.prepare(
        'SELECT id, content, created_at as createdAt FROM session_memory WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(sessionId, limit).map((r: any) => ({ ...r, score: 1.0 })) as MemoryEntry[];
    }

    const likeClause = words.map(() => 'LOWER(content) LIKE ?').join(' OR ');
    const params = words.map(w => `%${w}%`);

    const results = this.db.prepare(`
      SELECT id, content, created_at as createdAt FROM session_memory
      WHERE session_id = ? AND (${likeClause})
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, ...params, limit) as any[];

    return results.map((r: any) => ({
      id: r.id,
      content: r.content,
      score: 0.5,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Get embedding from the configured provider.
   */
  private async getEmbedding(text: string): Promise<number[] | null> {
    try {
      // Try to load the provider plugin dynamically
      const providerDir = path.join(__dirname, '..', this.embeddingProvider);
      const manifest = require(path.join(providerDir, 'manifest.json'));
      const PluginClass = require(path.join(providerDir, 'index.ts')).default;
      const provider = new PluginClass(manifest);
      await provider.initialize({});

      if (provider.embed) {
        const embeddings = await provider.embed([text]);
        await provider.shutdown();
        return embeddings[0] || null;
      }
      await provider.shutdown();
    } catch {
      // Provider not available
    }
    return null;
  }

  /**
   * Index all existing skills/workflows on first load.
   */
  private async indexExistingSkills(): Promise<void> {
    if (!this.db) return;

    const existingCount = (this.db.prepare('SELECT COUNT(*) as count FROM skill_index').get() as any).count;
    if (existingCount > 0) return; // Already indexed

    console.log('[memory-sqlite-vec] Indexing existing skills and workflows...');

    // Index skills
    const skills = this.db.prepare("SELECT id, name, description FROM skills WHERE status = 'active'").all() as any[];
    for (const skill of skills) {
      const steps = this.db.prepare(
        "SELECT step_name, step_type FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order"
      ).all(skill.id) as any[];

      await this.index({
        skillId: skill.id,
        skillType: 'skill',
        name: skill.name,
        description: skill.description || '',
        stepSummary: steps.map((s: any) => `${s.step_name} (${s.step_type})`).join(' → '),
        tags: [],
      });
    }

    // Index workflows
    const workflows = this.db.prepare("SELECT id, name, description FROM workflows WHERE status = 'active'").all() as any[];
    for (const wf of workflows) {
      const steps = this.db.prepare(
        "SELECT step_name, step_type FROM skill_steps WHERE parent_id = ? AND parent_type = 'workflow' ORDER BY step_order"
      ).all(wf.id) as any[];

      await this.index({
        skillId: wf.id,
        skillType: 'workflow',
        name: wf.name,
        description: wf.description || '',
        stepSummary: steps.map((s: any) => `${s.step_name} (${s.step_type})`).join(' → '),
        tags: [],
      });
    }

    console.log(`[memory-sqlite-vec] Indexed ${skills.length} skills and ${workflows.length} workflows`);
  }
}

export default SqliteVecMemoryPlugin;
