# Builds the API or the workers: docker build --build-arg APP=api -t frontrun-api .
FROM node:22-slim AS build
ARG APP=api
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@frontrun/${APP}..."
RUN pnpm --filter "@frontrun/${APP}" build
RUN pnpm --filter "@frontrun/${APP}" --prod deploy --legacy /out
RUN cp -R "apps/${APP}/dist" /out/dist

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out .
USER node
CMD ["node", "dist/index.js"]
