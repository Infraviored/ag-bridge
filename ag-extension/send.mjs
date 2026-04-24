#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import WebSocket from 'ws';

const arg1 = process.argv[2];
const allFlag = process.argv.includes('--all');
const text = process.argv.slice(3).filter(a => a !== '--all').join(' ');

if (!arg1 || !text) {
  console.error('Usage: agbridge <index|name> "Message" [--all]');
  console.error('Options:');
  console.error('  --all    Show full logs (tool calls, thoughts, browser actions)');
  process.exit(1);
}

let chatNames = {};
// Looks for config in the CURRENT WORKING DIRECTORY (the workspace where you run the command)
if (existsSync('./ag-config.json')) {
  try { chatNames = JSON.parse(readFileSync('./ag-config.json', 'utf8')).chatNames || {}; } catch { }
}

let chatIndex;
if (!isNaN(parseInt(arg1))) {
  chatIndex = parseInt(arg1);
} else {
  const found = Object.entries(chatNames).find(([, n]) => n === arg1);
  if (!found) { console.error(`Chat "${arg1}" nicht gefunden.`); process.exit(1); }
  chatIndex = parseInt(found[0]);
}

const displayName = chatNames[chatIndex] || `chat${chatIndex}`;
const reqId = randomUUID();
const opts = { all: allFlag };

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.url?.includes('workbench.html') && t.type === 'page');
if (!tab) { console.error('Tab nicht gefunden!'); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
ws.on('open', () => {
  const cmd = JSON.stringify({ chatIndex, text, reqId, opts });
  ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: `localStorage.setItem('__cmd', ${JSON.stringify(cmd)})` }
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
});
ws.on('error', e => { console.error(`WebSocket Fehler: ${e.message}`); process.exit(1); });
// Load timeout from config if available (minutes to ms)
let cliTimeoutMinutes = 10;
try {
  const config = JSON.parse(readFileSync('./ag-config.json', 'utf8'));
  if (config.cliTimeout) cliTimeoutMinutes = config.cliTimeout;
} catch (e) { }

setTimeout(() => { console.error('Timeout'); process.exit(1); }, cliTimeoutMinutes * 60 * 1000);