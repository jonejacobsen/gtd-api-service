#!/usr/bin/env node
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gtdDB } from '../lib/gtd-database-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  console.log('🚀 Starting GTD database migrations...');
  
  try {
    // Connect to database
    await gtdDB.connect();
    console.log('✅ Connected to database');

    // Read migration file
    const migrationPath = join(__dirname, '..', 'migrations', '005_gtd_productivity_schema.sql');
    const migrationSQL = await readFile(migrationPath, 'utf8');
    console.log('📄 Loaded migration file');

    // Check if pgvector extension is available
    try {
      await gtdDB.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log('✅ pgvector extension is available');
    } catch (error) {
      console.error('⚠️  pgvector extension not available. Vector search will be disabled.');
      console.error('   To enable vector search, install pgvector on your PostgreSQL instance.');
    }

    // Run migration in transaction
    await gtdDB.transaction(async (client) => {
      // Split migration into statements (simple split, might need refinement for complex SQL)
      const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      for (const statement of statements) {
        try {
          await client.query(statement + ';');
          console.log('✓ Executed:', statement.substring(0, 50) + '...');
        } catch (error) {
          if (error.message.includes('already exists')) {
            console.log('⏭️  Skipping (already exists):', statement.substring(0, 50) + '...');
          } else if (error.message.includes('vector') && error.message.includes('type')) {
            console.log('⚠️  Skipping vector-related statement (pgvector not installed)');
          } else {
            throw error;
          }
        }
      }
    });

    console.log('✅ Migration completed successfully!');

    // Verify tables exist
    const tables = await gtdDB.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('documents', 'attachments', 'document_links', 'search_history', 'migration_progress', 'system_metadata', 'embedding_queue')
      ORDER BY table_name
    `);

    console.log('\n📊 Created tables:');
    tables.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });

    // Check system metadata
    const metadata = await gtdDB.query('SELECT key, value FROM system_metadata ORDER BY key');
    console.log('\n⚙️  System metadata:');
    metadata.rows.forEach(row => {
      console.log(`   - ${row.key}: ${JSON.stringify(row.value)}`);
    });

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await gtdDB.close();
  }
}

// Run migrations
runMigrations();