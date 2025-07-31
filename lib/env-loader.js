/**
 * Universal Environment Loader
 * 
 * Replaces all direct dotenv usage with a centralized loader that:
 * 1. NEVER loads .env files in production (Railway)
 * 2. Loads from 1Password in development
 * 3. Validates required secrets
 * 4. Provides consistent behavior across all services
 */

import { deploymentClient } from './deployment-client.js';
import { SERVICE_REQUIREMENTS } from '../config/secret-registry.js';

export class EnvLoader {
  /**
   * Load environment variables for a service
   * @param {string} serviceName - Name of the service (e.g., 'backend-supabase-service')
   * @param {object} options - Loading options
   */
  static async load(serviceName = null, options = {}) {
    const { 
      silent = false,
      throwOnMissing = false,
      defaults = {}
    } = options;

    const log = silent ? () => {} : console.log;

    // CRITICAL: Never load .env files in Railway/production
    if (process.env.RAILWAY_ENVIRONMENT) {
      log('✓ Railway environment detected - using injected variables');
      
      // Apply defaults for optional variables
      for (const [key, value] of Object.entries(defaults)) {
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      
      return;
    }

    // In development, load from 1Password
    if (process.env.DEPLOYMENT_API_KEY || process.env.DEPLOYMENT_SERVICE_URL) {
      log('🔐 Loading environment from 1Password...');
      
      try {
        const opManager = deploymentClient;
        const secrets = serviceName 
          ? await opManager.loadSecretsForService(serviceName)
          : await opManager.getAllEnvironmentVariables();
        
        // Load secrets into environment
        let loadedCount = 0;
        for (const [key, value] of Object.entries(secrets)) {
          if (value && value !== 'placeholder') {
            process.env[key] = value;
            loadedCount++;
          }
        }
        
        log(`✅ Loaded ${loadedCount} secrets from 1Password`);
      } catch (error) {
        console.error('⚠️  Failed to load from 1Password:', error.message);
        if (throwOnMissing) {
          throw error;
        }
      }
    } else {
      // Check if op CLI is available for manual signin
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        await execAsync('which op');
        console.warn('⚠️  1Password CLI available but not signed in');
        console.warn('⚠️  Run: eval $(op signin)');
        console.warn('⚠️  Or set OP_SERVICE_ACCOUNT_TOKEN for automated access');
      } catch {
        console.warn('⚠️  1Password CLI not found - secrets not loaded');
        console.warn('⚠️  Install 1Password CLI for local development');
      }
    }

    // Apply defaults
    for (const [key, value] of Object.entries(defaults)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }

    // Validate if requested
    if (serviceName && throwOnMissing) {
      await this.validate(serviceName);
    }
  }

  /**
   * Validate that required secrets are present
   * @param {string} serviceName - Name of the service
   * @throws {Error} if required secrets are missing
   */
  static async validate(serviceName) {
    const requirements = SERVICE_REQUIREMENTS[serviceName];
    
    if (!requirements) {
      console.warn(`⚠️  No requirements defined for service: ${serviceName}`);
      return;
    }

    const missing = [];
    
    // Check required variables
    for (const envVar of requirements.required || []) {
      if (!process.env[envVar]) {
        missing.push(envVar);
      }
    }

    if (missing.length > 0) {
      const message = `Missing required environment variables for ${serviceName}: ${missing.join(', ')}`;
      
      // In production, this is critical
      if (process.env.RAILWAY_ENVIRONMENT) {
        throw new Error(message);
      } else {
        // In development, warn but allow continuation
        console.warn(`⚠️  ${message}`);
        console.warn('⚠️  Some features may not work correctly');
      }
    }

    // Log optional variables that are missing (info only)
    const missingOptional = [];
    for (const envVar of requirements.optional || []) {
      if (!process.env[envVar]) {
        missingOptional.push(envVar);
      }
    }
    
    if (missingOptional.length > 0 && !process.env.RAILWAY_ENVIRONMENT) {
      console.info(`ℹ️  Optional variables not set: ${missingOptional.join(', ')}`);
    }
  }

  /**
   * Get service name from package.json or directory
   */
  static async detectServiceName() {
    try {
      // Try to read package.json
      const { readFile } = await import('fs/promises');
      const packageJson = await readFile('./package.json', 'utf8');
      const pkg = JSON.parse(packageJson);
      
      if (pkg.name) {
        // Map package names to service names
        const serviceMap = {
          'backend-supabase': 'backend-supabase-service',
          'analytics-dashboard': 'analytics-dashboard-service',
          'testing-v2': 'testing-v2-service',
          'main-api-gateway': 'main-api-gateway-service',
          'n8n-automation-testing-framework': 'main-api-gateway-service'
        };
        
        return serviceMap[pkg.name] || pkg.name;
      }
    } catch {
      // Fallback to directory name
      const cwd = process.cwd();
      const parts = cwd.split('/');
      const serviceName = parts[parts.length - 1];
      
      if (serviceName.endsWith('-service')) {
        return serviceName;
      }
    }
    
    return null;
  }

  /**
   * Quick helper for common use case
   */
  static async loadForCurrentService(options = {}) {
    const serviceName = await this.detectServiceName();
    return this.load(serviceName, options);
  }
}

// Common defaults for all services
export const COMMON_DEFAULTS = {
  NODE_ENV: 'development',
  AI_PROVIDER: 'openai',
  AI_MODEL: 'gpt-4',
  PORT: '3000'
};