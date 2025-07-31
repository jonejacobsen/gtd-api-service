-- GTD Productivity System Schema
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Main documents table
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  source_id VARCHAR(255) UNIQUE, -- Evernote GUID or other
  title TEXT NOT NULL,
  content TEXT,
  content_vector tsvector GENERATED ALWAYS AS 
    (to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))) STORED,
  embedding vector(1536), -- OpenAI embeddings
  
  -- GTD fields
  gtd_contexts TEXT[],
  gtd_project VARCHAR(255),
  gtd_area VARCHAR(255),
  gtd_status VARCHAR(50) DEFAULT 'active',
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  source_type VARCHAR(50), -- 'evernote', 'email', 'scan', etc
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  
  -- Performance flags
  is_active BOOLEAN DEFAULT true,
  needs_embedding BOOLEAN DEFAULT true
);

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  file_type VARCHAR(100),
  file_size BIGINT,
  storage_path TEXT NOT NULL, -- 'gdrive://...', 's3://...', etc
  extracted_text TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Document links for note relationships
CREATE TABLE IF NOT EXISTS document_links (
  id SERIAL PRIMARY KEY,
  source_document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  link_type VARCHAR(50) DEFAULT 'reference',
  link_text TEXT,
  link_context TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(source_document_id, target_document_id)
);

-- Search history for analytics
CREATE TABLE IF NOT EXISTS search_history (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  filters JSONB DEFAULT '{}',
  result_count INTEGER,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Migration progress tracking
CREATE TABLE IF NOT EXISTS migration_progress (
  id SERIAL PRIMARY KEY,
  migration_id VARCHAR(255) UNIQUE,
  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,
  failed_files INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  error_log JSONB DEFAULT '[]',
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  last_processed TIMESTAMP
);

-- System metadata
CREATE TABLE IF NOT EXISTS system_metadata (
  key VARCHAR(255) PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Embedding processing queue
CREATE TABLE IF NOT EXISTS embedding_queue (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 5,
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_documents_fts ON documents USING GIN(content_vector);
CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_documents_contexts ON documents USING GIN(gtd_contexts);
CREATE INDEX IF NOT EXISTS idx_documents_active_date ON documents(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_needs_embedding ON documents(needs_embedding) WHERE needs_embedding = true;
CREATE INDEX IF NOT EXISTS idx_attachments_document ON attachments(document_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON document_links(source_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON document_links(target_document_id);

-- Full-text search function
CREATE OR REPLACE FUNCTION search_documents(
  search_query TEXT,
  context_filter TEXT[] DEFAULT NULL,
  area_filter TEXT DEFAULT NULL,
  limit_count INT DEFAULT 50
) RETURNS TABLE (
  id INT,
  title TEXT,
  snippet TEXT,
  rank REAL,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  WITH search_terms AS (
    SELECT websearch_to_tsquery('english', search_query) as query
  )
  SELECT 
    d.id,
    d.title,
    ts_headline('english', d.content, st.query, 
      'MaxWords=30, MinWords=15, ShortWord=3') as snippet,
    ts_rank(d.content_vector, st.query) as rank,
    d.metadata
  FROM documents d, search_terms st
  WHERE 
    d.content_vector @@ st.query
    AND d.is_active = true
    AND (context_filter IS NULL OR d.gtd_contexts && context_filter)
    AND (area_filter IS NULL OR d.gtd_area = area_filter)
  ORDER BY rank DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Hybrid search function (vector + text)
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text TEXT,
  query_embedding vector(1536),
  context_filter TEXT[] DEFAULT NULL,
  weight_vector FLOAT DEFAULT 0.6,
  limit_count INT DEFAULT 50
) RETURNS TABLE (
  id INT,
  title TEXT,
  snippet TEXT,
  combined_score REAL,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  WITH vector_search AS (
    SELECT 
      d.id,
      1 - (d.embedding <=> query_embedding) as vector_score
    FROM documents d
    WHERE 
      d.embedding IS NOT NULL
      AND d.is_active = true
      AND (context_filter IS NULL OR d.gtd_contexts && context_filter)
    ORDER BY d.embedding <=> query_embedding
    LIMIT limit_count * 2
  ),
  text_search AS (
    SELECT 
      d.id,
      ts_rank(d.content_vector, websearch_to_tsquery('english', query_text)) as text_score
    FROM documents d
    WHERE 
      d.content_vector @@ websearch_to_tsquery('english', query_text)
      AND d.is_active = true
      AND (context_filter IS NULL OR d.gtd_contexts && context_filter)
    LIMIT limit_count * 2
  ),
  combined AS (
    SELECT 
      COALESCE(v.id, t.id) as id,
      COALESCE(v.vector_score, 0) * weight_vector + 
      COALESCE(t.text_score, 0) * (1 - weight_vector) as score
    FROM vector_search v
    FULL OUTER JOIN text_search t ON v.id = t.id
  )
  SELECT 
    d.id,
    d.title,
    ts_headline('english', d.content, websearch_to_tsquery('english', query_text), 
      'MaxWords=30, MinWords=15, ShortWord=3') as snippet,
    c.score as combined_score,
    d.metadata
  FROM combined c
  JOIN documents d ON c.id = d.id
  ORDER BY c.score DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Helper function to find broken links
CREATE OR REPLACE FUNCTION find_broken_links()
RETURNS TABLE (
  link_id INT,
  source_id INT,
  target_id INT,
  link_text TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    dl.id,
    dl.source_document_id,
    dl.target_document_id,
    dl.link_text
  FROM document_links dl
  LEFT JOIN documents ds ON dl.source_document_id = ds.id
  LEFT JOIN documents dt ON dl.target_document_id = dt.id
  WHERE ds.id IS NULL OR dt.id IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_documents_updated_at BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_system_metadata_updated_at BEFORE UPDATE ON system_metadata
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert initial configuration
INSERT INTO system_metadata (key, value) VALUES 
  ('migration_status', '"pending"'),
  ('evernote_last_sync', 'null'),
  ('default_contexts', '["@computer", "@phone", "@office", "@home", "@errands"]'),
  ('gtd_version', '"1.0.0"')
ON CONFLICT (key) DO NOTHING;