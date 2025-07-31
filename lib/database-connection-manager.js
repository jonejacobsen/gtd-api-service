/**
 * Database Connection Manager for Railway PostgreSQL
 * 
 * Provides connection pooling, schema isolation, and monitoring
 * for the enterprise AI database service
 */

import pg from 'pg';
import { auditLogger } from './security-audit-logger.js';

const { Pool } = pg;

export class DatabaseConnectionManager {
  constructor() {
    this.pools = new Map();
    this.isRailway = !!process.env.RAILWAY_ENVIRONMENT;
    
    // Railway internal network configuration
    this.config = {
      host: this.isRailway ? 'enterprise-ai-database-service.railway.internal' : 'localhost',
      port: 5432,
      database: process.env.POSTGRES_DB || 'enterprise_ai_automation',
      user: process.env.POSTGRES_USER || 'enterprise_ai_user',
      password: process.env.POSTGRES_PASSWORD,
      ssl: this.isRailway ? { rejectUnauthorized: false } : false,
      max: 20, // Connection pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      statement_timeout: 30000, // 30 seconds
      query_timeout: 30000,
      application_name: 'enterprise-ai-app'
    };
  }

  /**
   * Get connection pool for a specific schema
   */
  getPool(schema = 'conversations_service') {
    if (!this.pools.has(schema)) {
      const pool = new Pool({
        ...this.config,
        application_name: `${this.config.application_name}_${schema}`,
        options: `-c search_path=${schema},public`
      });
      
      // Connection event logging
      pool.on('connect', (client) => {
        auditLogger.logSecurityEvent('DATABASE_CONNECTION_CREATED', {
          schema,
          pool_size: pool.totalCount,
          client_id: client.processID
        });
      });
      
      pool.on('error', (err, client) => {
        auditLogger.logSecurityEvent('DATABASE_CONNECTION_ERROR', {
          schema,
          error: err.message,
          client_id: client?.processID
        }, 'ERROR');
      });
      
      pool.on('remove', (client) => {
        auditLogger.logSecurityEvent('DATABASE_CONNECTION_REMOVED', {
          schema,
          client_id: client.processID,
          pool_size: pool.totalCount
        }, 'DEBUG');
      });
      
      this.pools.set(schema, pool);
    }
    
    return this.pools.get(schema);
  }

  /**
   * Execute query with automatic connection management
   */
  async query(text, params = [], options = {}) {
    const { schema = 'conversations_service', userId = null } = options;
    const pool = this.getPool(schema);
    const client = await pool.connect();
    
    try {
      // Set user context for RLS if provided
      if (userId) {
        await client.query('SET LOCAL app.current_user_id = $1', [userId]);
      }
      
      const start = Date.now();
      const result = await client.query(text, params);
      const duration = Date.now() - start;
      
      // Log slow queries
      if (duration > 1000) {
        await auditLogger.logSecurityEvent('SLOW_QUERY_DETECTED', {
          schema,
          duration,
          query: text.substring(0, 100) + '...',
          params_count: params.length
        }, 'WARNING');
      }
      
      return result;
    } catch (error) {
      await auditLogger.logSecurityEvent('DATABASE_QUERY_ERROR', {
        schema,
        error: error.message,
        query: text.substring(0, 100) + '...'
      }, 'ERROR');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Transaction support with automatic rollback
   */
  async transaction(callback, options = {}) {
    const { schema = 'conversations_service', userId = null } = options;
    const pool = this.getPool(schema);
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Set user context for RLS if provided
      if (userId) {
        await client.query('SET LOCAL app.current_user_id = $1', [userId]);
      }
      
      const result = await callback(client);
      await client.query('COMMIT');
      
      await auditLogger.logSecurityEvent('DATABASE_TRANSACTION_COMPLETED', {
        schema,
        user_id: userId
      });
      
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      
      await auditLogger.logSecurityEvent('DATABASE_TRANSACTION_FAILED', {
        schema,
        user_id: userId,
        error: error.message
      }, 'ERROR');
      
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Batch insert with optimal performance
   */
  async batchInsert(table, columns, values, options = {}) {
    const { schema = 'conversations_service', onConflict = null } = options;
    
    if (!values || values.length === 0) {
      return { rowCount: 0 };
    }
    
    // Build parameterized query
    const valueStrings = [];
    const queryParams = [];
    let paramIndex = 1;
    
    for (const row of values) {
      const rowParams = [];
      for (const col of columns) {
        queryParams.push(row[col]);
        rowParams.push(`$${paramIndex++}`);
      }
      valueStrings.push(`(${rowParams.join(', ')})`);
    }
    
    let query = `
      INSERT INTO ${schema}.${table} (${columns.join(', ')})
      VALUES ${valueStrings.join(', ')}
    `;
    
    if (onConflict) {
      query += ` ${onConflict}`;
    }
    
    query += ' RETURNING *';
    
    return this.query(query, queryParams, { schema });
  }

  /**
   * Health check for database connectivity
   */
  async healthCheck() {
    const checks = [];
    
    try {
      // Basic connectivity check
      const result = await this.query('SELECT 1 as status', [], { schema: 'public' });
      checks.push({ check: 'connectivity', status: 'OK' });
      
      // Check each schema
      const schemas = ['conversations_service', 'analytics_service', 'security_service', 'testing_service', 'workflow_service'];
      
      for (const schema of schemas) {
        try {
          await this.query('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1', [schema], { schema: 'public' });
          checks.push({ check: `schema_${schema}`, status: 'OK' });
        } catch (error) {
          checks.push({ check: `schema_${schema}`, status: 'ERROR', error: error.message });
        }
      }
      
      // Check monitoring
      try {
        const monitoringResult = await this.query('SELECT * FROM monitoring.health_check()', [], { schema: 'public' });
        const criticalIssues = monitoringResult.rows.filter(row => row.status === 'CRITICAL');
        
        if (criticalIssues.length > 0) {
          checks.push({ 
            check: 'monitoring', 
            status: 'WARNING', 
            issues: criticalIssues 
          });
        } else {
          checks.push({ check: 'monitoring', status: 'OK' });
        }
      } catch (error) {
        checks.push({ check: 'monitoring', status: 'ERROR', error: error.message });
      }
      
      const allHealthy = checks.every(check => check.status === 'OK');
      
      return { 
        healthy: allHealthy, 
        timestamp: new Date().toISOString(),
        checks 
      };
    } catch (error) {
      await auditLogger.logSecurityEvent('DATABASE_HEALTH_CHECK_FAILED', {
        error: error.message
      }, 'CRITICAL');
      
      return { 
        healthy: false, 
        error: error.message,
        timestamp: new Date().toISOString(),
        checks 
      };
    }
  }

  /**
   * Get pool statistics
   */
  getPoolStats() {
    const stats = {};
    
    for (const [schema, pool] of this.pools) {
      stats[schema] = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      };
    }
    
    return stats;
  }

  /**
   * Close all connections
   */
  async close() {
    const closePromises = [];
    
    for (const [schema, pool] of this.pools) {
      closePromises.push(
        pool.end().then(() => {
          console.log(`Closed connection pool for ${schema}`);
        })
      );
    }
    
    await Promise.all(closePromises);
    this.pools.clear();
  }

  /**
   * Execute raw SQL file (for migrations, etc.)
   */
  async executeSQLFile(sqlContent, options = {}) {
    const { schema = 'public' } = options;
    const pool = this.getPool(schema);
    const client = await pool.connect();
    
    try {
      await client.query(sqlContent);
      return { success: true };
    } catch (error) {
      console.error('Error executing SQL file:', error);
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }
}

// Export singleton instance
export const dbManager = new DatabaseConnectionManager();

// Helper functions for specific schemas
export const conversationsDB = {
  query: (text, params, options = {}) => dbManager.query(text, params, { ...options, schema: 'conversations_service' }),
  transaction: (callback, options = {}) => dbManager.transaction(callback, { ...options, schema: 'conversations_service' }),
  batchInsert: (table, columns, values, options = {}) => dbManager.batchInsert(table, columns, values, { ...options, schema: 'conversations_service' })
};

export const securityDB = {
  query: (text, params, options = {}) => dbManager.query(text, params, { ...options, schema: 'security_service' }),
  transaction: (callback, options = {}) => dbManager.transaction(callback, { ...options, schema: 'security_service' }),
  batchInsert: (table, columns, values, options = {}) => dbManager.batchInsert(table, columns, values, { ...options, schema: 'security_service' })
};

export const analyticsDB = {
  query: (text, params, options = {}) => dbManager.query(text, params, { ...options, schema: 'analytics_service' }),
  transaction: (callback, options = {}) => dbManager.transaction(callback, { ...options, schema: 'analytics_service' }),
  batchInsert: (table, columns, values, options = {}) => dbManager.batchInsert(table, columns, values, { ...options, schema: 'analytics_service' })
};

export const testingDB = {
  query: (text, params, options = {}) => dbManager.query(text, params, { ...options, schema: 'testing_service' }),
  transaction: (callback, options = {}) => dbManager.transaction(callback, { ...options, schema: 'testing_service' }),
  batchInsert: (table, columns, values, options = {}) => dbManager.batchInsert(table, columns, values, { ...options, schema: 'testing_service' })
};

export const workflowDB = {
  query: (text, params, options = {}) => dbManager.query(text, params, { ...options, schema: 'workflow_service' }),
  transaction: (callback, options = {}) => dbManager.transaction(callback, { ...options, schema: 'workflow_service' }),
  batchInsert: (table, columns, values, options = {}) => dbManager.batchInsert(table, columns, values, { ...options, schema: 'workflow_service' })
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database connections...');
  await dbManager.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing database connections...');
  await dbManager.close();
  process.exit(0);
});