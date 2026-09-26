# Build context is the repo root (see docker-compose.yml): the workspace
# lockfile lives there, and `npm ci` needs every workspace's package.json to
# validate it — only mcp-weather's own dependencies actually get installed.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY web/package.json web/
COPY mcp-weather/package.json mcp-weather/
RUN npm ci --workspace=mcp-weather --include-workspace-root=false
COPY mcp-weather/tsconfig.json mcp-weather/
COPY mcp-weather/src mcp-weather/src
RUN npm run build --workspace=mcp-weather

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY web/package.json web/
COPY mcp-weather/package.json mcp-weather/
RUN npm ci --workspace=mcp-weather --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /app/mcp-weather/dist mcp-weather/dist

USER node
WORKDIR /app/mcp-weather
ENV PORT=3002
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3002/health || exit 1
CMD ["node", "dist/index.js"]
