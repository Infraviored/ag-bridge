#!/bin/bash
# Antigravity Parallel Test v2 (with Watchdog)

PROMPT="in bash: make script to Write out your name, sleep 30 seconds, and then in clear chat say that you are done. Do not perform any other actions."
TIMEOUT=60

echo "🚀 Starting parallel test at $(date +%T)..."
START_TIME=$(date +%s)

# Dispatch Agent 1
agbridge 1 "$PROMPT" > /tmp/ag_out_1.txt 2>&1 &
PID1=$!
echo "📡 Agent 1 (Frontus) dispatched. [PID: $PID1]"

# Dispatch Agent 3
agbridge 3 "$PROMPT" > /tmp/ag_out_3.txt 2>&1 &
PID3=$!
echo "📡 Agent 3 (Fiscus) dispatched. [PID: $PID3]"

echo "⏳ Waiting for agents (Max ${TIMEOUT}s)..."

for ((i=1; i<=TIMEOUT; i++)); do
    ps -p $PID1 > /dev/null
    S1=$?
    ps -p $PID3 > /dev/null
    S3=$?

    if [ $S1 -ne 0 ] && [ $S3 -ne 0 ]; then
        echo "✅ Both agents finished!"
        break
    fi

    if [ $((i % 10)) -eq 0 ]; then
        echo "⏱️  ${i}s elapsed... [Agent 1: $([ $S1 -eq 0 ] && echo "RUNNING" || echo "DONE")] [Agent 3: $([ $S3 -eq 0 ] && echo "RUNNING" || echo "DONE")]"
    fi

    if [ $i -eq $TIMEOUT ]; then
        echo "❌ TIMEOUT REACHED! Killing processes..."
        kill -9 $PID1 $PID3 2>/dev/null
    fi
    sleep 1
done

END_TIME=$(date +%s)
echo "--------------------------------"
echo "⏱️ Total Time: $((END_TIME - START_TIME))s"
echo "📄 Agent 1 (Last 2 lines): $(tail -n 2 /tmp/ag_out_1.txt)"
echo "📄 Agent 3 (Last 2 lines): $(tail -n 2 /tmp/ag_out_3.txt)"
