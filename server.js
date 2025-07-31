import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { gtdDB } from './lib/gtd-database-client.js';
import { searchService } from './lib/gtd-search-service.js';
import { EvernoteProcessor } from './lib/evernote-processor.js';
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.GTD_API_PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// API Key Authentication Middleware
const apiKeyAuth = (req, res, next) => {
  // Skip auth for health and stats endpoints
  if (req.path === '/health' || req.path === '/api/stats') {
    return next();
  }
  
  if (process.env.API_KEY_REQUIRED === 'true') {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
  }
  
  next();
};

// Apply API key middleware if enabled
if (process.env.API_KEY_REQUIRED === 'true') {
  app.use(apiKeyAuth);
}

// Configure file upload
const upload = multer({ 
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  storage: multer.memoryStorage()
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'GTD Productivity System API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      search: 'POST /api/search',
      documents: '/api/documents',
      stats: '/api/stats'
    }
  });
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await gtdDB.query('SELECT NOW()');
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'unhealthy', 
      error: error.message 
    });
  }
});

// Detailed stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await gtdDB.query(`
      SELECT 
        (SELECT COUNT(*) FROM documents WHERE is_active = true) as total_documents,
        (SELECT COUNT(*) FROM documents WHERE processed_at IS NULL) as unprocessed_documents,
        (SELECT COUNT(*) FROM attachments) as total_attachments,
        (SELECT COUNT(*) FROM embedding_queue WHERE processed_at IS NULL) as pending_embeddings,
        (SELECT COUNT(*) FROM search_history WHERE created_at > NOW() - INTERVAL '24 hours') as searches_24h,
        (SELECT COUNT(DISTINCT gtd_context) FROM documents, UNNEST(gtd_contexts) as gtd_context) as unique_contexts,
        (SELECT COUNT(DISTINCT gtd_project) FROM documents WHERE gtd_project IS NOT NULL) as unique_projects
    `);
    
    res.json({
      stats: stats.rows[0],
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        node_version: process.version,
        environment: process.env.NODE_ENV || 'development'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search endpoints
app.post('/api/search', async (req, res) => {
  try {
    const { query, type = 'hybrid', filters = {} } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const results = await searchService.search(query, {
      type,
      ...filters
    });
    
    res.json({
      query,
      results,
      count: results.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/search/suggestions', async (req, res) => {
  try {
    const { q } = req.query;
    const suggestions = await searchService.getSuggestions(q || '');
    res.json(suggestions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Document endpoints
app.get('/api/documents/:id', async (req, res) => {
  try {
    const document = await gtdDB.getDocumentById(req.params.id);
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    // Get attachments
    const attachments = await gtdDB.query(
      'SELECT * FROM attachments WHERE document_id = $1',
      [req.params.id]
    );
    
    // Get related documents
    const related = await searchService.getRelatedDocuments(req.params.id);
    
    res.json({
      ...document,
      attachments: attachments.rows,
      related
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/documents', async (req, res) => {
  try {
    const document = await gtdDB.createDocument(req.body);
    
    // Queue for embedding generation
    if (document.id) {
      await gtdDB.addToEmbeddingQueue(document.id);
    }
    
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/documents/:id', async (req, res) => {
  try {
    const document = await gtdDB.updateDocument(req.params.id, req.body);
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    res.json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    await gtdDB.query(
      'UPDATE documents SET is_active = false WHERE id = $1',
      [req.params.id]
    );
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GTD context endpoints
app.get('/api/contexts', async (req, res) => {
  try {
    const result = await gtdDB.query(`
      SELECT UNNEST(gtd_contexts) as context, COUNT(*) as count
      FROM documents
      WHERE is_active = true
      GROUP BY context
      ORDER BY count DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contexts/:context/documents', async (req, res) => {
  try {
    const documents = await gtdDB.getDocumentsByContext(req.params.context);
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GTD projects and areas
app.get('/api/projects', async (req, res) => {
  try {
    const result = await gtdDB.query(`
      SELECT DISTINCT gtd_project as project, COUNT(*) as count
      FROM documents
      WHERE gtd_project IS NOT NULL
      AND is_active = true
      GROUP BY gtd_project
      ORDER BY count DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/areas', async (req, res) => {
  try {
    const result = await gtdDB.query(`
      SELECT DISTINCT gtd_area as area, COUNT(*) as count
      FROM documents
      WHERE gtd_area IS NOT NULL
      AND is_active = true
      GROUP BY gtd_area
      ORDER BY count DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Migration endpoints
app.post('/api/migrate/evernote', upload.single('enex'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ENEX file is required' });
    }
    
    const processor = new EvernoteProcessor();
    await processor.initMigration();
    
    // Process in background
    const content = req.file.buffer.toString('utf8');
    processor.processENEXContent(content).catch(error => {
      console.error('Migration error:', error);
    });
    
    res.json({
      migrationId: processor.migrationId,
      message: 'Migration started. Check /api/migrate/status/:id for progress'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/migrate/status/:id', async (req, res) => {
  try {
    const status = await gtdDB.getMigrationProgress(req.params.id);
    
    if (!status) {
      return res.status(404).json({ error: 'Migration not found' });
    }
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Embedding queue processor endpoint
app.post('/api/embeddings/process', async (req, res) => {
  try {
    const { batchSize = 10 } = req.body;
    const stats = await searchService.processEmbeddingQueue(batchSize);
    
    res.json({
      message: 'Embedding processing completed',
      ...stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Weekly review endpoint
app.get('/api/review/weekly', async (req, res) => {
  try {
    const stats = await gtdDB.query(`
      WITH weekly_stats AS (
        SELECT 
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as new_items,
          COUNT(*) FILTER (WHERE gtd_status = 'completed' AND updated_at > NOW() - INTERVAL '7 days') as completed,
          COUNT(*) FILTER (WHERE gtd_status = 'active' AND created_at < NOW() - INTERVAL '30 days') as stale,
          COUNT(*) FILTER (WHERE gtd_status = 'active') as active_total
        FROM documents
      ),
      context_breakdown AS (
        SELECT gtd_context, COUNT(*) as count
        FROM documents, UNNEST(gtd_contexts) as gtd_context
        WHERE gtd_status = 'active'
        GROUP BY gtd_context
        ORDER BY count DESC
      ),
      project_status AS (
        SELECT gtd_project, COUNT(*) as count
        FROM documents
        WHERE gtd_project IS NOT NULL
        AND gtd_status = 'active'
        GROUP BY gtd_project
        ORDER BY count DESC
        LIMIT 10
      )
      SELECT 
        ws.*,
        (SELECT json_agg(row_to_json(cb)) FROM context_breakdown cb) as contexts,
        (SELECT json_agg(row_to_json(ps)) FROM project_status ps) as projects
      FROM weekly_stats ws
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Capture endpoint for n8n webhooks
app.post('/api/capture/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const data = req.body;
    
    // Create document based on capture type
    const document = await gtdDB.createDocument({
      title: data.title || `${type} capture - ${new Date().toLocaleString()}`,
      content: data.content || data.text || JSON.stringify(data),
      gtdContexts: data.contexts || ['@inbox'],
      sourceType: type,
      metadata: data.metadata || data
    });
    
    // Queue for processing
    await gtdDB.addToEmbeddingQueue(document.id);
    
    res.json({
      success: true,
      documentId: document.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
async function startServer() {
  try {
    // Initialize database connection
    await gtdDB.connect();
    console.log('✅ Database connected');
    
    app.listen(PORT, () => {
      console.log(`🚀 GTD API Server running on port ${PORT}`);
      console.log(`📍 Health check: http://localhost:${PORT}/health`);
      console.log(`🔍 Search API: http://localhost:${PORT}/api/search`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await gtdDB.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await gtdDB.close();
  process.exit(0);
});

// Start the server
startServer();