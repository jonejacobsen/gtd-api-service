/**
 * Security Audit Logger
 * 
 * Comprehensive audit logging system for all security-related events
 * Provides detailed trails for compliance and incident investigation
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import crypto from 'crypto';

export class SecurityAuditLogger {
  constructor() {
    // Use Railway persistent storage paths
    this.logDir = process.env.RAILWAY_ENVIRONMENT ? 
      '/app/persistent-data/security-logs' : 
      process.env.SECURITY_LOG_PATH || './logs';
    
    this.logFile = join(this.logDir, 'security-audit.log');
    this.sessionId = this.generateSessionId();
    
    // Ensure log directory exists on stable storage
    this.ensureLogDirectory();
    
    // Initialize with session start
    this.logSessionStart();
  }

  /**
   * Ensure log directory exists
   */
  ensureLogDirectory() {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Generate unique event ID
   */
  generateEventId() {
    return crypto.randomUUID();
  }

  /**
   * Generate session ID for tracking related events
   */
  generateSessionId() {
    return `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Get user context information
   */
  getUserContext() {
    return {
      session_id: this.sessionId,
      user_agent: process.env.USER_AGENT || 'claude-code-automation',
      process_id: process.pid,
      node_version: process.version,
      platform: process.platform
    };
  }

  /**
   * Get source IP (if available)
   */
  getSourceIP() {
    return process.env.SOURCE_IP || 'localhost';
  }

  /**
   * Write audit event to log
   */
  async writeAuditLog(event) {
    const logEntry = {
      ...event,
      session_id: this.sessionId,
      log_level: 'AUDIT',
      source: 'security-audit-logger'
    };

    const logLine = JSON.stringify(logEntry) + '\n';
    
    try {
      appendFileSync(this.logFile, logLine, 'utf8');
    } catch (error) {
      console.error('Failed to write audit log:', error);
      // Fallback to console logging for critical events
      console.log('AUDIT_LOG_FAILURE:', logEntry);
    }
  }

  /**
   * Log session start
   */
  async logSessionStart() {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'SESSION_START',
      user_context: this.getUserContext(),
      details: {
        environment: process.env.NODE_ENV || 'development',
        railway_environment: process.env.RAILWAY_ENVIRONMENT || 'local'
      }
    };
    
    await this.writeAuditLog(event);
  }

  /**
   * Log secret access attempt
   */
  async logSecretAccess(itemName, fieldName, success, error = null) {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'SECRET_ACCESS',
      user_context: this.getUserContext(),
      resource: {
        item_name: itemName,
        field_name: fieldName,
        vault: '***' // Don't log vault name for security
      },
      success,
      error_message: error ? error.message : null,
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Log authentication attempt
   */
  async logAuthenticationAttempt(endpoint, method, success, errorCode = null, token_type = null) {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'AUTH_ATTEMPT',
      user_context: this.getUserContext(),
      request: {
        endpoint: endpoint,
        method: method,
        user_agent: process.env.HTTP_USER_AGENT
      },
      success,
      error_code: errorCode,
      token_type: token_type,
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Log deployment operation
   */
  async logDeploymentOperation(operation, service, success, details = null) {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'DEPLOYMENT_OPERATION',
      user_context: this.getUserContext(),
      operation: {
        type: operation,
        target_service: service,
        details: details
      },
      success,
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Log security event (general purpose)
   */
  async logSecurityEvent(eventType, details, severity = 'INFO') {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: eventType,
      user_context: this.getUserContext(),
      severity: severity,
      details: details,
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Log environment variable access
   */
  async logEnvironmentAccess(variable_name, source, success) {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'ENVIRONMENT_ACCESS',
      user_context: this.getUserContext(),
      resource: {
        variable_name: variable_name,
        source: source
      },
      success,
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Log Railway API operation
   */
  async logRailwayOperation(operation, service, success, error = null) {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'RAILWAY_API_OPERATION',
      user_context: this.getUserContext(),
      operation: {
        type: operation,
        service: service
      },
      success,
      error_message: error ? error.message : null,
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Log configuration change
   */
  async logConfigurationChange(config_type, old_value, new_value, reason) {
    const event = {
      timestamp: new Date().toISOString(),
      event_id: this.generateEventId(),
      event_type: 'CONFIGURATION_CHANGE',
      user_context: this.getUserContext(),
      change: {
        type: config_type,
        old_value_hash: old_value ? crypto.createHash('sha256').update(old_value).digest('hex').substring(0, 8) : null,
        new_value_hash: new_value ? crypto.createHash('sha256').update(new_value).digest('hex').substring(0, 8) : null,
        reason: reason
      },
      source_ip: this.getSourceIP()
    };
    
    await this.writeAuditLog(event);
    return event.event_id;
  }

  /**
   * Generate security summary report
   */
  async generateSecuritySummary() {
    const summary = {
      session_id: this.sessionId,
      generated_at: new Date().toISOString(),
      log_file: this.logFile,
      session_duration: Date.now() - parseInt(this.sessionId.split('_')[1]),
      environment: {
        node_env: process.env.NODE_ENV,
        railway_env: process.env.RAILWAY_ENVIRONMENT,
        platform: process.platform
      }
    };

    await this.logSecurityEvent('SECURITY_SUMMARY', summary, 'INFO');
    return summary;
  }
}

// Export singleton instance for consistent session tracking
export const auditLogger = new SecurityAuditLogger();

// Helper functions for easy integration
export async function logSecretAccess(itemName, fieldName, success, error = null) {
  return auditLogger.logSecretAccess(itemName, fieldName, success, error);
}

export async function logAuthAttempt(endpoint, method, success, errorCode = null) {
  return auditLogger.logAuthenticationAttempt(endpoint, method, success, errorCode);
}

export async function logDeployment(operation, service, success, details = null) {
  return auditLogger.logDeploymentOperation(operation, service, success, details);
}

export async function logSecurityEvent(eventType, details, severity = 'INFO') {
  return auditLogger.logSecurityEvent(eventType, details, severity);
}