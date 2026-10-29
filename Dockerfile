# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npx tsc -p .

# --- runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package*.json ./
# tsx stays installed so `npm run fix / query / db:*` work inside the container
RUN npm ci --include=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
COPY database ./database
COPY public ./public
COPY data ./data
RUN mkdir -p logs && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1
CMD ["node", "dist/src/server.js"]
