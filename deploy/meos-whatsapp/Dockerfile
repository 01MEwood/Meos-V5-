FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
RUN mkdir -p /data
EXPOSE 4001
ENV NODE_ENV=production
CMD ["node", "server.js"]
