#!/usr/bin/env node
import { gtdDB } from './lib/gtd-database-client.js';

async function testSetup() {
  console.log('🧪 Testing GTD API Service Setup...\n');
  
  try {
    // Test database connection
    console.log('Testing database connection...');
    await gtdDB.connect();
    const result = await gtdDB.query('SELECT version()');
    console.log('✅ Database connected:', result.rows[0].version);
    
    // Check if tables exist
    console.log('\nChecking tables...');
    const tables = await gtdDB.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('documents', 'attachments', 'document_links', 'search_history')
      ORDER BY table_name
    `);
    
    if (tables.rows.length === 0) {
      console.log('⚠️  No tables found. Run migrations first:');
      console.log('   npm run migrate');
    } else {
      console.log('✅ Found tables:');
      tables.rows.forEach(row => console.log(`   - ${row.table_name}`));
    }
    
    // Check pgvector
    console.log('\nChecking pgvector extension...');
    const pgvector = await gtdDB.query(`
      SELECT * FROM pg_extension WHERE extname = 'vector'
    `);
    
    if (pgvector.rows.length > 0) {
      console.log('✅ pgvector is installed - vector search enabled');
    } else {
      console.log('⚠️  pgvector not found - vector search will be disabled');
    }
    
    console.log('\n✅ Setup test completed successfully!');
    
  } catch (error) {
    console.error('❌ Setup test failed:', error.message);
    process.exit(1);
  } finally {
    await gtdDB.close();
  }
}

testSetup();