# Keep the SDK digest/platform aligned with packages/storage/sqlite/sources.json.
FROM --platform=linux/amd64 emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7 AS sqlite
WORKDIR /src
COPY packages/storage/sqlite/ ./
RUN python3 build.py --prepare-only && bash build-container.sh

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling
COPY --from=sqlite /src/dist ./packages/storage/sqlite/dist
RUN npm ci
RUN npm run sqlite:verify && npm run typecheck && npm run build --workspace @quixi/web

FROM nginx:stable-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
