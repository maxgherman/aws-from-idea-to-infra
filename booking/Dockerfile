# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /build

# Install dependencies before copying source so this layer is cached
# unless the package manifests or tsconfig.json change.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Compile TypeScript.
COPY src ./src
RUN npx tsc

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine

# Create a non-root user. The image provides adduser/addgroup via BusyBox.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only the compiled output; leave dev dependencies and source behind.
COPY --from=builder /build/dist ./dist

USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
