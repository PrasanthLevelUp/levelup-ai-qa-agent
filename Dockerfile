# IMPORTANT: keep this image tag in lock-step with the "playwright" version in
# package.json. A mismatch (e.g. image v1.52 + npm 1.59) ships a chromium build
# that the installed Playwright can't launch ("Executable doesn't exist…"),
# which made deep crawls fail intermittently in production.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

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
