FROM node:20-slim

WORKDIR /app

# Install OpenSSL and certificates for Prisma
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package files and Prisma schema first (postinstall needs it)
COPY package*.json ./
COPY prisma ./prisma

RUN npm install

# Copy source and build
COPY . .
RUN npm run build
RUN npx prisma generate

# Expose healthcheck port
EXPOSE 3000

# Run migrations and start bot
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/bot.js"]
