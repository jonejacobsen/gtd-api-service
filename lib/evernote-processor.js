import { parseString } from 'xml2js';
import { promisify } from 'util';
import crypto from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { gtdDB } from './gtd-database-client.js';

const parseXML = promisify(parseString);

export class EvernoteProcessor {
  constructor() {
    this.migrationId = `migration_${Date.now()}`;
    this.stats = {
      total: 0,
      processed: 0,
      failed: 0,
      errors: []
    };
  }

  async initMigration() {
    await gtdDB.query(`
      INSERT INTO migration_progress (migration_id, status, started_at)
      VALUES ($1, 'running', NOW())
      ON CONFLICT (migration_id) DO UPDATE
      SET status = 'running', started_at = NOW()
    `, [this.migrationId]);
  }

  async processENEXContent(enexContent) {
    console.log('📝 Processing ENEX content...');
    
    try {
      // Parse XML
      const result = await parseXML(enexContent, { 
        explicitArray: false,
        ignoreAttrs: false
      });

      if (!result['en-export']) {
        throw new Error('Invalid ENEX format: missing en-export root');
      }

      const notes = Array.isArray(result['en-export'].note) 
        ? result['en-export'].note 
        : [result['en-export'].note].filter(Boolean);

      this.stats.total = notes.length;
      console.log(`📊 Found ${notes.length} notes to process`);

      // Process notes in batches
      const batchSize = 10;
      for (let i = 0; i < notes.length; i += batchSize) {
        const batch = notes.slice(i, i + batchSize);
        await Promise.all(batch.map(note => this.processNote(note)));
        
        // Update progress
        await gtdDB.updateMigrationProgress(this.migrationId, {
          total_files: this.stats.total,
          processed_files: this.stats.processed,
          failed_files: this.stats.failed
        });
      }

      // Mark migration as completed
      await gtdDB.updateMigrationProgress(this.migrationId, {
        status: 'completed',
        completed_at: new Date()
      });

      return this.stats;
    } catch (error) {
      console.error('❌ Error processing ENEX:', error);
      await gtdDB.updateMigrationProgress(this.migrationId, {
        status: 'failed',
        error_log: [...this.stats.errors, error.message]
      });
      throw error;
    }
  }

  async processNote(note) {
    try {
      // Extract basic fields
      const title = note.title || 'Untitled Note';
      const content = this.extractContent(note.content);
      const created = this.parseDate(note.created);
      const updated = this.parseDate(note.updated);
      
      // Extract tags for GTD contexts
      const tags = this.extractTags(note);
      const gtdContexts = this.extractGTDContexts(tags);
      const gtdProject = this.extractGTDProject(tags);
      const gtdArea = this.extractGTDArea(tags);
      
      // Generate or extract source ID
      const sourceId = note.$?.guid || 
                      note['note-attributes']?.['source-guid'] || 
                      this.generateSourceId(title, created);
      
      // Extract note attributes
      const attributes = note['note-attributes'] || {};
      const metadata = {
        original_tags: tags,
        source_url: attributes['source-url'],
        author: attributes.author,
        location: attributes.latitude && attributes.longitude ? {
          lat: parseFloat(attributes.latitude),
          lng: parseFloat(attributes.longitude)
        } : null,
        reminder: attributes['reminder-order'] || attributes['reminder-time'],
        evernote_attributes: attributes
      };

      // Insert or update document
      const doc = await gtdDB.query(`
        INSERT INTO documents 
        (source_id, title, content, gtd_contexts, gtd_project, gtd_area, 
         source_type, created_at, updated_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (source_id) DO UPDATE
        SET 
          content = EXCLUDED.content,
          gtd_contexts = EXCLUDED.gtd_contexts,
          gtd_project = EXCLUDED.gtd_project,
          gtd_area = EXCLUDED.gtd_area,
          updated_at = EXCLUDED.updated_at,
          metadata = EXCLUDED.metadata
        RETURNING id
      `, [sourceId, title, content, gtdContexts, gtdProject, gtdArea, 
          'evernote', created, updated, JSON.stringify(metadata)]);

      const docId = doc.rows[0].id;

      // Process resources (attachments)
      if (note.resource) {
        const resources = Array.isArray(note.resource) ? note.resource : [note.resource];
        for (const resource of resources) {
          await this.processResource(resource, docId);
        }
      }

      // Add to embedding queue
      await gtdDB.addToEmbeddingQueue(docId);

      this.stats.processed++;
      console.log(`✓ Processed: ${title}`);
    } catch (error) {
      console.error(`❌ Failed to process note: ${note.title}`, error);
      this.stats.failed++;
      this.stats.errors.push({
        note: note.title,
        error: error.message
      });
    }
  }

  extractContent(contentElement) {
    if (!contentElement) return '';
    
    // Decode CDATA content
    let html = contentElement;
    if (typeof contentElement === 'object' && contentElement._) {
      html = contentElement._;
    }
    
    // Convert ENML to HTML
    html = html
      .replace(/<en-note[^>]*>/g, '<div>')
      .replace(/<\/en-note>/g, '</div>')
      .replace(/<en-media[^>]*\/>/g, '[Attachment]')
      .replace(/<en-todo[^>]*\/>/g, '☐ ')
      .replace(/<en-todo[^>]*checked="true"[^>]*\/>/g, '☑ ');
    
    // Sanitize and extract text
    const text = sanitizeHtml(html, {
      allowedTags: [],
      allowedAttributes: {},
      textFilter: (text) => {
        return text.replace(/\s+/g, ' ').trim();
      }
    });
    
    return text;
  }

  extractTags(note) {
    if (!note.tag) return [];
    const tags = Array.isArray(note.tag) ? note.tag : [note.tag];
    return tags.map(tag => typeof tag === 'string' ? tag : tag._).filter(Boolean);
  }

  extractGTDContexts(tags) {
    // Look for @context tags
    const contexts = tags
      .filter(tag => tag.startsWith('@') || tag.match(/^(computer|phone|office|home|errands|waiting|someday)/i))
      .map(tag => tag.startsWith('@') ? tag : `@${tag.toLowerCase()}`);
    
    // Add default context if none found
    if (contexts.length === 0) {
      contexts.push('@inbox');
    }
    
    return contexts;
  }

  extractGTDProject(tags) {
    // Look for project tags (e.g., "Project: X" or "project-x")
    const projectTag = tags.find(tag => 
      tag.toLowerCase().includes('project') || 
      tag.startsWith('p:') ||
      tag.match(/^[A-Z][A-Za-z\s]+Project$/)
    );
    
    if (projectTag) {
      return projectTag
        .replace(/^(project[:\s-]*|p:)/i, '')
        .trim();
    }
    
    return null;
  }

  extractGTDArea(tags) {
    // Look for area tags (e.g., "Area: Finance" or "area-health")
    const areaTag = tags.find(tag => 
      tag.toLowerCase().includes('area') || 
      tag.startsWith('a:') ||
      ['personal', 'work', 'health', 'finance', 'family', 'learning'].includes(tag.toLowerCase())
    );
    
    if (areaTag) {
      return areaTag
        .replace(/^(area[:\s-]*|a:)/i, '')
        .trim();
    }
    
    return null;
  }

  async processResource(resource, documentId) {
    try {
      const mime = resource.mime || 'application/octet-stream';
      const filename = resource.$?.['file-name'] || 
                      resource['resource-attributes']?.['file-name'] || 
                      `attachment_${Date.now()}`;
      
      const data = resource.data;
      let fileSize = 0;
      let storagePath = '';
      
      if (data && data._) {
        // Base64 encoded data
        const buffer = Buffer.from(data._, data.$.encoding || 'base64');
        fileSize = buffer.length;
        
        // For now, store reference to the data
        // In production, upload to cloud storage
        storagePath = `evernote://resource/${resource.$?.hash || crypto.randomBytes(16).toString('hex')}`;
      }
      
      const recognition = resource.recognition;
      let extractedText = '';
      
      if (recognition && recognition._) {
        // Try to extract text from recognition data (OCR)
        try {
          const recoXml = Buffer.from(recognition._, 'base64').toString('utf8');
          const recoResult = await parseXML(recoXml);
          // Extract text from recognition XML (simplified)
          extractedText = JSON.stringify(recoResult);
        } catch (e) {
          // Ignore OCR extraction errors
        }
      }
      
      await gtdDB.addAttachment(documentId, {
        filename,
        fileType: mime,
        fileSize,
        storagePath,
        extractedText,
        metadata: {
          hash: resource.$?.hash,
          width: resource.width,
          height: resource.height,
          duration: resource.duration,
          recognition: !!recognition
        }
      });
      
    } catch (error) {
      console.error('Failed to process resource:', error);
    }
  }

  parseDate(dateStr) {
    if (!dateStr) return new Date();
    
    // Evernote date format: YYYYMMDDTHHMMSSZ
    if (dateStr.match(/^\d{8}T\d{6}Z?$/)) {
      const year = dateStr.substr(0, 4);
      const month = dateStr.substr(4, 2);
      const day = dateStr.substr(6, 2);
      const hour = dateStr.substr(9, 2);
      const minute = dateStr.substr(11, 2);
      const second = dateStr.substr(13, 2);
      
      return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    }
    
    return new Date(dateStr);
  }

  generateSourceId(title, created) {
    const data = `${title}_${created.toISOString()}`;
    return crypto.createHash('md5').update(data).digest('hex');
  }

  async processENEXFile(filePath) {
    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath, 'utf8');
    return this.processENEXContent(content);
  }
}

export default EvernoteProcessor;