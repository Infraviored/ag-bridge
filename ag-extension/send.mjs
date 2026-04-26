#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import WebSocket from 'ws';

const arg1 = process.argv[2];
const isLastMode = process.argv.includes('--last');
const allFlag = process.argv.includes('--all');
let text = "";

if (!arg1) {
  console.error('Usage: agbridge <index|name> "Message" [--all]');
  console.error('Usage: agbridge <index|name> --last');
  process.exit(1);
}

if (!isLastMode) {
  text = process.argv.slice(3).filter(a => a !== '--all').join(' ');
  if (!text) {
    console.error('Error: No prompt provided. Use --last to fetch the last output.');
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
if (!isNaN(parseInt(arg1))) {
  chatIndex = parseInt(arg1);
} else {
  const found = Object.entries(agents).find(([, a]) => a.name === arg1);
  if (!found) { console.error(`Chat "${arg1}" nicht gefunden.`); process.exit(1); }
  chatIndex = parseInt(found[0]);
}

const displayName = agents[chatIndex]?.name || `chat${chatIndex}`;
const chatAgent = agents[chatIndex];
const chatID = chatAgent?.id;

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.url?.includes('workbench.html') && t.type === 'page');
if (!tab) { console.error('Tab nicht gefunden!'); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);

ws.on('open', () => {
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
  }
});

ws.on('error', e => { console.error(`WebSocket Fehler: ${e.message}`); process.exit(1); });

let cliTimeoutSeconds = settings.cliTimeout || 600;

setTimeout(() => { 
  console.error('\x1b[31mTIMEOUT: Agent did not respond in time.\x1b[0m'); 
  process.exit(1); 
}, cliTimeoutSeconds * 1000);
