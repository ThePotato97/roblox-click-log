FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
# read-only root filesystem in the cluster: no runtime transpiler cache
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/clicks.db BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER 1000
EXPOSE 8787
CMD ["bun", "src/server.mjs"]
