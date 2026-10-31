# syntax=docker/dockerfile:1

# --- Build: compile the demo app (examples/basic) from TS source --------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY examples/basic ./examples/basic

RUN npx vite build examples/basic

# --- Runtime: static files only, no Node in the final image -------------
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/examples/basic/dist /usr/share/nginx/html

EXPOSE 80
