FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY public ./public
COPY startup.sh ./
RUN chmod +x ./startup.sh
EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000
CMD ["./startup.sh"]
