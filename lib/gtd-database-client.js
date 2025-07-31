import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

class GTDDatabaseClient {
  constructor() {
    this.pool = null;
  }

  async connect() {
    if (this.pool) return this.pool;

    // Use Railway PostgreSQL URL or construct from components
    let connectionString = process.env.RAILWAY_POSTGRESQL_URL || 
                          process.env.DATABASE_URL ||
                          process.env.PRODUCTIVITY_DB_URL;

    // If no connection string but we have components, build it
    if (!connectionString && process.env.PGPASSWORD) {
      const host = process.env.POSTGRES_HOST || 'postgres.railway.internal';
      const port = process.env.POSTGRES_PORT || '5432';
      const database = process.env.POSTGRES_DATABASE || 'railway';
      const user = process.env.POSTGRES_USER || 'postgres';
      const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
      
      connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}`;
      console.log(`✅ Built connection string using Railway internal network: ${host}`);
    }

    if (!connectionString) {
      throw new Error('No database connection found. Please set DATABASE_URL or PGPASSWORD environment variable');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test connection
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ Database connection established');
      return this.pool;
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
  }

  async query(text, params) {
    const pool = await this.connect();
    return pool.query(text, params);
  }

  async getClient() {
    const pool = await this.connect();
    return pool.connect();
  }

  async transaction(callback) {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // GTD-specific helper methods
  async searchDocuments(query, filters = {}) {
    const { contexts, area, limit = 50 } = filters;
    
    const result = await this.query(
      'SELECT * FROM search_documents($1, $2, $3, $4)',
      [query, contexts, area, limit]
    );
    
    return result.rows;
  }

  async hybridSearch(query, embedding, filters = {}) {
    const { contexts, vectorWeight = 0.6, limit = 50 } = filters;
    
    const result = await this.query(
      'SELECT * FROM hybrid_search($1, $2, $3, $4, $5)',
      [query, embedding, contexts, vectorWeight, limit]
    );
    
    return result.rows;
  }

  async createDocument(doc) {
    const {
      title,
      content,
      gtdContexts = [],
      gtdProject,
      gtdArea,
      sourceType = 'manual',
      metadata = {}
    } = doc;

    const result = await this.query(`
      INSERT INTO documents 
      (title, content, gtd_contexts, gtd_project, gtd_area, source_type, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [title, content, gtdContexts, gtdProject, gtdArea, sourceType, metadata]);

    return result.rows[0];
  }

  async updateDocument(id, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        fields.push(`${this.camelToSnake(key)} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    });

    if (fields.length === 0) return null;

    values.push(id);
    const query = `
      UPDATE documents 
      SET ${fields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await this.query(query, values);
    return result.rows[0];
  }

  async addAttachment(documentId, attachment) {
    const {
      filename,
      fileType,
      fileSize,
      storagePath,
      extractedText,
      metadata = {}
    } = attachment;

    const result = await this.query(`
      INSERT INTO attachments 
      (document_id, filename, file_type, file_size, storage_path, extracted_text, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [documentId, filename, fileType, fileSize, storagePath, extractedText, metadata]);

    return result.rows[0];
  }

  async getDocumentById(id) {
    const result = await this.query(
      'SELECT * FROM documents WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  async getDocumentsByContext(context) {
    const result = await this.query(
      'SELECT * FROM documents WHERE $1 = ANY(gtd_contexts) AND is_active = true ORDER BY created_at DESC',
      [context]
    );
    return result.rows;
  }

  async getUnprocessedDocuments(limit = 10) {
    const result = await this.query(
      'SELECT * FROM documents WHERE processed_at IS NULL LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async markDocumentProcessed(id) {
    const result = await this.query(
      'UPDATE documents SET processed_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async addToEmbeddingQueue(documentId, priority = 5) {
    const result = await this.query(
      'INSERT INTO embedding_queue (document_id, priority) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *',
      [documentId, priority]
    );
    return result.rows[0];
  }

  async getEmbeddingQueueItems(limit = 10) {
    const result = await this.query(`
      SELECT eq.*, d.title, d.content 
      FROM embedding_queue eq
      JOIN documents d ON eq.document_id = d.id
      WHERE eq.processed_at IS NULL
      ORDER BY eq.priority DESC, eq.created_at ASC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async updateEmbedding(documentId, embedding) {
    const result = await this.query(
      'UPDATE documents SET embedding = $2, needs_embedding = false WHERE id = $1 RETURNING *',
      [documentId, embedding]
    );
    return result.rows[0];
  }

  async recordSearch(query, filters, resultCount) {
    await this.query(
      'INSERT INTO search_history (query, filters, result_count) VALUES ($1, $2, $3)',
      [query, filters, resultCount]
    );
  }

  async getMigrationProgress(migrationId) {
    const result = await this.query(
      'SELECT * FROM migration_progress WHERE migration_id = $1',
      [migrationId]
    );
    return result.rows[0];
  }

  async updateMigrationProgress(migrationId, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        fields.push(`${this.camelToSnake(key)} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    });

    values.push(migrationId);
    const query = `
      UPDATE migration_progress 
      SET ${fields.join(', ')}, last_processed = NOW()
      WHERE migration_id = $${paramCount}
      RETURNING *
    `;

    const result = await this.query(query, values);
    return result.rows[0];
  }

  async getSystemMetadata(key) {
    const result = await this.query(
      'SELECT value FROM system_metadata WHERE key = $1',
      [key]
    );
    return result.rows[0]?.value;
  }

  async setSystemMetadata(key, value) {
    await this.query(
      'INSERT INTO system_metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    );
  }

  // Helper method to convert camelCase to snake_case
  camelToSnake(str) {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }
}

// Export singleton instance
export const gtdDB = new GTDDatabaseClient();
export default GTDDatabaseClient;