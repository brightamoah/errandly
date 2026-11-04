FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web/package*.json web/
RUN npm --prefix web ci
COPY . .
RUN npx tsc -p . && npm --prefix web run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/docs/openapi.yaml docs/openapi.yaml
COPY package.json .
EXPOSE 3000
USER node
CMD ["node", "dist/src/server.js"]
