# IMPORTANT: keep this image tag in lock-step with the "playwright" version in
# package.json. A mismatch (e.g. image v1.52 + npm 1.59) ships a chromium build
# that the installed Playwright can't launch ("Executable doesn't exist…"),
# which made deep crawls fail intermittently in production.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# The official Playwright image does NOT ship xvfb/xvfb-run. The execution
# engine wraps Playwright in `xvfb-run -a` so customer repos whose
# playwright.config sets `headless: false` still launch a browser in this
# headless container (otherwise Chromium crashes at startup with
# "Missing X server or $DISPLAY" — a ~800ms exit 1 with no results file).
# Install it explicitly so ExecutionEngine.hasXvfb() resolves true here.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files (.npmrc carries legacy-peer-deps for the optional
# tree-sitter parsers whose peer ranges conflict with tree-sitter@^0.25.0)
COPY package.json package-lock.json .npmrc ./

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
