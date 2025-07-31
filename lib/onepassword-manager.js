/**
 * 1Password Manager
 * 
 * Provides full programmatic control over 1Password entries using the CLI.
 * This implementation uses the 1Password CLI (op) which is already in use
 * by the project, avoiding the need for SDK installation.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { SECRET_REGISTRY, SECRET_GENERATORS, get1PasswordItemForEnvVar } from '../config/secret-registry.js';

const execAsync = promisify(exec);

export class OnePasswordManager {
  constructor() {
    this.vaultName = 'enterprise-ai-automation-n8n';
    this._isSignedIn = null;
  }

  /**
   * Ensure we're signed in to 1Password
   */
  async ensureSignedIn() {
    if (this._isSignedIn) return true;

    try {
      await execAsync('op account get');
      this._isSignedIn = true;
      return true;
    } catch (error) {
      console.error('Not signed in to 1Password. Please run: eval $(op signin)');
      return false;
    }
  }

  /**
   * Check if a secret exists in 1Password
   */
  async secretExists(itemName) {
    if (!await this.ensureSignedIn()) return false;

    try {
      await execAsync(`op item get "${itemName}" --vault="${this.vaultName}" --format=json`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get a secret value from 1Password
   */
  async getSecret(itemName, fieldName) {
    if (!await this.ensureSignedIn()) return null;

    try {
      const { stdout } = await execAsync(
        `op read "op://${this.vaultName}/${itemName}/${fieldName}" 2>/dev/null`
      );
      return stdout.trim();
    } catch (error) {
      // Try alternative field extraction method
      try {
        const { stdout } = await execAsync(
          `op item get "${itemName}" --vault="${this.vaultName}" --fields="label=${fieldName}" --format=json`
        );
        const data = JSON.parse(stdout);
        return data.value;
      } catch (innerError) {
        return null;
      }
    }
  }

  /**
   * Create a new secret in 1Password
   */
  async createSecret(itemName, fields, tags = []) {
    if (!await this.ensureSignedIn()) {
      throw new Error('Not signed in to 1Password');
    }

    // Build field arguments
    const fieldArgs = fields.map(field => {
      const value = field.generator 
        ? SECRET_GENERATORS[field.generator]()
        : field.defaultValue || field.placeholder || '';
      
      const type = field.type === 'CONCEALED' ? 'password' : 'text';
      return `"${field.name}[${type}]=${value}"`;
    }).join(' ');

    // Build tag arguments
    const tagArgs = tags.length > 0 ? `--tags="${tags.join(',')}"` : '';

    try {
      const command = `op item create --category="API Credential" --title="${itemName}" --vault="${this.vaultName}" ${fieldArgs} ${tagArgs}`;
      const { stdout } = await execAsync(command);
      console.log(`✅ Created 1Password item: ${itemName}`);
      return JSON.parse(stdout);
    } catch (error) {
      console.error(`Failed to create item ${itemName}:`, error.message);
      throw error;
    }
  }

  /**
   * Update a secret in 1Password
   */
  async updateSecret(itemName, fieldName, value) {
    if (!await this.ensureSignedIn()) {
      throw new Error('Not signed in to 1Password');
    }

    try {
      const command = `op item edit "${itemName}" --vault="${this.vaultName}" "${fieldName}=${value}"`;
      await execAsync(command);
      console.log(`✅ Updated ${fieldName} in ${itemName}`);
      return true;
    } catch (error) {
      console.error(`Failed to update ${itemName}:`, error.message);
      return false;
    }
  }

  /**
   * Ensure all secrets defined in the registry exist
   */
  async ensureAllSecrets() {
    if (!await this.ensureSignedIn()) {
      throw new Error('Not signed in to 1Password');
    }

    const results = { 
      created: [], 
      existing: [], 
      errors: [],
      placeholders: []
    };

    for (const [category, config] of Object.entries(SECRET_REGISTRY)) {
      for (const [itemName, itemConfig] of Object.entries(config['1password_items'])) {
        try {
          const exists = await this.secretExists(itemName);
          
          if (!exists) {
            // Create with placeholder values
            const tags = ['auto-created', category, ...config.services];
            await this.createSecret(itemName, itemConfig.fields, tags);
            results.created.push(itemName);
            
            // Track which ones need real values
            const hasPlaceholders = itemConfig.fields.some(
              f => f.placeholder && !f.generator
            );
            if (hasPlaceholders) {
              results.placeholders.push(itemName);
            }
          } else {
            results.existing.push(itemName);
          }
        } catch (error) {
          results.errors.push({ name: itemName, error: error.message });
        }
      }
    }

    return results;
  }

  /**
   * Load all secrets for a specific service
   */
  async loadSecretsForService(serviceName) {
    if (!await this.ensureSignedIn()) {
      throw new Error('Not signed in to 1Password');
    }

    const secrets = {};

    // Find all secrets needed by this service
    for (const category of Object.values(SECRET_REGISTRY)) {
      if (!category.services.includes(serviceName)) continue;

      for (const [itemName, itemConfig] of Object.entries(category['1password_items'])) {
        for (const field of itemConfig.fields) {
          if (field.envVar) {
            const value = await this.getSecret(itemName, field.name);
            if (value) {
              secrets[field.envVar] = value;
            }
          }
        }
      }
    }

    return secrets;
  }

  /**
   * Get all environment variables from 1Password
   */
  async getAllEnvironmentVariables() {
    if (!await this.ensureSignedIn()) {
      throw new Error('Not signed in to 1Password');
    }

    const envVars = {};

    for (const category of Object.values(SECRET_REGISTRY)) {
      for (const [itemName, itemConfig] of Object.entries(category['1password_items'])) {
        for (const field of itemConfig.fields) {
          if (field.envVar) {
            const value = await this.getSecret(itemName, field.name);
            if (value) {
              envVars[field.envVar] = value;
            }
          }
        }
      }
    }

    return envVars;
  }

  /**
   * Verify that a service has all required secrets
   */
  async verifyServiceSecrets(serviceName) {
    const { SERVICE_REQUIREMENTS } = await import('../config/secret-registry.js');
    const requirements = SERVICE_REQUIREMENTS[serviceName];
    
    if (!requirements) {
      throw new Error(`No requirements defined for service: ${serviceName}`);
    }

    const results = {
      service: serviceName,
      required: { total: 0, found: 0, missing: [] },
      optional: { total: 0, found: 0, missing: [] }
    };

    // Check required secrets
    for (const envVar of requirements.required) {
      results.required.total++;
      const itemInfo = get1PasswordItemForEnvVar(envVar);
      
      if (itemInfo) {
        const value = await this.getSecret(itemInfo.itemName, itemInfo.fieldName);
        if (value && value !== itemInfo.field.placeholder) {
          results.required.found++;
        } else {
          results.required.missing.push(envVar);
        }
      } else {
        results.required.missing.push(envVar);
      }
    }

    // Check optional secrets
    for (const envVar of requirements.optional) {
      results.optional.total++;
      const itemInfo = get1PasswordItemForEnvVar(envVar);
      
      if (itemInfo) {
        const value = await this.getSecret(itemInfo.itemName, itemInfo.fieldName);
        if (value && value !== itemInfo.field.placeholder) {
          results.optional.found++;
        } else {
          results.optional.missing.push(envVar);
        }
      }
    }

    return results;
  }
}