# node:sqlite needs Node >= 22.13
FROM node:22.21.1-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/clicks.db
USER 1000
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
