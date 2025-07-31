/**
 * Deployment Control Client
 * 
 * Simple client for interacting with the deployment control service
 * This abstracts away all the complexity of different API tokens
 */

import fetch from 'node-fetch';

export class DeploymentClient {
  constructor(baseUrl = null, apiKey = null) {
    this.baseUrl = baseUrl || process.env.DEPLOYMENT_SERVICE_URL || 'http://localhost:4000';
    this.apiKey = apiKey || process.env.DEPLOYMENT_API_KEY || 'dev-deployment-key-123';
  }

  async request(endpoint, options = {}) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        ...options.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Deployment service error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // === High-level operations ===

  async deployBackend() {
    console.log('🚀 Deploying backend service...');
    return this.request('/api/railway/deploy', {
      method: 'POST',
      body: JSON.stringify({ service: 'backend-supabase' })
    });
  }

  async getDeploymentStatus() {
    return this.request('/api/railway/status');
  }

  async createWorkflow(workflow) {
    return this.request('/api/n8n/workflow/create', {
      method: 'POST',
      body: JSON.stringify({ workflow })
    });
  }

  async querySupabase(table, operation = 'select', data = null) {
    return this.request('/api/supabase/query', {
      method: 'POST',
      body: JSON.stringify({ table, operation, data })
    });
  }

  async deployAll() {
    console.log('🚀 Running full deployment...');
    return this.request('/api/deploy/all', {
      method: 'POST'
    });
  }

  async checkConfig() {
    return this.request('/api/config');
  }

  async healthCheck() {
    return this.request('/health');
  }

  async sendEmail(emailData) {
    return this.request('/api/resend/send-email', {
      method: 'POST',
      body: JSON.stringify(emailData)
    });
  }

  async getOpenAIKey() {
    return this.request('/api/openai/key');
  }

  async getAnthropicKey() {
    return this.request('/api/anthropic/key');
  }

  async getSupabaseInfo() {
    return this.request('/api/supabase/info');
  }
}

// Singleton instance for easy use
export const deploymentClient = new DeploymentClient();

// Example usage:
/*
import { deploymentClient } from './lib/deployment-client.js';

// Deploy backend
await deploymentClient.deployBackend();

// Check status
const status = await deploymentClient.getDeploymentStatus();

// Create n8n workflow
await deploymentClient.createWorkflow(myWorkflow);

// Query Supabase
const users = await deploymentClient.querySupabase('users');

// Send email via Resend
await deploymentClient.sendEmail({
  to: 'user@example.com',
  subject: 'Welcome!',
  html: '<p>Hello from deployment control!</p>'
});
*/