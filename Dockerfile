FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY . .
RUN npm run build
RUN npx prisma generate

# Expose healthcheck port
EXPOSE 3000

# Run migrations and start bot
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/bot.js"]
