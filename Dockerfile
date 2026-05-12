FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy compiled source
COPY dist/ ./dist/
COPY src/config/ ./dist/config/

# Expose port
EXPOSE 8080

# Set environment
ENV NODE_ENV=production
ENV MODE=api
ENV PORT=8080

# Start the API server
CMD ["node", "dist/index.js"]
