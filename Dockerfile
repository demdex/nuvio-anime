FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=7000
EXPOSE 7000

# The ID mapping is cached in /tmp and refreshed daily.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:7000/health || exit 1

CMD ["node", "server.js"]
