#!/bin/bash
# Antigravity Parallel Test v3 (Configurable IDs)

ID_A=5
ID_B=6
SLEEP_TIME=10
TIMEOUT=30

PROMPT="in bash: Write out your name, sleep ${SLEEP_TIME} seconds, and then say you are done."

echo "🚀 Starting parallel test (Agents $ID_A & $ID_B) at $(date +%T)..."
START_TIME=$(date +%s)

# Dispatch Agent A
agbridge $ID_A "$PROMPT" > /tmp/ag_out_$ID_A.txt 2>&1 &
PID_A=$!
echo "📡 Agent $ID_A dispatched. [PID: $PID_A]"

# Dispatch Agent B
agbridge $ID_B "$PROMPT" > /tmp/ag_out_$ID_B.txt 2>&1 &
PID_B=$!
echo "📡 Agent $ID_B dispatched. [PID: $PID_B]"

echo "⏳ Waiting for agents (Max ${TIMEOUT}s)..."

for ((i=1; i<=TIMEOUT; i++)); do
    ps -p $PID_A > /dev/null
    S_A=$?
    ps -p $PID_B > /dev/null
    S_B=$?

    if [ $S_A -ne 0 ] && [ $S_B -ne 0 ]; then
        echo "✅ Both agents finished!"
        break
    fi

    if [ $((i % 5)) -eq 0 ]; then
        echo "⏱️  ${i}s elapsed... [Agent $ID_A: $([ $S_A -eq 0 ] && echo "RUNNING" || echo "DONE")] [Agent $ID_B: $([ $S_B -eq 0 ] && echo "RUNNING" || echo "DONE")]"
    fi

    if [ $i -eq $TIMEOUT ]; then
        echo "❌ TIMEOUT REACHED! Killing processes..."
        kill -9 $PID_A $PID_B 2>/dev/null
    fi
    sleep 1
done

END_TIME=$(date +%s)
echo "--------------------------------"
echo "⏱️ Total Time: $((END_TIME - START_TIME))s"
echo "📄 Agent $ID_A: $(tail -n 1 /tmp/ag_out_$ID_A.txt)"
echo "📄 Agent $ID_B: $(tail -n 1 /tmp/ag_out_$ID_B.txt)"
