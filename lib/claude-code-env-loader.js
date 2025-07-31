/**
 * Claude Code Environment Loader
 * 
 * Automatically loads environment variables from 1Password
 * This ensures Claude Code has access to all secrets in any session
 * 
 * USAGE:
 * - Auto-loads on import: import './lib/claude-code-env-loader.js'
 * - Manual load: // Environment loaded automatically by deployment-control service
 * - Get Railway token: await envLoader.ensureRailwayToken()
 * 
 * PERSISTENCE:
 * - Reads from 1Password (requires op CLI and auth)
 * - Falls back to GitHub Codespace secrets
 * - Caches loaded values in process.env
 */

import { execSync } from 'child_process';
import { deploymentClient } from './lib/deployment-client.js';

export class ClaudeCodeEnvLoader {
  constructor() {
    this.vault = 'enterprise-ai-automation-n8n';
    this.loaded = false;
  }

  /**
   * Load all environment variables from 1Password
   * 
   * 🚨 CRITICAL: This is the ONLY way to load secrets
   * - NO .env files allowed
   * - NO dotenv.config() allowed
   * - 1Password is the SINGLE source of truth
   * 
   * If this fails, API keys will be undefined and cause errors like:
   * "The OPENAI_API_KEY environment variable is missing or empty"
   */
  async loadEnvironment() {
    if (this.loaded) {
      console.log('✅ Environment already loaded');
      return true;
    }

    console.log('🔐 Loading environment from 1Password...');

    try {
      // Check if 1Password CLI is available
      execSync('op --version', { stdio: 'ignore' });
    } catch (error) {
      console.error('❌ 1Password CLI not available');
      return false;
    }

    // Check if authenticated
    try {
      execSync('op account get', { stdio: 'ignore' });
    } catch (error) {
      console.error('❌ Not authenticated with 1Password');
      console.error('Run: eval $(op signin)');
      return false;
    }

    // Load each environment variable
    const variables = {
      N8N_BASE_URL: this.loadSecret('prod-n8n-base-url-railway', 'url'),
      N8N_API_KEY: this.loadSecret('prod-n8n-apikey-railway', 'API Key'),
      OPENAI_API_KEY: this.loadSecret('prod-openai-apikey-railway', 'OpenAI API Key'),
      ANTHROPIC_API_KEY: this.loadSecret('prod-anthropic-apikey-railway', 'Anthropic API Key'),
      SUPABASE_URL: this.loadSecret('prod-supabase-config-railway', 'Supabase URL'),
      SUPABASE_ANON_KEY: this.loadSecret('prod-supabase-config-railway', 'Supabase Anon Key'),
      SUPABASE_SERVICE_ROLE_KEY: this.loadSecret('prod-supabase-config-railway', 'Supabase Service Key'),
      JWT_SECRET: this.loadSecret('prod-jwt-secret-railway', 'secret'),
      RAILWAY_TOKEN: this.loadSecret('prod-railway-apitoken-deployment', 'API token'),
      NODE_ENV: this.loadSecret('prod-security-config-railway', 'node env') || 'production',
      ALLOWED_ORIGINS: this.loadSecret('prod-security-config-railway', 'allowed origins')
    };

    // Set environment variables
    let loadedCount = 0;
    for (const [key, value] of Object.entries(variables)) {
      if (value && !value.includes('[use \'op')) {
        process.env[key] = value;
        loadedCount++;
      }
    }

    console.log(`✅ Loaded ${loadedCount} environment variables from 1Password`);
    this.loaded = true;
    return true;
  }

  /**
   * Load a specific secret from 1Password
   */
  loadSecret(itemName, fieldName) {
    try {
      const result = execSync(
        `op read "op://${this.vault}/${itemName}/${fieldName}" 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      
      return result || null;
    } catch (error) {
      // Try alternate method
      try {
        const result = execSync(
          `op item get "${itemName}" --vault="${this.vault}" --field "${fieldName}" 2>/dev/null`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        
        return result || null;
      } catch (error2) {
        return null;
      }
    }
  }

  /**
   * Ensure Railway token is available
   */
  async ensureRailwayToken() {
    // First try environment variable
    if (process.env.RAILWAY_TOKEN) {
      return process.env.RAILWAY_TOKEN;
    }

    // Try loading from 1Password
    await this.loadEnvironment();
    
    if (process.env.RAILWAY_TOKEN) {
      return process.env.RAILWAY_TOKEN;
    }

    // Check GitHub Codespace secret
    // This is already loaded by Codespace if it exists
    
    console.error('❌ Railway token not available');
    console.error('Add it to:');
    console.error('1. GitHub Codespace secrets (recommended)');
    console.error('2. 1Password: prod-railway-apitoken-deployment');
    
    return null;
  }
}

// Create singleton instance
export const envLoader = new ClaudeCodeEnvLoader();

// Auto-load on import
// Environment loaded automatically by deployment-control service.catch(console.error);

// Export helper function for easy use
export async function ensureEnvironment() {
  return // Environment loaded automatically by deployment-control service;
}