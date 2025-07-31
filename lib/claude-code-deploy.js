/**
 * Claude Code Deployment Interface
 * 
 * Simplified interface for Claude Code to manage deployments
 * Handles all the complexity of Railway API and 1Password integration
 */

import { RailwayAPIClient } from './railway-api-client.js';
import { getSecret, getAllSecrets } from './claude-code-secrets.js';
import { AIDeploymentPipeline } from '../scripts/ai-deploy-pipeline.js';
import chalk from 'chalk';
import { deploymentClient } from './lib/deployment-client.js';

export class ClaudeCodeDeploy {
  constructor() {
    this.railway = new RailwayAPIClient();
    this.pipeline = new AIDeploymentPipeline();
  }

  /**
   * Set a single environment variable
   */
  async setVariable(service, name, value) {
    try {
      await this.railway.setVariable(service, name, value);
      return { success: true, message: `Set ${name} for ${service}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set multiple variables at once
   */
  async setVariables(service, variables) {
    const results = [];
    
    for (const [name, value] of Object.entries(variables)) {
      const result = await this.setVariable(service, name, value);
      results.push({ name, ...result });
    }
    
    return results;
  }

  /**
   * Get all variables for a service
   */
  async getVariables(service) {
    try {
      const serviceObj = await this.railway.getServiceByName(service);
      if (!serviceObj) {
        throw new Error(`Service ${service} not found`);
      }
      
      const vars = await this.railway.getVariables(serviceObj.id);
      return { success: true, variables: vars };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync security configuration from 1Password
   */
  async syncSecurity(service = 'backend-supabase') {
    console.log('🔐 Syncing security configuration...');
    
    try {
      // Get security values from 1Password
      const securityConfig = {
        NODE_ENV: process.env['NODE_ENV'] // Managed by deployment-control service || 'production',
        ALLOWED_ORIGINS: process.env['ALLOWED_ORIGINS'] // Managed by deployment-control service,
        JWT_SECRET: process.env['JWT_SECRET'] // Managed by deployment-control service
      };

      // Filter out invalid values
      const validConfig = {};
      for (const [key, value] of Object.entries(securityConfig)) {
        if (value && !value.includes('[use \'op')) {
          validConfig[key] = value;
        }
      }

      // Set variables
      const results = await this.setVariables(service, validConfig);
      
      return { 
        success: true, 
        synced: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        details: results
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Deploy a service with full pipeline
   */
  async deploy(service = 'backend-supabase') {
    console.log(`🚀 Deploying ${service}...`);
    
    try {
      // Use the full pipeline
      await this.pipeline.run();
      return { success: true, message: 'Deployment successful' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Quick deploy - just redeploy without full pipeline
   */
  async quickDeploy(service = 'backend-supabase') {
    try {
      await this.railway.redeployService(service);
      return { success: true, message: `Redeployed ${service}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get deployment status
   */
  async status(service = 'backend-supabase') {
    try {
      const deployment = await this.railway.getDeploymentStatus(service);
      return { success: true, deployment };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get logs
   */
  async logs(service = 'backend-supabase', lines = 100) {
    try {
      const logs = await this.railway.getLogs(service, lines);
      return { success: true, logs };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Complete security setup
   */
  async setupSecurity() {
    console.log(chalk.blue('🔒 Setting up security configuration...'));
    
    const steps = [
      {
        name: 'Sync security variables',
        action: () => this.syncSecurity()
      },
      {
        name: 'Quick redeploy',
        action: () => this.quickDeploy()
      },
      {
        name: 'Check deployment status',
        action: async () => {
          await new Promise(resolve => setTimeout(resolve, 5000));
          return this.status();
        }
      }
    ];

    const results = [];
    
    for (const step of steps) {
      console.log(`\n${chalk.yellow('📍')} ${step.name}...`);
      const result = await step.action();
      results.push({ step: step.name, ...result });
      
      if (result.success) {
        console.log(chalk.green('✅ Success'));
      } else {
        console.log(chalk.red('❌ Failed:', result.error));
        break;
      }
    }
    
    return results;
  }
}

// Export singleton instance for easy use
export const deployManager = new ClaudeCodeDeploy();

// Usage examples:
/*
import { deployManager } from './lib/claude-code-deploy.js';

// Set security variables and deploy
await deployManager.setupSecurity();

// Just sync variables
await deployManager.syncSecurity();

// Quick redeploy
await deployManager.quickDeploy();

// Check status
const status = await deployManager.status();
console.log(status);

// Get logs
const logs = await deployManager.logs('backend-supabase', 50);
console.log(logs);
*/