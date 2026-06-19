# syntax=docker/dockerfile:1
# Control-plane's own image. The generic canonical Node Dockerfile
# (src/deploy/dockerfiles.ts) can't build this app: its cache-only deps stage
# runs `npm ci` with just package*.json present, but the CP's `postinstall`
# hook runs `prisma generate`, which needs prisma/schema.prisma. So the CP
# owns its Dockerfile — detect-stack sees it (buildPack="dockerfile") and both
# BuildxImageBuilder and deploy-platform.sh build it verbatim.
#
# Notes:
#  - openssl is required by Prisma's query engine on alpine.
#  - prisma/ is copied before `npm ci` so the postinstall generate succeeds.
#  - the run stage keeps the full node_modules (incl. the prisma CLI, a
#    devDependency) because `npm run start` runs `prisma migrate deploy`.

FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json .npmrc ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV PORT=8090
COPY --from=build /app ./
EXPOSE 8090
CMD ["npm", "run", "start"]
