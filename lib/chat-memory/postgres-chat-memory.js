import { postgresMemory } from './postgres-connection.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

/**
 * PostgreSQL-based chat memory implementation for n8n workflows
 * Provides persistent storage for conversation history with support for
 * summarization, context variables, and performance metrics
 */
export class PostgresChatMemory {
    constructor(options = {}) {
        this.maxMessages = parseInt(process.env.CHAT_MEMORY_MAX_MESSAGES_PER_SESSION || '100');
        this.summarizeAfter = parseInt(process.env.CHAT_MEMORY_SUMMARIZE_AFTER_MESSAGES || '50');
        this.sessionTTL = parseInt(process.env.CHAT_MEMORY_SESSION_TTL_HOURS || '24');
        this.autoCleanup = process.env.CHAT_MEMORY_AUTO_CLEANUP !== 'false';
        this.options = options;
        
        // Start cleanup interval if enabled
        if (this.autoCleanup) {
            this.startCleanupInterval();
        }
    }

    /**
     * Initialize or retrieve a session
     */
    async initializeSession(sessionId, metadata = {}) {
        const query = `
            INSERT INTO chat_memory.sessions (session_id, user_id, workflow_id, metadata, expires_at)
            VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${this.sessionTTL} hours')
            ON CONFLICT (session_id) 
            DO UPDATE SET 
                updated_at = CURRENT_TIMESTAMP,
                expires_at = CASE 
                    WHEN chat_memory.sessions.expires_at < CURRENT_TIMESTAMP 
                    THEN NOW() + INTERVAL '${this.sessionTTL} hours'
                    ELSE chat_memory.sessions.expires_at
                END,
                is_active = true
            RETURNING id, session_id, user_id, workflow_id, metadata, created_at, updated_at, expires_at
        `;
        
        const result = await postgresMemory.query(query, [
            sessionId,
            metadata.userId || null,
            metadata.workflowId || null,
            JSON.stringify(metadata)
        ]);
        
        return result.rows[0];
    }

    /**
     * Add a message to the conversation
     */
    async addMessage(sessionId, messageType, content, metadata = {}) {
        // Ensure session exists
        await this.initializeSession(sessionId, metadata.session || {});
        
        const query = `
            INSERT INTO chat_memory.messages (
                session_id, 
                message_type, 
                content, 
                role,
                name,
                function_call,
                tool_calls,
                metadata, 
                tokens_used,
                model_name,
                completion_tokens,
                prompt_tokens,
                total_cost
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id, session_id, message_type, content, metadata, created_at
        `;
        
        const tokensUsed = metadata.tokens || this.estimateTokens(content);
        
        const result = await postgresMemory.query(query, [
            sessionId,
            messageType,
            content,
            metadata.role || messageType,
            metadata.name || null,
            metadata.function_call ? JSON.stringify(metadata.function_call) : null,
            metadata.tool_calls ? JSON.stringify(metadata.tool_calls) : null,
            JSON.stringify(metadata),
            tokensUsed,
            metadata.model || null,
            metadata.completion_tokens || null,
            metadata.prompt_tokens || null,
            metadata.total_cost || null
        ]);
        
        // Record metrics
        if (metadata.responseTime) {
            await this.recordMetric(sessionId, 'response_time', metadata.responseTime);
        }
        
        // Check if we need to summarize
        await this.checkAndSummarize(sessionId);
        
        return result.rows[0];
    }

    /**
     * Get messages from a session
     */
    async getMessages(sessionId, limit = null) {
        const query = `
            SELECT 
                m.id,
                m.message_type,
                m.content,
                m.role,
                m.name,
                m.function_call,
                m.tool_calls,
                m.metadata,
                m.created_at,
                m.tokens_used,
                m.model_name
            FROM chat_memory.messages m
            WHERE m.session_id = $1
            ORDER BY m.created_at DESC
            ${limit ? `LIMIT ${parseInt(limit)}` : ''}
        `;
        
        const result = await postgresMemory.query(query, [sessionId]);
        return result.rows.reverse(); // Return in chronological order
    }

    /**
     * Get formatted message history for LangChain
     */
    async getMessageHistory(sessionId) {
        // Use the stored function for optimal performance
        const query = `
            SELECT * FROM chat_memory.get_conversation_history($1, $2)
        `;
        
        const result = await postgresMemory.query(query, [sessionId, this.maxMessages]);
        
        // Format for LangChain compatibility
        return result.rows.map(row => ({
            type: row.message_type,
            content: row.content,
            additional_kwargs: row.metadata || {},
            ...(row.is_summary && { is_summary: true })
        }));
    }

    /**
     * Get or set context variables for a session
     */
    async getContextVariable(sessionId, key) {
        const query = `
            SELECT value FROM chat_memory.context_variables
            WHERE session_id = $1 AND key = $2
        `;
        
        const result = await postgresMemory.query(query, [sessionId, key]);
        return result.rows[0]?.value || null;
    }

    async setContextVariable(sessionId, key, value) {
        const query = `
            INSERT INTO chat_memory.context_variables (session_id, key, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (session_id, key) 
            DO UPDATE SET 
                value = EXCLUDED.value,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;
        
        const result = await postgresMemory.query(query, [
            sessionId,
            key,
            JSON.stringify(value)
        ]);
        
        return result.rows[0];
    }

    async getAllContextVariables(sessionId) {
        const query = `
            SELECT key, value FROM chat_memory.context_variables
            WHERE session_id = $1
            ORDER BY key
        `;
        
        const result = await postgresMemory.query(query, [sessionId]);
        
        // Convert to object
        const context = {};
        result.rows.forEach(row => {
            context[row.key] = row.value;
        });
        
        return context;
    }

    /**
     * Check if summarization is needed and perform it
     */
    async checkAndSummarize(sessionId) {
        const countQuery = `
            SELECT 
                COUNT(*) as total_count,
                COUNT(*) FILTER (WHERE created_at > COALESCE(
                    (SELECT MAX(created_at) FROM chat_memory.messages 
                     WHERE id = (SELECT end_message_id FROM chat_memory.summaries 
                                WHERE session_id = $1 
                                ORDER BY created_at DESC LIMIT 1)),
                    '1970-01-01'::timestamp
                )) as new_count
            FROM chat_memory.messages
            WHERE session_id = $1
        `;
        
        const countResult = await postgresMemory.query(countQuery, [sessionId]);
        const { total_count, new_count } = countResult.rows[0];
        
        if (parseInt(new_count) >= this.summarizeAfter) {
            await this.createSummary(sessionId);
        }
    }

    /**
     * Create a summary of recent messages
     * NOTE: This is a placeholder - implement with your AI service
     */
    async createSummary(sessionId) {
        logger.info(`Creating summary for session ${sessionId}`);
        
        // Get messages to summarize
        const messagesQuery = `
            SELECT id, message_type, content, created_at
            FROM chat_memory.messages
            WHERE session_id = $1
            AND created_at > COALESCE(
                (SELECT MAX(created_at) FROM chat_memory.messages 
                 WHERE id = (SELECT end_message_id FROM chat_memory.summaries 
                            WHERE session_id = $1 
                            ORDER BY created_at DESC LIMIT 1)),
                '1970-01-01'::timestamp
            )
            ORDER BY created_at ASC
            LIMIT $2
        `;
        
        const messages = await postgresMemory.query(messagesQuery, [sessionId, this.summarizeAfter]);
        
        if (messages.rows.length === 0) return;
        
        // TODO: Implement actual AI summarization
        // For now, create a simple summary
        const summary = `Conversation summary of ${messages.rows.length} messages from ${messages.rows[0].created_at} to ${messages.rows[messages.rows.length - 1].created_at}`;
        
        // Store summary
        const insertQuery = `
            INSERT INTO chat_memory.summaries (
                session_id, 
                summary, 
                message_count, 
                token_count,
                start_message_id, 
                end_message_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        await postgresMemory.query(insertQuery, [
            sessionId,
            summary,
            messages.rows.length,
            this.estimateTokens(summary),
            messages.rows[0].id,
            messages.rows[messages.rows.length - 1].id
        ]);
        
        logger.info(`Summary created for session ${sessionId}`);
    }

    /**
     * Clear a session and all its data
     */
    async clearSession(sessionId) {
        const query = `DELETE FROM chat_memory.sessions WHERE session_id = $1 RETURNING *`;
        const result = await postgresMemory.query(query, [sessionId]);
        
        if (result.rowCount > 0) {
            logger.info(`Cleared session ${sessionId}`);
        }
        
        return result.rows[0];
    }

    /**
     * Mark session as inactive
     */
    async endSession(sessionId) {
        const query = `
            UPDATE chat_memory.sessions 
            SET is_active = false, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = $1
            RETURNING *
        `;
        
        const result = await postgresMemory.query(query, [sessionId]);
        return result.rows[0];
    }

    /**
     * Clean up expired sessions
     */
    async cleanupExpiredSessions() {
        const query = `SELECT chat_memory.cleanup_expired_sessions() as deleted_count`;
        const result = await postgresMemory.query(query);
        
        const deletedCount = result.rows[0].deleted_count;
        if (deletedCount > 0) {
            logger.info(`Cleaned up ${deletedCount} expired sessions`);
        }
        
        return deletedCount;
    }

    /**
     * Start automatic cleanup interval
     */
    startCleanupInterval() {
        // Run cleanup every hour
        this.cleanupInterval = setInterval(async () => {
            try {
                await this.cleanupExpiredSessions();
            } catch (error) {
                logger.error('Error during automatic cleanup:', error);
            }
        }, 60 * 60 * 1000); // 1 hour
    }

    /**
     * Stop automatic cleanup
     */
    stopCleanupInterval() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * Simple token estimation
     */
    estimateTokens(text) {
        // Simple estimation: ~4 characters per token
        // Replace with actual tokenizer for production
        return Math.ceil(text.length / 4);
    }

    /**
     * Record performance metrics
     */
    async recordMetric(sessionId, metricType, value, metadata = {}) {
        const query = `
            INSERT INTO chat_memory.metrics (session_id, metric_type, value, unit, metadata)
            VALUES ($1, $2, $3, $4, $5)
        `;
        
        await postgresMemory.query(query, [
            sessionId,
            metricType,
            value,
            metadata.unit || null,
            JSON.stringify(metadata)
        ]);
    }

    /**
     * Get session metrics
     */
    async getSessionMetrics(sessionId) {
        const query = `
            SELECT 
                metric_type,
                AVG(value) as avg_value,
                MIN(value) as min_value,
                MAX(value) as max_value,
                COUNT(*) as count,
                unit
            FROM chat_memory.metrics
            WHERE session_id = $1
            GROUP BY metric_type, unit
            ORDER BY metric_type
        `;
        
        const result = await postgresMemory.query(query, [sessionId]);
        return result.rows;
    }

    /**
     * Get session information
     */
    async getSessionInfo(sessionId) {
        const query = `
            SELECT 
                s.*,
                COUNT(DISTINCT m.id) as message_count,
                SUM(m.tokens_used) as total_tokens,
                MAX(m.created_at) as last_message_at
            FROM chat_memory.sessions s
            LEFT JOIN chat_memory.messages m ON s.session_id = m.session_id
            WHERE s.session_id = $1
            GROUP BY s.id
        `;
        
        const result = await postgresMemory.query(query, [sessionId]);
        return result.rows[0];
    }

    /**
     * Search sessions by metadata
     */
    async searchSessions(filters = {}) {
        let query = `
            SELECT * FROM chat_memory.active_sessions
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        if (filters.userId) {
            query += ` AND user_id = $${paramIndex++}`;
            params.push(filters.userId);
        }
        
        if (filters.workflowId) {
            query += ` AND workflow_id = $${paramIndex++}`;
            params.push(filters.workflowId);
        }
        
        if (filters.metadata) {
            query += ` AND metadata @> $${paramIndex++}`;
            params.push(JSON.stringify(filters.metadata));
        }
        
        query += ` ORDER BY last_message_at DESC LIMIT 100`;
        
        const result = await postgresMemory.query(query, params);
        return result.rows;
    }

    /**
     * Get conversation analytics
     */
    async getConversationAnalytics(timeRange = '24 hours') {
        const query = `
            SELECT * FROM chat_memory.recent_conversations
            WHERE first_message >= CURRENT_TIMESTAMP - INTERVAL '${timeRange}'
        `;
        
        const result = await postgresMemory.query(query);
        return result.rows;
    }

    /**
     * Generate a new session ID
     */
    generateSessionId() {
        return `session_${crypto.randomUUID()}`;
    }
}

// Export singleton instance
export const chatMemory = new PostgresChatMemory();

// Cleanup on process termination
process.on('SIGTERM', () => {
    chatMemory.stopCleanupInterval();
});

process.on('SIGINT', () => {
    chatMemory.stopCleanupInterval();
});