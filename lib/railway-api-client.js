/**
 * Railway API Client
 * 
 * Provides full programmatic control over Railway deployments
 * This replaces the CLI for AI-driven automation
 * 
 * Features:
 * - Environment variable management
 * - Service deployment and monitoring
 * - Log retrieval
 * - Health checks
 * - Full integration with 1Password
 */

import fetch from 'node-fetch';
import { execSync } from 'child_process';
import { deploymentClient } from './deployment-client.js';
import { get1PasswordItemForEnvVar } from '../config/secret-registry.js';
// Environment now loaded via deployment-control service;

export class RailwayAPIClient {
  constructor(token = null) {
    this.baseURL = 'https://backboard.railway.com/graphql/v2'; // Fixed: .com not .app!
    this.token = token || process.env.RAILWAY_TOKEN;
    this.projectId = '59af76f0-bc01-4e5d-b2ec-5472ea4d7b02'; // Core AI Automation n8n Services
    this.environmentId = 'd48493bd-94e2-4189-bdf8-a7f45049e0b1'; // production environment ID
    
    // Note: Token loading happens lazily in ensureToken() when needed
    
    // Try to load from local config (override defaults if found)
    try {
      const config = JSON.parse(
        execSync('cat .railway/config.json 2>/dev/null || echo "{}"', { encoding: 'utf8' })
      );
      if (config.projectId) this.projectId = config.projectId;
      if (config.environmentId) this.environmentId = config.environmentId;
    } catch (e) {
      // Config not found, using defaults
    }
  }

  /**
   * Ensure Railway token is available
   */
  async ensureToken() {
    if (!this.token) {
      this.token = await envLoader.ensureRailwayToken();
    }
    return this.token;
  }

  /**
   * Make GraphQL request to Railway API
   */
  async graphql(query, variables = {}) {
    // Ensure we have a token
    await this.ensureToken();
    
    if (!this.token) {
      throw new Error('Railway token not configured. Set RAILWAY_TOKEN or pass to constructor.');
    }

    // Check if this is a project token (UUID format)
    const isProjectToken = this.token.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    
    const headers = {
      'Content-Type': 'application/json',
    };
    
    // Project tokens use different header
    if (isProjectToken) {
      headers['Project-Access-Token'] = this.token;
    } else {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    
    const response = await fetch(this.baseURL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables })
    });

    const data = await response.json();
    
    if (data.errors) {
      console.error('Railway API errors:', data.errors);
      throw new Error(`Railway API error: ${data.errors[0]?.message || 'Unknown error'}`);
    }

    return data.data;
  }

  /**
   * Get all services in the project
   */
  async getServices() {
    const query = `
      query GetServices($projectId: String!) {
        project(id: $projectId) {
          services {
            edges {
              node {
                id
                name
                createdAt
              }
            }
          }
        }
      }
    `;

    const data = await this.graphql(query, { projectId: this.projectId });
    return data.project.services.edges.map(edge => edge.node);
  }

  /**
   * Get service by name
   */
  async getServiceByName(name) {
    const services = await this.getServices();
    return services.find(s => s.name === name);
  }

  /**
   * Get all variables for a service
   */
  async getVariables(serviceId) {
    const query = `
      query GetVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
          items
        }
      }
    `;

    const data = await this.graphql(query, {
      projectId: this.projectId,
      environmentId: this.environmentId,
      serviceId
    });

    return data.variables.items;
  }

  /**
   * Set a variable for a service
   */
  async setVariable(serviceName, key, value) {
    // Get service ID
    const service = await this.getServiceByName(serviceName);
    if (!service) {
      throw new Error(`Service '${serviceName}' not found`);
    }

    const mutation = `
      mutation SetVariable($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `;

    await this.graphql(mutation, {
      input: {
        projectId: this.projectId,
        environmentId: this.environmentId,
        serviceId: service.id,
        name: key,
        value: value
      }
    });

    console.log(`✅ Set ${key} for ${serviceName}`);
    return true;
  }

  /**
   * Delete a variable
   */
  async deleteVariable(serviceName, key) {
    const service = await this.getServiceByName(serviceName);
    if (!service) {
      throw new Error(`Service '${serviceName}' not found`);
    }

    const mutation = `
      mutation DeleteVariable($input: VariableDeleteInput!) {
        variableDelete(input: $input)
      }
    `;

    await this.graphql(mutation, {
      input: {
        projectId: this.projectId,
        environmentId: this.environmentId,
        serviceId: service.id,
        name: key
      }
    });

    console.log(`✅ Deleted ${key} from ${serviceName}`);
    return true;
  }

  /**
   * Sync all variables from 1Password to Railway
   */
  async syncFrom1Password(serviceName, variables) {
    const opManager = deploymentClient;
    await opManager.ensureSignedIn();

    console.log(`🔄 Syncing ${variables.length} variables to ${serviceName}...`);

    for (const varName of variables) {
      try {
        // Get 1Password mapping
        const mapping = get1PasswordItemForEnvVar(varName);
        if (!mapping) {
          console.log(`⚠️  No 1Password mapping for ${varName}`);
          continue;
        }

        // Get value from 1Password
        const value = await process.env[
          mapping.itemName,
          mapping.fieldName
        ] // Managed by deployment-control service;

        if (!value || value.includes('[use \'op')) {
          console.log(`⚠️  Skipping ${varName} - placeholder value`);
          continue;
        }

        // Set in Railway
        await this.setVariable(serviceName, varName, value);
        console.log(`✅ Synced ${varName}`);

      } catch (error) {
        console.error(`❌ Failed to sync ${varName}:`, error.message);
      }
    }
  }

  /**
   * Redeploy a service
   */
  async redeployService(serviceName) {
    const service = await this.getServiceByName(serviceName);
    if (!service) {
      throw new Error(`Service '${serviceName}' not found`);
    }

    const mutation = `
      mutation Redeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;

    await this.graphql(mutation, {
      serviceId: service.id,
      environmentId: this.environmentId
    });

    console.log(`🚀 Redeployed ${serviceName}`);
    return true;
  }

  /**
   * Get deployment status
   */
  async getDeploymentStatus(serviceName) {
    const service = await this.getServiceByName(serviceName);
    if (!service) {
      throw new Error(`Service '${serviceName}' not found`);
    }

    const query = `
      query GetDeployments($serviceId: String!, $environmentId: String!) {
        deployments(
          first: 1,
          input: {
            serviceId: $serviceId,
            environmentId: $environmentId
          }
        ) {
          edges {
            node {
              id
              status
              createdAt
              meta
            }
          }
        }
      }
    `;

    const data = await this.graphql(query, {
      serviceId: service.id,
      environmentId: this.environmentId
    });

    const deployment = data.deployments.edges[0]?.node;
    return deployment || null;
  }

  /**
   * Wait for deployment to complete
   */
  async waitForDeployment(serviceName, timeoutMs = 300000) {
    console.log(`⏳ Waiting for ${serviceName} deployment...`);
    
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const deployment = await this.getDeploymentStatus(serviceName);
      
      if (!deployment) {
        throw new Error('No deployment found');
      }

      console.log(`   Status: ${deployment.status}`);

      if (deployment.status === 'SUCCESS') {
        console.log(`✅ Deployment successful!`);
        return true;
      }

      if (deployment.status === 'FAILED' || deployment.status === 'CRASHED') {
        throw new Error(`Deployment failed with status: ${deployment.status}`);
      }

      // Wait 5 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error('Deployment timeout');
  }

  /**
   * Get service logs
   */
  async getLogs(serviceName, lines = 100) {
    const service = await this.getServiceByName(serviceName);
    if (!service) {
      throw new Error(`Service '${serviceName}' not found`);
    }

    const query = `
      query GetLogs($serviceId: String!, $environmentId: String!, $lines: Int!) {
        logs(
          serviceId: $serviceId,
          environmentId: $environmentId,
          lines: $lines
        ) {
          data
        }
      }
    `;

    const data = await this.graphql(query, {
      serviceId: service.id,
      environmentId: this.environmentId,
      lines
    });

    return data.logs.data;
  }

  /**
   * Full deployment pipeline
   */
  async deployWithSecrets(serviceName, additionalVars = {}) {
    console.log(`🚀 Starting automated deployment for ${serviceName}`);
    
    // 1. Get required variables from config
    const { SERVICE_REQUIREMENTS } = await import('../config/secret-registry.js');
    const requirements = SERVICE_REQUIREMENTS[serviceName] || { required: [], optional: [] };
    const allVars = [...requirements.required, ...requirements.optional];

    // 2. Sync from 1Password
    await this.syncFrom1Password(serviceName, allVars);

    // 3. Set additional variables
    for (const [key, value] of Object.entries(additionalVars)) {
      await this.setVariable(serviceName, key, value);
    }

    // 4. Redeploy
    await this.redeployService(serviceName);

    // 5. Wait for deployment
    await this.waitForDeployment(serviceName);

    // 6. Check logs for errors
    const logs = await this.getLogs(serviceName, 50);
    console.log('📜 Recent logs:', logs.slice(-500));

    console.log(`✅ Deployment complete for ${serviceName}`);
  }
}