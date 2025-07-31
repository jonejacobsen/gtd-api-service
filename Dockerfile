# Use official Node.js Alpine image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production --silent

# Copy application files
COPY . .

# Create temp directory for uploads
RUN mkdir -p /app/temp && chmod 755 /app/temp

# Use non-root user
USER node

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "server.js"]