FROM node:20-alpine

# better-sqlite3 needs build tools; drop after install to keep image small
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && apk add --no-cache tini

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && apk del .build-deps

COPY . .

# data is a mount point
VOLUME ["/app/data"]

EXPOSE 7894

# tini handles SIGTERM so graceful /holders/leave runs on `docker stop`
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "start.ts"]
