/**
 * Token Rotation Manager
 * 
 * Automated rotation system for long-lived credentials
 * Ensures security through regular credential updates
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import crypto from 'crypto';
import { deployManager } from './claude-code-deploy.js';
import { auditLogger } from './security-audit-logger.js';
import { deploymentClient } from './lib/deployment-client.js';

export class TokenRotationManager {
  constructor() {
    // Store rotation config on Railway persistent storage
    this.rotationConfigFile = process.env.RAILWAY_ENVIRONMENT ? 
      '/app/persistent-data/config/token-rotation-config.json' : 
      './config/token-rotation-config.json';
    this.opManager = deploymentClient;
    
    // Default rotation schedules (in days)
    this.defaultSchedule = {
      'RAILWAY_TOKEN': { 
        interval: 90, 
        next: null,
        rotator: 'railwayToken',
        critical: true
      },
      'JWT_SECRET': { 
        interval: 180, 
        next: null,
        rotator: 'jwtSecret',
        critical: true
      },
      'N8N_API_KEY': { 
        interval: 90, 
        next: null,
        rotator: 'n8nApiKey',
        critical: false
      },
      'OP_SERVICE_ACCOUNT_TOKEN': {
        interval: 60,
        next: null,
        rotator: 'onePasswordToken',
        critical: true,
        manual_only: true // Requires manual intervention
      }
    };
    
    this.rotationConfig = this.loadRotationConfig();
  }

  /**
   * Load rotation configuration from file
   */
  loadRotationConfig() {
    if (existsSync(this.rotationConfigFile)) {
      try {
        const config = JSON.parse(readFileSync(this.rotationConfigFile, 'utf8'));
        return { ...this.defaultSchedule, ...config };
      } catch (error) {
        console.warn('Failed to load rotation config, using defaults');
        return this.defaultSchedule;
      }
    }
    return this.defaultSchedule;
  }

  /**
   * Save rotation configuration to file
   */
  saveRotationConfig() {
    try {
      writeFileSync(this.rotationConfigFile, JSON.stringify(this.rotationConfig, null, 2));
    } catch (error) {
      console.error('Failed to save rotation config:', error);
    }
  }

  /**
   * Calculate next rotation date
   */
  calculateNextRotation(intervalDays) {
    const now = new Date();
    const nextRotation = new Date(now.getTime() + (intervalDays * 24 * 60 * 60 * 1000));
    return nextRotation.toISOString();
  }

  /**
   * Initialize rotation schedules
   */
  async initializeRotationSchedules() {
    console.log('🔄 Initializing token rotation schedules...');
    
    for (const [tokenType, config] of Object.entries(this.rotationConfig)) {
      if (!config.next) {
        config.next = this.calculateNextRotation(config.interval);
        console.log(`📅 Scheduled ${tokenType} rotation for ${config.next}`);
      }
    }
    
    this.saveRotationConfig();
    await auditLogger.logSecurityEvent('ROTATION_SCHEDULE_INITIALIZED', {
      tokens: Object.keys(this.rotationConfig),
      next_rotations: Object.fromEntries(
        Object.entries(this.rotationConfig).map(([k, v]) => [k, v.next])
      )
    });
  }

  /**
   * Check which tokens need rotation
   */
  getTokensNeedingRotation() {
    const now = new Date();
    const needRotation = [];
    
    for (const [tokenType, config] of Object.entries(this.rotationConfig)) {
      if (config.next && new Date(config.next) <= now && !config.manual_only) {
        needRotation.push(tokenType);
      }
    }
    
    return needRotation;
  }

  /**
   * Generate new JWT secret
   */
  async rotateJwtSecret() {
    console.log('🔄 Rotating JWT secret...');
    
    try {
      // Generate new JWT secret
      const newSecret = crypto.randomBytes(64).toString('hex');
      
      // Update in 1Password
      await this.opManager.updateSecret('prod-jwt-secret-railway', 'secret', newSecret);
      
      // Deploy to Railway
      await deployManager.setVariable('backend-supabase', 'JWT_SECRET', newSecret);
      
      // Wait for deployment
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Verify the new secret works
      const status = await deployManager.status('backend-supabase');
      if (!status.success) {
        throw new Error('Deployment failed after JWT rotation');
      }
      
      await auditLogger.logSecurityEvent('JWT_SECRET_ROTATED', {
        success: true,
        deployment_status: status
      });
      
      return { success: true, message: 'JWT secret rotated successfully' };
    } catch (error) {
      await auditLogger.logSecurityEvent('JWT_SECRET_ROTATION_FAILED', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Generate new Railway token (requires manual intervention)
   */
  async rotateRailwayToken() {
    console.log('🔄 Railway token rotation requires manual intervention...');
    
    const instructions = {
      steps: [
        '1. Go to Railway dashboard (railway.app)',
        '2. Navigate to Account Settings → Tokens',
        '3. Create new token with project access',
        '4. Update 1Password: prod-railway-apitoken-deployment',
        '5. Verify with: npm run deploy:status'
      ],
      automation_note: 'This rotation requires manual steps due to Railway API limitations'
    };
    
    await auditLogger.logSecurityEvent('RAILWAY_TOKEN_ROTATION_REQUESTED', {
      manual_intervention_required: true,
      instructions
    });
    
    return { 
      success: false, 
      manual_required: true,
      instructions
    };
  }

  /**
   * Rotate n8n API key (if possible)
   */
  async rotateN8nApiKey() {
    console.log('🔄 Rotating n8n API key...');
    
    try {
      // Note: This would require n8n API to support key rotation
      // Currently this is a placeholder for future implementation
      
      const instructions = {
        steps: [
          '1. Access n8n instance at configured URL',
          '2. Go to Settings → API Keys',
          '3. Generate new API key',
          '4. Update 1Password: prod-n8n-apikey-railway',
          '5. Test with: npm run n8n:configure'
        ],
        automation_note: 'n8n API key rotation not yet automated'
      };
      
      await auditLogger.logSecurityEvent('N8N_API_KEY_ROTATION_REQUESTED', {
        manual_intervention_required: true,
        instructions
      });
      
      return { 
        success: false, 
        manual_required: true,
        instructions
      };
    } catch (error) {
      await auditLogger.logSecurityEvent('N8N_API_KEY_ROTATION_FAILED', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Rotate 1Password service account token (manual only)
   */
  async rotateOnePasswordToken() {
    console.log('🔄 1Password token rotation requires manual intervention...');
    
    const instructions = {
      steps: [
        '1. Access 1Password Business dashboard',
        '2. Go to Integrations → Service Accounts',
        '3. Create new service account with same permissions',
        '4. Update GitHub repository secret: OP_SERVICE_ACCOUNT_TOKEN',
        '5. Update local environment if needed',
        '6. Test with: npm run secrets:verify',
        '7. Deactivate old service account'
      ],
      security_note: 'This is the most critical rotation - handle with care'
    };
    
    await auditLogger.logSecurityEvent('OP_TOKEN_ROTATION_REQUESTED', {
      manual_intervention_required: true,
      critical: true,
      instructions
    });
    
    return { 
      success: false, 
      manual_required: true,
      critical: true,
      instructions
    };
  }

  /**
   * Get appropriate rotator for token type
   */
  getRotator(tokenType) {
    const rotatorMap = {
      'JWT_SECRET': this.rotateJwtSecret.bind(this),
      'RAILWAY_TOKEN': this.rotateRailwayToken.bind(this),
      'N8N_API_KEY': this.rotateN8nApiKey.bind(this),
      'OP_SERVICE_ACCOUNT_TOKEN': this.rotateOnePasswordToken.bind(this)
    };
    
    return rotatorMap[tokenType] || null;
  }

  /**
   * Rotate a specific token
   */
  async rotateToken(tokenType) {
    const config = this.rotationConfig[tokenType];
    if (!config) {
      throw new Error(`Unknown token type: ${tokenType}`);
    }
    
    console.log(`🔄 Starting rotation for ${tokenType}...`);
    
    await auditLogger.logSecurityEvent('TOKEN_ROTATION_STARTED', {
      token_type: tokenType,
      scheduled: config.next,
      critical: config.critical
    });
    
    try {
      const rotator = this.getRotator(tokenType);
      if (!rotator) {
        throw new Error(`No rotator available for ${tokenType}`);
      }
      
      const result = await rotator();
      
      if (result.success) {
        // Update next rotation date
        config.next = this.calculateNextRotation(config.interval);
        config.last_rotated = new Date().toISOString();
        this.saveRotationConfig();
        
        await auditLogger.logSecurityEvent('TOKEN_ROTATION_COMPLETED', {
          token_type: tokenType,
          next_rotation: config.next
        });
        
        console.log(`✅ ${tokenType} rotation completed successfully`);
      } else if (result.manual_required) {
        // Schedule manual reminder
        config.manual_reminder = new Date().toISOString();
        this.saveRotationConfig();
        
        console.log(`⚠️  ${tokenType} requires manual rotation`);
        console.log('Instructions:', result.instructions);
      }
      
      return result;
    } catch (error) {
      await auditLogger.logSecurityEvent('TOKEN_ROTATION_FAILED', {
        token_type: tokenType,
        error: error.message
      });
      
      console.error(`❌ ${tokenType} rotation failed:`, error.message);
      throw error;
    }
  }

  /**
   * Rotate all tokens that need rotation
   */
  async rotateAllDue() {
    console.log('🔄 Checking for tokens needing rotation...');
    
    const needRotation = this.getTokensNeedingRotation();
    
    if (needRotation.length === 0) {
      console.log('✅ No tokens need rotation at this time');
      return { success: true, rotated: 0, manual: 0 };
    }
    
    console.log(`Found ${needRotation.length} tokens needing rotation:`, needRotation);
    
    const results = {
      success: true,
      rotated: 0,
      manual: 0,
      failed: 0,
      details: []
    };
    
    for (const tokenType of needRotation) {
      try {
        const result = await this.rotateToken(tokenType);
        
        if (result.success) {
          results.rotated++;
        } else if (result.manual_required) {
          results.manual++;
        }
        
        results.details.push({
          token: tokenType,
          ...result
        });
      } catch (error) {
        results.failed++;
        results.success = false;
        results.details.push({
          token: tokenType,
          success: false,
          error: error.message
        });
      }
    }
    
    await auditLogger.logSecurityEvent('BATCH_TOKEN_ROTATION_COMPLETED', results);
    
    return results;
  }

  /**
   * Get rotation status for all tokens
   */
  getRotationStatus() {
    const status = {};
    const now = new Date();
    
    for (const [tokenType, config] of Object.entries(this.rotationConfig)) {
      const daysUntilRotation = config.next ? 
        Math.ceil((new Date(config.next) - now) / (24 * 60 * 60 * 1000)) : null;
      
      status[tokenType] = {
        next_rotation: config.next,
        days_until_rotation: daysUntilRotation,
        interval_days: config.interval,
        critical: config.critical,
        manual_only: config.manual_only,
        last_rotated: config.last_rotated,
        needs_rotation: daysUntilRotation !== null && daysUntilRotation <= 0,
        overdue: daysUntilRotation !== null && daysUntilRotation < -7 // More than 7 days overdue
      };
    }
    
    return status;
  }

  /**
   * Force rotation of a specific token (emergency use)
   */
  async forceRotation(tokenType, reason = 'Emergency rotation') {
    console.log(`🚨 Force rotating ${tokenType} - Reason: ${reason}`);
    
    await auditLogger.logSecurityEvent('FORCE_TOKEN_ROTATION', {
      token_type: tokenType,
      reason,
      emergency: true
    });
    
    return this.rotateToken(tokenType);
  }

  /**
   * Schedule next rotation for a token
   */
  async scheduleRotation(tokenType, customInterval = null) {
    const config = this.rotationConfig[tokenType];
    if (!config) {
      throw new Error(`Unknown token type: ${tokenType}`);
    }
    
    const interval = customInterval || config.interval;
    config.next = this.calculateNextRotation(interval);
    
    this.saveRotationConfig();
    
    await auditLogger.logSecurityEvent('TOKEN_ROTATION_SCHEDULED', {
      token_type: tokenType,
      next_rotation: config.next,
      interval_days: interval
    });
    
    console.log(`📅 Scheduled ${tokenType} rotation for ${config.next}`);
    
    return config.next;
  }

  /**
   * Test token rotation system
   */
  async testRotationSystem() {
    console.log('🧪 Testing token rotation system...');
    
    const tests = [
      {
        name: 'Configuration Loading',
        test: () => this.loadRotationConfig()
      },
      {
        name: 'Status Check',
        test: () => this.getRotationStatus()
      },
      {
        name: 'Due Check',
        test: () => this.getTokensNeedingRotation()
      },
      {
        name: 'Schedule Calculation',
        test: () => this.calculateNextRotation(90)
      }
    ];
    
    const results = [];
    
    for (const test of tests) {
      try {
        const result = test.test();
        results.push({
          name: test.name,
          success: true,
          result: typeof result === 'object' ? 'Object returned' : result
        });
      } catch (error) {
        results.push({
          name: test.name,
          success: false,
          error: error.message
        });
      }
    }
    
    await auditLogger.logSecurityEvent('ROTATION_SYSTEM_TEST', { results });
    
    return results;
  }
}

// Export singleton instance
export const tokenRotationManager = new TokenRotationManager();

// Helper functions for easy integration
export async function initializeRotations() {
  return tokenRotationManager.initializeRotationSchedules();
}

export async function rotateToken(tokenType) {
  return tokenRotationManager.rotateToken(tokenType);
}

export async function rotateDueTokens() {
  return tokenRotationManager.rotateAllDue();
}

export function getRotationStatus() {
  return tokenRotationManager.getRotationStatus();
}

export async function forceRotateToken(tokenType, reason) {
  return tokenRotationManager.forceRotation(tokenType, reason);
}