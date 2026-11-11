FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache git && npm install --omit=dev && apk del git && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/whatsapp-auth
EXPOSE 8080
CMD ["npm","start"]
