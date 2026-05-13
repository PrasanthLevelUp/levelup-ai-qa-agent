FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Production environment
ENV NODE_ENV=production
ENV MODE=api
ENV PORT=8080

# Expose Railway port
EXPOSE 8080

# Start backend
CMD ["node", "dist/index.js"]
