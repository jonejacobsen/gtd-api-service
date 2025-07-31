# GTD API Service

A high-performance API service for the GTD (Getting Things Done) Productivity System, featuring full-text search, vector embeddings, and Evernote migration capabilities.

## 🚀 Quick Deploy to Railway

### Option 1: Deploy via Railway Button
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/deploy?template=https://github.com/yourusername/gtd-api-service)

### Option 2: Deploy via Railway CLI
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Create new project
railway new

# Link to existing project (if you have one)
railway link

# Deploy
railway up
```

### Option 3: Deploy from GitHub
1. Push this `gtd-api-service` folder to a GitHub repository
2. In Railway Dashboard:
   - New Project → Deploy from GitHub repo
   - Select your repository
   - Railway will auto-detect the Dockerfile

## 🔧 Configuration

### Required Environment Variables
- `DATABASE_URL` or `RAILWAY_POSTGRESQL_URL` - PostgreSQL connection string

### Optional Environment Variables
- `OPENAI_API_KEY` - For vector search capabilities
- `CORS_ORIGIN` - Allowed origins (default: *)
- `API_KEY` - For API authentication (if enabled)

## 📊 Database Setup

The service will automatically run migrations on startup if the tables don't exist. To run manually:

```bash
railway run npm run migrate
```

## 🔌 Connecting Services

### From n8n
In your n8n workflows, use HTTP Request nodes:
```json
{
  "method": "POST",
  "url": "{{$env.GTD_API_URL}}/api/search",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "query": "meeting notes",
    "type": "hybrid"
  }
}
```

### Internal Railway Network
If n8n is also on Railway, use the internal URL:
```
http://gtd-api.railway.internal:3001
```

## 📚 API Endpoints

### Search
- `POST /api/search` - Search documents
- `GET /api/search/suggestions?q=query` - Get search suggestions

### Documents
- `GET /api/documents/:id` - Get document
- `POST /api/documents` - Create document
- `PUT /api/documents/:id` - Update document
- `DELETE /api/documents/:id` - Soft delete document

### GTD Operations
- `GET /api/contexts` - List all contexts with counts
- `GET /api/projects` - List all projects
- `GET /api/areas` - List all areas
- `GET /api/review/weekly` - Get weekly review stats

### Migration
- `POST /api/migrate/evernote` - Upload ENEX file
- `GET /api/migrate/status/:id` - Check migration status

### Capture
- `POST /api/capture/:type` - Generic capture endpoint

## 🏗️ Architecture

```
┌─────────────────┐
│   Client Apps   │
│  (n8n, Mobile)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  GTD API Server │
│   (This Service)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   PostgreSQL    │
│  with pgvector  │
└─────────────────┘
```

## 🚨 Health Monitoring

- Health endpoint: `GET /health`
- Metrics endpoint: `GET /metrics` (if enabled)

Railway automatically monitors the health endpoint and will restart the service if it becomes unhealthy.

## 🔒 Security

1. **CORS**: Configure `CORS_ORIGIN` for your domains
2. **API Key**: Set `API_KEY_REQUIRED=true` and `API_KEY`
3. **Rate Limiting**: Configured via environment variables
4. **Input Sanitization**: HTML is sanitized automatically

## 📈 Performance

- Connection pooling with configurable size
- Efficient full-text search with PostgreSQL GIN indexes
- Vector search with pgvector IVFFLAT indexes
- Batch processing for embeddings

## 🐛 Troubleshooting

### Database Connection Issues
```bash
# Test connection
railway run node -e "require('./lib/gtd-database-client.js').gtdDB.connect().then(() => console.log('Connected!')).catch(console.error)"
```

### Migration Issues
Check if pgvector is installed:
```bash
railway run psql $DATABASE_URL -c "SELECT * FROM pg_extension WHERE extname = 'vector';"
```

### View Logs
```bash
railway logs
```

## 📝 Development

### Local Development
```bash
# Install dependencies
npm install

# Copy .env.example to .env
cp .env.example .env

# Edit .env with your values
# Run locally
npm run dev
```

### Running Tests
```bash
npm test
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

MIT