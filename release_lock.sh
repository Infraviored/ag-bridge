#!/bin/bash
# Script to release port 9222 lock by killing processes listening on it.

PORT=9222
PIDS=$(lsof -t -i :$PORT)

if [ -z "$PIDS" ]; then
    echo "✅ Port $PORT is already free."
    exit 0
fi

echo "⚠️ Found processes using port $PORT: $PIDS"

# 1. Soft kill (SIGTERM)
echo "🔄 Sending SIGTERM to processes..."
kill $PIDS 2>/dev/null

# Wait up to 3 seconds for processes to exit
for i in {1..3}; do
    PIDS=$(lsof -t -i :$PORT)
    if [ -z "$PIDS" ]; then
        echo "✅ Processes exited gracefully. Port $PORT is now free."
        exit 0
    fi
    sleep 1
done

# 2. Hard kill (SIGKILL) if still alive
echo "🔥 Processes still alive. Sending SIGKILL..."
kill -9 $PIDS 2>/dev/null

sleep 1
PIDS=$(lsof -t -i :$PORT)
if [ -z "$PIDS" ]; then
    echo "✅ Port $PORT has been forcibly released."
else
    echo "❌ Failed to release port $PORT. PIDs $PIDS still active. You might need sudo."
    exit 1
fi
