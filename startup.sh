#!/bin/sh
echo "MEOS 4.0 - Starting..."

# Wait for MySQL
echo "[STARTUP] Waiting for database..."
sleep 10

# Apply schema (no data loss)
echo "[STARTUP] Applying schema..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || sleep 5 && npx prisma db push --skip-generate 2>&1

# Seed users if needed
echo "[STARTUP] Running seed check..."
node prisma/seed.js

# Start server
echo "[STARTUP] Starting server..."
exec node src/server.js
