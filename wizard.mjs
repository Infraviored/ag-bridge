#!/usr/bin/env node
import WebSocket from 'ws';
import { writeFileSync } from 'fs';
import { createInterface } from 'readline';

const C = {
  gold: s => `\x1b[33m${s}\x1b[0m`,
  lime: s => `\x1b[92m${s}\x1b[0m`,
  cyan: s => `\x1b[96m${s}\x1b[0m`,
  gray: s => `\x1b[90m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  red: s => `\x1b[91m${s}\x1b[0m`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTab() {
  try {
    const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
    const pages = tabs.filter(t => t.type === 'page');
    console.log(C.gray(`  Gefundene Tabs (${pages.length}):`));
    pages.forEach(t => console.log(C.gray(`    [${t.id.slice(0, 8)}] ${t.title}`)));
    const tab = pages.find(t => t.url?.includes('workbench.html') || t.title?.toLowerCase().includes('antigravity'));
    if (!tab) throw new Error('Kein Tab gefunden');
    console.log(C.lime(`  → Verbinde mit: "${tab.title}"\n`));
    return tab;
  } catch (e) { console.error(C.red(`\n❌ CDP Fehler: ${e.message}`)); process.exit(1); }
}

let _ws, _msgId = 1, _pending = {};
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
async function cdpEval(expr) {
  return new Promise((resolve, reject) => {
    const id = _msgId++;
    _pending[id] = { resolve, reject };
    _ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: false } }));
    setTimeout(() => { delete _pending[id]; reject(new Error('CDP timeout')); }, 10000);
  });
}
async function getRegistry() {
  const r = await cdpEval('JSON.stringify(window.__chatRegistry || {})');
  try { return JSON.parse(r?.result?.value || '{}'); } catch { return {}; }
}
async function getCsrfReady() {
  const r = await cdpEval('!!(window.__agCaptured && window.__agCaptured.last)');
  return r?.result?.value === true;
}
function askQuestion(q) {
  return new Promise(r => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); r(ans); });
  });
}

async function main() {
  console.clear();
  console.log(C.gold(C.bold(`
╔════════════════════════════════════════════╗
║   ANTIGRAVITY BRIDGE WIZARD                ║
╚════════════════════════════════════════════╝`)));
  console.log('');

  const tab = await getTab();
  _ws = await connectWS(tab.webSocketDebuggerUrl);
  _ws.on('message', data => {
    const msg = JSON.parse(data);
    if (_pending[msg.id]) { _pending[msg.id].resolve(msg.result); delete _pending[msg.id]; }
  });

  let bridgeOk = false;
  for (let i = 0; i < 5; i++) {
    const r = await cdpEval('typeof window.sendTo').catch(() => null);
    if (r?.result?.value === 'function') { bridgeOk = true; break; }
    await sleep(500);
  }
  if (!bridgeOk) {
    console.error(C.red('❌ Bridge-Script nicht geladen! Zuerst in DevTools einfügen.'));
    process.exit(1);
  }
  console.log(C.lime('  ✅ Bridge gefunden!\n'));

  // ── PHASE 1 ──────────────────────────────────────────────────
  console.log(C.bold(C.gold('PHASE 1 — Chat-Registrierung')));
  console.log('');
  console.log(`  Öffne weitere Chats oder schreib in einen für den CSRF-Token.`);
  console.log(`  Drücke ${C.bold('Enter')} wenn du fertig bist.\n`);

  let done = false;
  const seenIds = new Set();

  // Aktuellen Stand sofort anzeigen
  const initial = await getRegistry();
  const csrfInitial = await getCsrfReady();
  for (const [idx, id] of Object.entries(initial)) {
    seenIds.add(id);
    console.log(`  ${C.cyan('[bereits]')} Chat ${idx}: ${C.cyan(id.slice(0, 8))}...`);
  }
  if (csrfInitial) {
    seenIds.add('__csrf__');
    console.log(`  ${C.cyan('[bereits]')} CSRF vorhanden`);
  }
  if (Object.keys(initial).length > 0) console.log('');

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', key => {
    if (key === '\u0003') { console.log('\nAbgebrochen.'); process.exit(0); }
    done = true;
  });

  while (!done) {
    const registry = await getRegistry();
    const csrfReady = await getCsrfReady();
    for (const [idx, id] of Object.entries(registry)) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        console.log(`  ${C.lime('✅ Chat erkannt:')} Chat ${idx}: ${C.cyan(id.slice(0, 8))}...`);
      }
    }
    if (csrfReady && !seenIds.has('__csrf__')) {
      seenIds.add('__csrf__');
      console.log(`  ${C.lime('✅ CSRF captured')} — Senden möglich`);
    }
    await sleep(300);
  }

  process.stdin.setRawMode(false);
  process.stdin.pause();

  const finalRegistry = await getRegistry();
  const finalCsrf = await getCsrfReady();

  if (Object.keys(finalRegistry).length === 0) {
    console.log(C.red('\n❌ Keine Chats registriert.')); process.exit(1);
  }
  if (!finalCsrf) {
    console.log(C.red('\n❌ Kein CSRF — in mindestens einen Chat schreiben.')); process.exit(1);
  }

  console.log(`\n  ${C.bold(Object.keys(finalRegistry).length + ' Chat(s) registriert.')}\n`);

  // ── PHASE 2 ──────────────────────────────────────────────────
  console.log(C.bold(C.gold('PHASE 2 — Chats benennen (Enter = überspringen)')));
  console.log('');

  const chatNames = {};
  for (const [idx, id] of Object.entries(finalRegistry)) {
    const name = await askQuestion(`  Name für Chat ${idx} ${C.gray(`[${id.slice(0, 8)}...]:`)} `);
    chatNames[idx] = name.trim() || `chat${idx}`;
  }

  await cdpEval(`window.__chatNames = ${JSON.stringify(chatNames)};`);

  // ── PHASE 3 ──────────────────────────────────────────────────
  console.log('');
  console.log(C.lime(C.bold(`
╔════════════════════════════════════════════╗
║   ✅  BRIDGE AKTIV                         ║
╚════════════════════════════════════════════╝`)));
  console.log('');
  console.log('  ' + C.bold('Chats:'));
  for (const [idx, id] of Object.entries(finalRegistry)) {
    const name = chatNames[idx] || `chat${idx}`;
    console.log(`    ${C.cyan(`[${idx}|${name}]`)}  ${C.gray(id)}`);
  }
  console.log('');
  console.log('  ' + C.bold('Terminal:'));
  for (const [idx] of Object.entries(finalRegistry)) {
    const name = chatNames[idx] || `chat${idx}`;
    console.log(`    ${C.gray(`node send.mjs ${idx} "Nachricht"`)}  →  ${C.cyan(`[${idx}|${name}]`)}`);
    console.log(`    ${C.gray(`node send.mjs ${name} "Nachricht"`)}  →  ${C.cyan(`[${idx}|${name}]`)}`);
    console.log(`    ${C.gray(`node send.mjs ${idx} "Nachricht" --all`)}  →  ${C.cyan('alle Zwischenschritte')}`);
  }
  console.log('');

  writeFileSync('./ag-config.json', JSON.stringify({ registry: finalRegistry, chatNames, ts: Date.now() }, null, 2));
  console.log(C.gray('  Config gespeichert → ./ag-config.json\n'));

  _ws.close();
}

main().catch(e => { console.error(C.red(`\nFehler: ${e.message}`)); process.exit(1); });