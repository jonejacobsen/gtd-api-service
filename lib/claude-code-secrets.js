/**
 * Claude Code Secret Management
 * 
 * This module provides persistent secret access for Claude Code
 * across all sessions. It automatically handles 1Password integration.
 */

import { deploymentClient } from './deployment-client.js';
import { SECRET_REGISTRY, get1PasswordItemForEnvVar } from '../config/secret-registry.js';

class ClaudeCodeSecrets {
  constructor() {
    this.opManager = null;
    this._initialized = false;
    this._cache = new Map();
    this._cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Initialize 1Password connection
   */
  async init() {
    if (this._initialized) return true;

    if (!process.env.DEPLOYMENT_API_KEY) {
      console.warn('1Password service account not configured');
      return false;
    }

    try {
      this.opManager = deploymentClient;
      const signedIn = await this.opManager.ensureSignedIn();
      this._initialized = signedIn;
      return signedIn;
    } catch (error) {
      console.error('Failed to initialize 1Password:', error.message);
      return false;
    }
  }

  /**
   * Get a secret value by environment variable name
   */
  async get(envVarName) {
    await this.init();
    
    // Check cache first
    const cached = this._cache.get(envVarName);
    if (cached && Date.now() - cached.timestamp < this._cacheTimeout) {
      return cached.value;
    }

    // Find the 1Password item for this env var
    const itemInfo = get1PasswordItemForEnvVar(envVarName);
    if (!itemInfo) {
      throw new Error(`No 1Password mapping found for ${envVarName}`);
    }

    try {
      const value = await this.process.env[itemInfo.itemName, itemInfo.fieldName] // Managed by deployment-control service;
      
      // Cache the result
      this._cache.set(envVarName, {
        value,
        timestamp: Date.now()
      });
      
      return value;
    } catch (error) {
      console.error(`Failed to get ${envVarName}:`, error.message);
      return null;
    }
  }

  /**
   * Set a secret value
   */
  async set(envVarName, value) {
    await this.init();

    const itemInfo = get1PasswordItemForEnvVar(envVarName);
    if (!itemInfo) {
      throw new Error(`No 1Password mapping found for ${envVarName}`);
    }

    try {
      await this.opManager.updateSecret(itemInfo.itemName, itemInfo.fieldName, value);
      
      // Clear cache
      this._cache.delete(envVarName);
      
      return true;
    } catch (error) {
      console.error(`Failed to set ${envVarName}:`, error.message);
      return false;
    }
  }

  /**
   * Load all secrets for a service
   */
  async loadService(serviceName) {
    await this.init();
    
    try {
      const secrets = await this.opManager.loadSecretsForService(serviceName);
      
      // Cache all loaded secrets
      for (const [key, value] of Object.entries(secrets)) {
        this._cache.set(key, {
          value,
          timestamp: Date.now()
        });
      }
      
      return secrets;
    } catch (error) {
      console.error(`Failed to load secrets for ${serviceName}:`, error.message);
      return {};
    }
  }

  /**
   * Get all available secrets
   */
  async getAll() {
    await this.init();
    
    try {
      const allVars = await this.opManager.getAllEnvironmentVariables();
      
      // Cache everything
      for (const [key, value] of Object.entries(allVars)) {
        this._cache.set(key, {
          value,
          timestamp: Date.now()
        });
      }
      
      return allVars;
    } catch (error) {
      console.error('Failed to get all secrets:', error.message);
      return {};
    }
  }

  /**
   * Verify service has all required secrets
   */
  async verifyService(serviceName) {
    await this.init();
    
    try {
      return await this.opManager.verifyServiceSecrets(serviceName);
    } catch (error) {
      console.error(`Failed to verify ${serviceName}:`, error.message);
      return null;
    }
  }

  /**
   * Create missing secrets with placeholders
   */
  async ensureSecrets() {
    await this.init();
    
    try {
      return await this.opManager.ensureAllSecrets();
    } catch (error) {
      console.error('Failed to ensure secrets:', error.message);
      return { created: [], existing: [], errors: [error.message] };
    }
  }
}

// Export singleton instance
export const secrets = new ClaudeCodeSecrets();

// Also export for direct use
export async function getSecret(envVarName) {
  return secrets.get(envVarName);
}

export async function setSecret(envVarName, value) {
  return secrets.set(envVarName, value);
}

export async function loadServiceSecrets(serviceName) {
  return secrets.loadService(serviceName);
}

export async function getAllSecrets() {
  return secrets.getAll();
}