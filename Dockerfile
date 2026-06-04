FROM node:24-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-slim

RUN useradd -m -r copilot-agent
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ dist/

USER copilot-agent

# Config dir is mounted at /data/copilot-agent
ENV COPILOT_AGENT_CONFIG_DIR=/data/copilot-agent

ENTRYPOINT ["node", "dist/index.js"]
