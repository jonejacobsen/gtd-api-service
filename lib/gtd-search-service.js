import OpenAI from 'openai';
import { gtdDB } from './gtd-database-client.js';

export class GTDSearchService {
  constructor() {
    this.openai = null;
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
  }

  async search(query, options = {}) {
    const {
      type = 'hybrid', // 'text', 'vector', 'hybrid'
      contexts = null,
      area = null,
      project = null,
      limit = 50,
      vectorWeight = 0.6
    } = options;

    let results = [];
    
    switch (type) {
      case 'text':
        results = await this.textSearch(query, { contexts, area, limit });
        break;
      
      case 'vector':
        if (!this.openai) {
          throw new Error('Vector search requires OPENAI_API_KEY');
        }
        results = await this.vectorSearch(query, { contexts, area, limit });
        break;
      
      case 'hybrid':
        if (!this.openai) {
          // Fall back to text search if no OpenAI key
          results = await this.textSearch(query, { contexts, area, limit });
        } else {
          results = await this.hybridSearch(query, { contexts, area, limit, vectorWeight });
        }
        break;
      
      default:
        throw new Error(`Unknown search type: ${type}`);
    }

    // Record search for analytics
    await gtdDB.recordSearch(query, options, results.length);

    // Enhance results with additional data
    return this.enhanceResults(results, query);
  }

  async textSearch(query, options) {
    const { contexts, area, limit } = options;
    
    return gtdDB.searchDocuments(query, {
      contexts,
      area,
      limit
    });
  }

  async vectorSearch(query, options) {
    const { contexts, area, limit } = options;
    
    // Generate embedding
    const embedding = await this.generateEmbedding(query);
    
    // Search by embedding similarity
    const results = await gtdDB.query(`
      SELECT 
        id,
        title,
        substring(content, 1, 200) as snippet,
        1 - (embedding <=> $1::vector) as score,
        metadata
      FROM documents
      WHERE 
        embedding IS NOT NULL
        AND is_active = true
        ${contexts ? 'AND gtd_contexts && $2' : ''}
        ${area ? 'AND gtd_area = $3' : ''}
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `, [
      embedding,
      ...(contexts ? [contexts] : []),
      ...(area ? [area] : []),
      limit
    ]);
    
    return results.rows;
  }

  async hybridSearch(query, options) {
    const { contexts, area, limit, vectorWeight } = options;
    
    // Generate embedding
    const embedding = await this.generateEmbedding(query);
    
    // Use hybrid search function
    return gtdDB.hybridSearch(query, embedding, {
      contexts,
      vectorWeight,
      limit
    });
  }

  async generateEmbedding(text) {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }
    
    const response = await this.openai.embeddings.create({
      input: text,
      model: 'text-embedding-3-small'
    });
    
    return response.data[0].embedding;
  }

  async enhanceResults(results, query) {
    return Promise.all(results.map(async (result) => {
      // Get attachments count
      const attachments = await gtdDB.query(
        'SELECT COUNT(*) as count FROM attachments WHERE document_id = $1',
        [result.id]
      );
      
      // Get related documents count
      const links = await gtdDB.query(
        'SELECT COUNT(*) as count FROM document_links WHERE source_document_id = $1 OR target_document_id = $1',
        [result.id]
      );
      
      return {
        ...result,
        attachments_count: parseInt(attachments.rows[0].count),
        links_count: parseInt(links.rows[0].count),
        relevance_score: result.rank || result.combined_score || result.score || 0,
        highlight: this.highlightQuery(result.snippet || result.content || '', query)
      };
    }));
  }

  highlightQuery(text, query) {
    if (!text || !query) return text;
    
    // Simple highlighting - in production use more sophisticated approach
    const terms = query.split(/\s+/).filter(t => t.length > 2);
    let highlighted = text;
    
    terms.forEach(term => {
      const regex = new RegExp(`(${term})`, 'gi');
      highlighted = highlighted.replace(regex, '<mark>$1</mark>');
    });
    
    return highlighted;
  }

  async getSuggestions(query) {
    // Get search suggestions based on past searches and document content
    const suggestions = await gtdDB.query(`
      WITH recent_searches AS (
        SELECT DISTINCT query 
        FROM search_history 
        WHERE query ILIKE $1 || '%'
        AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
        LIMIT 5
      ),
      document_titles AS (
        SELECT DISTINCT title
        FROM documents
        WHERE title ILIKE '%' || $1 || '%'
        AND is_active = true
        LIMIT 5
      ),
      common_contexts AS (
        SELECT UNNEST(gtd_contexts) as context, COUNT(*) as count
        FROM documents
        WHERE is_active = true
        GROUP BY context
        ORDER BY count DESC
        LIMIT 10
      )
      SELECT 
        'search' as type, query as value FROM recent_searches
      UNION ALL
        SELECT 'title' as type, title as value FROM document_titles
      UNION ALL
        SELECT 'context' as type, context as value FROM common_contexts
      WHERE context ILIKE '%' || $1 || '%'
    `, [query]);
    
    return suggestions.rows;
  }

  async getRelatedDocuments(documentId, limit = 5) {
    // Get related documents based on various factors
    const doc = await gtdDB.getDocumentById(documentId);
    if (!doc) return [];
    
    // Find documents with similar contexts or projects
    const related = await gtdDB.query(`
      WITH similar_contexts AS (
        SELECT 
          d.id,
          d.title,
          array_length(d.gtd_contexts & $2::text[], 1) as common_contexts
        FROM documents d
        WHERE 
          d.id != $1
          AND d.is_active = true
          AND d.gtd_contexts && $2::text[]
      ),
      same_project AS (
        SELECT 
          d.id,
          d.title,
          2 as score
        FROM documents d
        WHERE 
          d.id != $1
          AND d.is_active = true
          AND d.gtd_project = $3
          AND $3 IS NOT NULL
      ),
      linked_docs AS (
        SELECT 
          CASE 
            WHEN dl.source_document_id = $1 THEN dl.target_document_id
            ELSE dl.source_document_id
          END as id,
          d.title,
          3 as score
        FROM document_links dl
        JOIN documents d ON d.id = CASE 
          WHEN dl.source_document_id = $1 THEN dl.target_document_id
          ELSE dl.source_document_id
        END
        WHERE (dl.source_document_id = $1 OR dl.target_document_id = $1)
        AND d.is_active = true
      )
      SELECT DISTINCT ON (id)
        id,
        title,
        MAX(COALESCE(common_contexts, 0) + COALESCE(score, 0)) as relevance
      FROM (
        SELECT * FROM similar_contexts
        UNION ALL
        SELECT * FROM same_project
        UNION ALL
        SELECT * FROM linked_docs
      ) combined
      GROUP BY id, title
      ORDER BY id, relevance DESC
      LIMIT $4
    `, [documentId, doc.gtd_contexts || [], doc.gtd_project, limit]);
    
    return related.rows;
  }

  async processEmbeddingQueue(batchSize = 10) {
    if (!this.openai) {
      console.log('⚠️  Embedding processing skipped - no OpenAI API key');
      return { processed: 0, failed: 0 };
    }
    
    const items = await gtdDB.getEmbeddingQueueItems(batchSize);
    const stats = { processed: 0, failed: 0 };
    
    for (const item of items) {
      try {
        // Generate embedding for title + content
        const text = `${item.title}\n\n${item.content || ''}`.slice(0, 8000);
        const embedding = await this.generateEmbedding(text);
        
        // Update document with embedding
        await gtdDB.updateEmbedding(item.document_id, embedding);
        
        // Mark as processed in queue
        await gtdDB.query(
          'UPDATE embedding_queue SET processed_at = NOW() WHERE id = $1',
          [item.id]
        );
        
        stats.processed++;
        console.log(`✓ Generated embedding for: ${item.title}`);
      } catch (error) {
        console.error(`❌ Failed to generate embedding for ${item.title}:`, error.message);
        
        // Update error in queue
        await gtdDB.query(
          'UPDATE embedding_queue SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
          [item.id, error.message]
        );
        
        stats.failed++;
      }
    }
    
    return stats;
  }
}

export const searchService = new GTDSearchService();
export default GTDSearchService;