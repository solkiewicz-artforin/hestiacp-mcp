FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.js ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=app:app /app/package*.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
USER app
ENTRYPOINT ["node", "dist/cli.js"]
