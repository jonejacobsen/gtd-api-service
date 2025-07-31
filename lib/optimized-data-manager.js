/**
 * Optimized Data Manager
 * 
 * Enhanced hybrid architecture leveraging both Supabase and Railway strengths
 * Implements intelligent data tiering and cost optimization
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { auditLogger } from './security-audit-logger.js';

export class OptimizedDataManager {
  constructor() {
    // Supabase for structured, frequently-queried data
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    // Railway persistent storage for high-frequency writes and large files
    this.railwayPath = process.env.RAILWAY_ENVIRONMENT ? 
      '/app/persistent-data' : './data';
    
    // Data tiering thresholds
    this.hotDataThresholdDays = 30;  // Keep recent data in Supabase
    this.archiveThresholdDays = 90;  // Archive older data to files
    
    this.ensureDirectories();
  }

  /**
   * Ensure Railway storage directories exist
   */
  ensureDirectories() {
    const dirs = [
      'conversations/hot',
      'conversations/archive',
      'security-logs',
      'ml-data/active',
      'ml-data/archive',
      'monitoring/real-time',
      'monitoring/historical'
    ];
    
    dirs.forEach(dir => {
      const fullPath = join(this.railwayPath, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
    });
  }

  /**
   * Intelligent conversation storage with data tiering
   */
  async saveConversation(conversationId, conversationData) {
    const timestamp = new Date().toISOString();
    
    try {
      // 1. Always save to Railway for immediate access and backup
      const filePath = join(this.railwayPath, 'conversations/hot', `${conversationId}.json`);
      const fileData = {
        ...conversationData,
        saved_at: timestamp,
        storage_tier: 'hot'
      };
      writeFileSync(filePath, JSON.stringify(fileData, null, 2));
      
      // 2. Save to Supabase for structured queries and real-time features
      const { error } = await this.supabase
        .from('conversations')
        .upsert({
          id: conversationId,
          user_id: conversationData.userId,
          conversation_data: conversationData,
          created_at: conversationData.timestamp || timestamp,
          updated_at: timestamp,
          status: 'active'
        });
      
      if (error) {
        await auditLogger.logSecurityEvent('SUPABASE_WRITE_ERROR', {
          conversation_id: conversationId,
          error: error.message,
          fallback: 'file_storage_only'
        }, 'WARNING');
      }
      
      await auditLogger.logSecurityEvent('CONVERSATION_SAVED', {
        conversation_id: conversationId,
        user_id: conversationData.userId,
        storage_tiers: ['railway_file', 'supabase']
      });
      
      return { success: true, storage: ['railway', 'supabase'] };
    } catch (error) {
      await auditLogger.logSecurityEvent('CONVERSATION_SAVE_ERROR', {
        conversation_id: conversationId,
        error: error.message
      }, 'ERROR');
      
      throw error;
    }
  }

  /**
   * Intelligent conversation retrieval with performance optimization
   */
  async getConversation(conversationId, options = {}) {
    const { preferSource = 'auto', includeArchived = false } = options;
    
    try {
      // Strategy 1: Try Railway file first (fastest for recent data)
      if (preferSource === 'file' || preferSource === 'auto') {
        const filePath = join(this.railwayPath, 'conversations/hot', `${conversationId}.json`);
        
        if (existsSync(filePath)) {
          const fileData = JSON.parse(readFileSync(filePath, 'utf8'));
          
          await auditLogger.logSecurityEvent('CONVERSATION_RETRIEVED', {
            conversation_id: conversationId,
            source: 'railway_file',
            performance: 'optimal'
          });
          
          return { data: fileData, source: 'railway_file' };
        }
      }
      
      // Strategy 2: Try Supabase for structured access
      if (preferSource === 'database' || preferSource === 'auto') {
        const { data, error } = await this.supabase
          .from('conversations')
          .select('*')
          .eq('id', conversationId)
          .single();
        
        if (data && !error) {
          await auditLogger.logSecurityEvent('CONVERSATION_RETRIEVED', {
            conversation_id: conversationId,
            source: 'supabase',
            performance: 'good'
          });
          
          return { data: data.conversation_data, source: 'supabase' };
        }
      }
      
      // Strategy 3: Check archived data if requested
      if (includeArchived) {
        const archivePath = join(this.railwayPath, 'conversations/archive', `${conversationId}.json`);
        
        if (existsSync(archivePath)) {
          const archivedData = JSON.parse(readFileSync(archivePath, 'utf8'));
          
          await auditLogger.logSecurityEvent('CONVERSATION_RETRIEVED', {
            conversation_id: conversationId,
            source: 'railway_archive',
            performance: 'slow'
          });
          
          return { data: archivedData, source: 'archive' };
        }
      }
      
      return { data: null, source: null };
    } catch (error) {
      await auditLogger.logSecurityEvent('CONVERSATION_RETRIEVAL_ERROR', {
        conversation_id: conversationId,
        error: error.message
      }, 'ERROR');
      
      throw error;
    }
  }

  /**
   * High-performance security logging with intelligent storage
   */
  async logSecurityEvent(event) {
    const timestamp = new Date().toISOString();
    const eventWithTimestamp = { ...event, timestamp };
    
    try {
      // 1. Always write to Railway file immediately (performance critical)
      const logPath = join(this.railwayPath, 'security-logs', 'security-audit.log');
      appendFileSync(logPath, JSON.stringify(eventWithTimestamp) + '\n');
      
      // 2. Write critical events to Supabase for structured querying
      if (this.isCriticalSecurityEvent(event)) {
        await this.supabase
          .from('security_audit_events')
          .insert({
            event_id: event.event_id,
            event_type: event.event_type,
            timestamp: timestamp,
            severity: event.severity || 'INFO',
            user_context: event.user_context,
            details: event.details,
            success: event.success
          });
      }
      
      return { success: true, storage: ['railway_file', 'supabase'] };
    } catch (error) {
      // Fallback: ensure at least file logging succeeds
      console.error('Security logging error:', error);
      return { success: true, storage: ['railway_file'], error: error.message };
    }
  }

  /**
   * Determine if security event needs structured storage
   */
  isCriticalSecurityEvent(event) {
    const criticalEvents = [
      'AUTHENTICATION_FAILURE',
      'SECRET_ACCESS_FAILURE',
      'SECURITY_INCIDENT',
      'UNAUTHORIZED_ACCESS',
      'TOKEN_ROTATION_FAILED'
    ];
    
    const criticalSeverities = ['HIGH', 'CRITICAL'];
    
    return criticalEvents.includes(event.event_type) || 
           criticalSeverities.includes(event.severity);
  }

  /**
   * Data archival process for cost optimization
   */
  async archiveOldData() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.hotDataThresholdDays);
    
    try {
      // Archive old conversations from Supabase to Railway files
      const { data: oldConversations } = await this.supabase
        .from('conversations')
        .select('*')
        .lt('updated_at', cutoffDate.toISOString())
        .eq('status', 'active');
      
      let archivedCount = 0;
      
      for (const conversation of oldConversations || []) {
        // Move to archive storage
        const archivePath = join(
          this.railwayPath, 
          'conversations/archive', 
          `${conversation.id}.json`
        );
        
        const archiveData = {
          ...conversation,
          archived_at: new Date().toISOString(),
          original_source: 'supabase'
        };
        
        writeFileSync(archivePath, JSON.stringify(archiveData, null, 2));
        
        // Update status in Supabase instead of deleting
        await this.supabase
          .from('conversations')
          .update({ status: 'archived', archived_at: new Date().toISOString() })
          .eq('id', conversation.id);
        
        archivedCount++;
      }
      
      await auditLogger.logSecurityEvent('DATA_ARCHIVAL_COMPLETED', {
        archived_count: archivedCount,
        cutoff_date: cutoffDate.toISOString(),
        storage_optimized: true
      });
      
      return { success: true, archived: archivedCount };
    } catch (error) {
      await auditLogger.logSecurityEvent('DATA_ARCHIVAL_ERROR', {
        error: error.message
      }, 'ERROR');
      
      throw error;
    }
  }

  /**
   * Real-time conversation updates using Supabase
   */
  subscribeToConversationUpdates(userId, callback) {
    return this.supabase
      .channel(`conversations:${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'conversations',
        filter: `user_id=eq.${userId}`
      }, callback)
      .subscribe();
  }

  /**
   * Advanced conversation search using Supabase
   */
  async searchConversations(userId, query, options = {}) {
    const { limit = 50, includeArchived = false } = options;
    
    let queryBuilder = this.supabase
      .from('conversations')
      .select('id, user_id, conversation_data, created_at, updated_at')
      .eq('user_id', userId)
      .limit(limit);
    
    if (!includeArchived) {
      queryBuilder = queryBuilder.neq('status', 'archived');
    }
    
    // Use Supabase's full-text search capabilities
    if (query) {
      queryBuilder = queryBuilder.textSearch('conversation_data', query);
    }
    
    const { data, error } = await queryBuilder.order('updated_at', { ascending: false });
    
    if (error) {
      await auditLogger.logSecurityEvent('CONVERSATION_SEARCH_ERROR', {
        user_id: userId,
        query,
        error: error.message
      }, 'ERROR');
      throw error;
    }
    
    await auditLogger.logSecurityEvent('CONVERSATION_SEARCH', {
      user_id: userId,
      query,
      results_count: data?.length || 0
    });
    
    return data;
  }

  /**
   * ML data management with intelligent storage
   */
  async saveMlModel(modelId, modelData, metadata) {
    try {
      // Large binary data → Railway files
      const modelPath = join(this.railwayPath, 'ml-data/active', `${modelId}.model`);
      writeFileSync(modelPath, modelData);
      
      // Metadata → Supabase for querying
      await this.supabase
        .from('ml_models')
        .upsert({
          id: modelId,
          metadata,
          file_path: modelPath,
          created_at: new Date().toISOString(),
          status: 'active'
        });
      
      await auditLogger.logSecurityEvent('ML_MODEL_SAVED', {
        model_id: modelId,
        file_size: modelData.length,
        storage: 'hybrid'
      });
      
      return { success: true, path: modelPath };
    } catch (error) {
      await auditLogger.logSecurityEvent('ML_MODEL_SAVE_ERROR', {
        model_id: modelId,
        error: error.message
      }, 'ERROR');
      
      throw error;
    }
  }

  /**
   * Performance metrics and monitoring
   */
  async getStorageMetrics() {
    const metrics = {
      timestamp: new Date().toISOString(),
      railway_usage: await this.getRailwayStorageUsage(),
      supabase_usage: await this.getSupabaseUsage(),
      data_distribution: await this.getDataDistribution()
    };
    
    // Store metrics for trending
    const metricsPath = join(this.railwayPath, 'monitoring/real-time', 'storage-metrics.json');
    writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
    
    return metrics;
  }

  async getRailwayStorageUsage() {
    // Calculate Railway file storage usage
    const { execSync } = await import('child_process');
    try {
      const usage = execSync(`du -sb ${this.railwayPath}`, { encoding: 'utf8' });
      return {
        total_bytes: parseInt(usage.split('\t')[0]),
        path: this.railwayPath
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async getSupabaseUsage() {
    try {
      // Get record counts from main tables
      const tables = ['conversations', 'security_audit_events', 'ml_models'];
      const usage = {};
      
      for (const table of tables) {
        const { count } = await this.supabase
          .from(table)
          .select('*', { count: 'exact', head: true });
        usage[table] = count;
      }
      
      return usage;
    } catch (error) {
      return { error: error.message };
    }
  }

  async getDataDistribution() {
    return {
      hot_conversations: await this.countFiles('conversations/hot'),
      archived_conversations: await this.countFiles('conversations/archive'),
      active_ml_models: await this.countFiles('ml-data/active'),
      archived_ml_models: await this.countFiles('ml-data/archive')
    };
  }

  async countFiles(relativePath) {
    const { readdirSync } = await import('fs');
    try {
      const fullPath = join(this.railwayPath, relativePath);
      if (existsSync(fullPath)) {
        return readdirSync(fullPath).length;
      }
      return 0;
    } catch (error) {
      return 0;
    }
  }
}

// Export singleton instance
export const optimizedDataManager = new OptimizedDataManager();

// Helper functions for easy integration
export async function saveConversation(conversationId, data) {
  return optimizedDataManager.saveConversation(conversationId, data);
}

export async function getConversation(conversationId, options) {
  return optimizedDataManager.getConversation(conversationId, options);
}

export async function searchConversations(userId, query, options) {
  return optimizedDataManager.searchConversations(userId, query, options);
}

export function subscribeToUpdates(userId, callback) {
  return optimizedDataManager.subscribeToConversationUpdates(userId, callback);
}