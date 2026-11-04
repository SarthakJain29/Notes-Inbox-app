# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/data/notes.db PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
