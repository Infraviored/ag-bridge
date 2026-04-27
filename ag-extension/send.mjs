#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import WebSocket from 'ws';

const DELEGATION_PROMPT = `
# ANTIGRAVITY ORCHESTRATION PROTOCOL

You are the Orchestrator. You have direct control over specialized sub-agents via the 'agbridge' CLI. Use them to delegate complex, parallel, or domain-specific tasks.

CONTROL INTERFACE:
- Dispatch:    agbridge <idx> "prompt" (Persistent, context-aware sessions)
- Supervision: Add --all to capture the complete execution trajectory.
- Inspection:  agbridge --inspect to monitor global health and trajectory mapping.

TRUE PARALLELISM:
You can dispatch multiple agents simultaneously by using 'run_in_background: true' in your shell tool calls. The Bridge tracks each agent independently; you will be notified as each completes.

SESSION CONSTRAINTS:
- Hard Timeout: {{cliMin}} minutes (The absolute maximum duration for a single command).
- Activity Guard: {{silenceMin}} minutes (Monitors for silence or stuck tool calls).
- Note: Agents can perform long-running tasks as long as they provide periodic progress updates.

GUIDELINES:
1. Delegation:  Assign tasks based on the specific agent roles defined in the Registry.
2. Persistence:  Sessions are long-lived; you don't need to re-explain shared context.
3. Efficiency:   Use parallel dispatch for multi-agent workflows (e.g., Frontus + Backus).
`;

const arg1 = process.argv[2];
const isInspectMode = process.argv.includes('--inspect');
const isLastMode = process.argv.includes('--last');
const allFlag = process.argv.includes('--all');
const isHelp = process.argv.includes('--help') || process.argv.includes('-h');

if ((!arg1 && !isInspectMode) || isHelp) {
  console.log(DELEGATION_PROMPT
    .replace('{{cliMin}}', '10')
    .replace('{{silenceMin}}', '3'));
  process.exit(0);
}

let text = "";
if (!isLastMode && !isInspectMode) {
  text = process.argv.slice(3).filter(a => a !== '--all' && a !== '--inspect').join(' ');
  if (!text) {
    console.error('Error: No prompt provided. Use --last to fetch the last output, or --help for protocol.');
    process.exit(1);
  }
}

let agents = {};
let settings = { cliTimeout: 600 };
const configPath = `${process.env.HOME || process.env.USERPROFILE}/.agbridge/config.json`;

if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    agents = config.agents || {};
    settings = config.settings || settings;
  } catch { }
}

let chatIndex;
let displayName = "";
if (!isInspectMode) {
  if (!isNaN(parseInt(arg1))) {
    chatIndex = parseInt(arg1);
  } else {
    const found = Object.entries(agents).find(([, a]) => a.name === arg1);
    if (!found) { console.error(`Chat "${arg1}" nicht gefunden.`); process.exit(1); }
    chatIndex = parseInt(found[0]);
  }
  displayName = agents[chatIndex]?.name || `chat${chatIndex}`;
}
const chatAgent = agents[chatIndex];
const chatID = chatAgent?.id;

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.url?.includes('workbench.html') && t.type === 'page');
if (!tab) { console.error('Tab nicht gefunden!'); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);

ws.on('open', () => {
  if (isInspectMode) {
    ws.send(JSON.stringify({
      id: 10, method: 'Runtime.evaluate',
      params: { expression: `JSON.stringify({ 
        busy: JSON.parse(localStorage.getItem('__ag_busy') || '{}'),
        registry: JSON.parse(localStorage.getItem('__ag_registry') || '{}'),
        windowId: window.__agId,
        activeTrajectories: window.__activeTrajectories || {},
        pendingCmds: Object.keys(localStorage).filter(k => k.startsWith('__ag_cmd_')).length,
        version: typeof VERSION !== 'undefined' ? VERSION : 'unknown'
      })` }
    }));
    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.id === 10) {
        const state = JSON.parse(msg.result?.result?.value || '{}');
        console.log(`\x1b[33m--- BRIDGE INSPECTOR (Window: ${state.windowId} | v${state.version}) ---\x1b[0m`);
        console.log(`\x1b[36mRegistry Size:\x1b[0m`, Object.keys(state.registry).length);
        console.log(`\x1b[35mBusy Agents:\x1b[0m`, JSON.stringify(state.busy, null, 2));
        console.log(`\x1b[32mActive Trajectories:\x1b[0m`, JSON.stringify(state.activeTrajectories, null, 2));
        console.log(`\x1b[31mPending Mailbox Commands:\x1b[0m`, state.pendingCmds);
        ws.close();
        process.exit(0);
      }
    });
    return;
  }

  if (isLastMode) {
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: `JSON.parse(localStorage.getItem('__ag_outputs') || '{}')[${chatIndex}] || "No cached output found."` }
    }));
    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.id === 1) {
        console.log(`\x1b[33mAGENT ${chatIndex} | ${displayName} (LAST OUTPUT)\x1b[0m`);
        console.log(`\x1b[96m${msg.result?.result?.value || "Error"}\x1b[0m`);
        ws.close();
        process.exit(0);
      }
    });
  } else {
    const reqId = randomUUID();
    const opts = { all: allFlag };
    const cmd = JSON.stringify({ chatIndex, text, reqId, opts });
    
    // Use unique mailbox to prevent parallel collisions
    const mailboxKey = `__ag_cmd_${reqId}`;
    
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: `localStorage.setItem('${mailboxKey}', ${JSON.stringify(cmd)})` }
    }));

    const iv = setInterval(() => ws.send(JSON.stringify({
      id: 2, method: 'Runtime.evaluate',
      params: { expression: `localStorage.getItem('__res_${reqId}')` }
    })), 400);

    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.id === 2 && msg.result?.result?.value) {
        clearInterval(iv); ws.close();
        const r = JSON.parse(msg.result.result.value);
        console.log(`\x1b[33mAGENT ${chatIndex} | ${displayName}\x1b[0m`);
        console.log(`\x1b[96m${r.answer}\x1b[0m`);
        if (r.files?.length > 0)
          r.files.forEach(f => console.log(`\x1b[33m📁 ${f}\x1b[0m`));
        process.exit(0);
      }
    });
  }
});

ws.on('error', e => { console.error(`WebSocket Fehler: ${e.message}`); process.exit(1); });

let cliTimeoutSeconds = settings.cliTimeout || 600;

setTimeout(() => { 
  console.error('\x1b[31mTIMEOUT: Agent did not respond in time.\x1b[0m'); 
  process.exit(1); 
}, cliTimeoutSeconds * 1000);
