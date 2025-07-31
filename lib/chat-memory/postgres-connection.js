import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * PostgreSQL connection manager for chat memory storage
 * Handles connection pooling, retry logic, and health monitoring
 */
class PostgresChatMemoryConnection {
    constructor() {
        this.pool = null;
        this.isConnected = false;
        this.connectionAttempts = 0;
        this.maxRetries = 3;
        this.retryDelay = 1000; // Start with 1 second, exponential backoff
        
        this.config = {
            host: process.env.POSTGRES_CHAT_MEMORY_HOST || 'crossover.proxy.rlwy.net',
            port: parseInt(process.env.POSTGRES_CHAT_MEMORY_PORT || '59347'),
            database: process.env.POSTGRES_CHAT_MEMORY_DATABASE || 'railway',
            user: process.env.POSTGRES_CHAT_MEMORY_USER || 'postgres',
            password: process.env.POSTGRES_CHAT_MEMORY_PASSWORD,
            ssl: process.env.POSTGRES_CHAT_MEMORY_SSL === 'true' ? { 
                rejectUnauthorized: false 
            } : false,
            
            // Pool configuration
            min: parseInt(process.env.POSTGRES_CHAT_MEMORY_POOL_MIN || '2'),
            max: parseInt(process.env.POSTGRES_CHAT_MEMORY_POOL_MAX || '10'),
            idleTimeoutMillis: parseInt(process.env.POSTGRES_CHAT_MEMORY_IDLE_TIMEOUT || '30000'),
            connectionTimeoutMillis: parseInt(process.env.POSTGRES_CHAT_MEMORY_CONNECTION_TIMEOUT || '5000'),
            
            // Additional settings
            statement_timeout: parseInt(process.env.POSTGRES_CHAT_MEMORY_STATEMENT_TIMEOUT || '30000'),
            query_timeout: parseInt(process.env.POSTGRES_CHAT_MEMORY_QUERY_TIMEOUT || '30000'),
            application_name: 'n8n-chat-memory'
        };
        
        // Validate required configuration
        if (!this.config.password) {
            logger.warn('POSTGRES_CHAT_MEMORY_PASSWORD not set - connection will fail');
        }
    }

    /**
     * Connect to PostgreSQL with retry logic
     */
    async connect() {
        if (this.pool && this.isConnected) {
            return this.pool;
        }

        try {
            this.pool = new Pool(this.config);
            
            // Set up event handlers
            this.setupEventHandlers();
            
            // Test connection
            await this.testConnection();
            
            this.isConnected = true;
            this.connectionAttempts = 0;
            logger.info('Connected to Postgres chat memory database', {
                host: this.config.host,
                port: this.config.port,
                database: this.config.database
            });
            
            return this.pool;
        } catch (error) {
            this.connectionAttempts++;
            logger.error('Failed to connect to Postgres chat memory:', {
                error: error.message,
                attempt: this.connectionAttempts,
                maxRetries: this.maxRetries
            });
            
            if (this.connectionAttempts < this.maxRetries) {
                const delay = this.retryDelay * Math.pow(2, this.connectionAttempts - 1);
                logger.info(`Retrying connection in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.connect();
            }
            
            throw error;
        }
    }

    /**
     * Set up pool event handlers
     */
    setupEventHandlers() {
        if (!this.pool) return;
        
        this.pool.on('error', (err, client) => {
            logger.error('Unexpected error on idle client', err);
            this.isConnected = false;
        });
        
        this.pool.on('connect', (client) => {
            logger.debug('New client connected to pool');
        });
        
        this.pool.on('acquire', (client) => {
            logger.debug('Client acquired from pool');
        });
        
        this.pool.on('remove', (client) => {
            logger.debug('Client removed from pool');
        });
    }

    /**
     * Test database connection
     */
    async testConnection() {
        const client = await this.pool.connect();
        try {
            const result = await client.query('SELECT NOW() as current_time, current_database() as db');
            logger.debug('Connection test successful:', result.rows[0]);
            
            // Check if schema exists
            const schemaCheck = await client.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name = 'chat_memory'
            `);
            
            if (schemaCheck.rows.length === 0) {
                logger.warn('chat_memory schema does not exist - migrations may need to be run');
            }
        } finally {
            client.release();
        }
    }

    /**
     * Disconnect from database
     */
    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.isConnected = false;
            logger.info('Disconnected from Postgres chat memory database');
        }
    }

    /**
     * Execute a query with automatic connection handling
     */
    async query(text, params) {
        const pool = await this.connect();
        const start = Date.now();
        
        try {
            const result = await pool.query(text, params);
            const duration = Date.now() - start;
            
            logger.debug('Executed query', {
                text: text.substring(0, 100),
                duration,
                rows: result.rowCount,
                params: params?.length || 0
            });
            
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            logger.error('Query error:', {
                text: text.substring(0, 100),
                error: error.message,
                duration,
                code: error.code
            });
            
            // Handle connection errors
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                this.isConnected = false;
                this.connectionAttempts = 0;
            }
            
            throw error;
        }
    }

    /**
     * Execute multiple queries in a transaction
     */
    async transaction(callback) {
        const pool = await this.connect();
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Transaction rolled back:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get pool statistics
     */
    getPoolStats() {
        if (!this.pool) {
            return {
                connected: false,
                totalCount: 0,
                idleCount: 0,
                waitingCount: 0
            };
        }
        
        return {
            connected: this.isConnected,
            totalCount: this.pool.totalCount,
            idleCount: this.pool.idleCount,
            waitingCount: this.pool.waitingCount
        };
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const result = await this.query('SELECT 1 as health');
            return {
                healthy: true,
                connected: this.isConnected,
                poolStats: this.getPoolStats(),
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                healthy: false,
                connected: false,
                error: error.message,
                poolStats: this.getPoolStats(),
                timestamp: new Date().toISOString()
            };
        }
    }
}

// Export singleton instance
export const postgresMemory = new PostgresChatMemoryConnection();

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, closing database connections...');
    await postgresMemory.disconnect();
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, closing database connections...');
    await postgresMemory.disconnect();
    process.exit(0);
});