// send.mjs
import { randomUUID } from 'crypto';
import WebSocket from 'ws';

const chatIndex = parseInt(process.argv[2]);
const text = process.argv.slice(3).join(' ');
if (!text || isNaN(chatIndex)) { console.error('Usage: node send.mjs <index> <message>'); process.exit(1); }

const reqId = randomUUID();
const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.title?.includes('Antigravity') && t.type === 'page');
if (!tab) { console.error('Tab nicht gefunden!'); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
ws.on('open', () => {
  const cmd = JSON.stringify({ chatIndex, text, reqId });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
    params: { expression: `localStorage.setItem('__cmd', ${JSON.stringify(cmd)})` }
  }));
  const iv = setInterval(() => ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate',
    params: { expression: `localStorage.getItem('__res_${reqId}')` }
  })), 400);
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.id === 2 && msg.result?.result?.value) {
      clearInterval(iv); ws.close();
      console.log(JSON.parse(msg.result.result.value).answer);
      process.exit(0);
    }
  });
});
setTimeout(() => { console.error('Timeout'); process.exit(1); }, 90000);
