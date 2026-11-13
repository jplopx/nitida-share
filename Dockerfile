FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3000
ENV PORT=3000 NODE_ENV=production DB_FILE=/app/data/nitida.sqlite
CMD ["node", "server/index.js"]
