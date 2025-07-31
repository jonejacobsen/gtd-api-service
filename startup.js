#!/usr/bin/env node
import { gtdDB } from './lib/gtd-database-client.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrationsIfNeeded() {
  console.log('🚀 GTD API Service - Startup Check\n');
  
  try {
    // Test database connection
    await gtdDB.connect();
    console.log('✅ Database connected successfully\n');
    
    // Check if tables exist
    const tablesResult = await gtdDB.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'documents'
    `);
    
    const tablesExist = parseInt(tablesResult.rows[0].count) > 0;
    
    if (!tablesExist) {
      console.log('📋 Tables not found. Running migrations...\n');
      
      // Read and execute migration
      const migrationPath = join(__dirname, 'migrations', '005_gtd_productivity_schema.sql');
      const migrationSQL = await readFile(migrationPath, 'utf8');
      
      // Split and execute statements
      const statements = migrationSQL
        .split(/;[\s]*$/m)
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));
      
      for (const statement of statements) {
        try {
          await gtdDB.query(statement);
          process.stdout.write('.');
        } catch (error) {
          if (!error.message.includes('already exists')) {
            console.error(`\n⚠️  Migration warning: ${error.message}`);
          }
        }
      }
      
      console.log('\n✅ Migrations completed!');
    } else {
      console.log('✅ Database tables already exist');
    }
    
    // Close connection pool before starting main server
    await gtdDB.close();
    
    // Start the main server
    console.log('\n🚀 Starting GTD API Server...\n');
    await import('./server.js');
    
  } catch (error) {
    console.error('❌ Startup failed:', error.message);
    console.error('\nPlease check:');
    console.error('1. PGPASSWORD environment variable is set');
    console.error('2. PostgreSQL service is running');
    console.error('3. Internal network connectivity');
    process.exit(1);
  }
}

// Run startup sequence
runMigrationsIfNeeded();