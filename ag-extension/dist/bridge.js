// ════════════════════════════════════════════════════════════
// ANTIGRAVITY BRIDGE SCRIPT v16 — Enhanced Logging
// ════════════════════════════════════════════════════════════
const _origFetch = window.fetch;
window.__origFetch = _origFetch;
window.__agReadLog = [];
window.__agLogs = [{ ts: Date.now(), msg: "🚀 Bridge Initialized" }];
window.__agCaptured = { history: [] };
window.__chatRegistry = {};
window.__chatNames = {};
window.__relinkMode = null;
window.__relinkOldId = null;

function log(msg) {
  window.__agLogs.push({ ts: Date.now(), msg });
  if (window.__agLogs.length > 500) window.__agLogs.shift();
  console.log(`[AG-BRIDGE] ${msg}`);
}

function stripConnectFraming(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const len = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0, false);
    if (offset + 5 + len <= buffer.length) {
      chunks.push(new TextDecoder().decode(buffer.slice(offset + 5, offset + 5 + len)));
      offset += 5 + len;
    } else { break; }
  }
  if (chunks.length === 0 && buffer.length > 0) return new TextDecoder().decode(buffer);
  return chunks.join('');
}

window.fetch = async function (input, init, ...rest) {
  const url = (input instanceof Request ? input.url : input?.url ?? input) || '';
  const urlStr = String(url);
  const result = _origFetch.apply(this, arguments);

  if (urlStr.includes('SendUserCascadeMessage')) {
    const headers = Object.fromEntries(new Headers(init?.headers || {}).entries());
    const bodyStr = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : (init?.body ?? '');
    window.__agCaptured.last = { url: urlStr, headers, body: bodyStr, ts: Date.now() };
    log(`📡 CAPTURE: Headers & CSRF captured from ${urlStr}`);
  }

  const handleId = (id) => {
    if (window.__relinkMode !== null) {
      if (id === window.__relinkOldId) return;
      const targetIdx = window.__relinkMode;
      window.__chatRegistry[targetIdx] = id;
      log(`🔗 RELINK: Agent [${targetIdx}] -> ${id}`);
      window.__relinkMode = null;
      window.__relinkOldId = null;
      return;
    }
    if (Object.values(window.__chatRegistry).includes(id)) return;
    let nextIdx = 1;
    while (window.__chatRegistry[nextIdx]) nextIdx++;
    window.__chatRegistry[nextIdx] = id;
    log(`🎯 AUTO-DISCOVERY: Agent [${nextIdx}] -> ${id}`);
  };

  if (urlStr.includes('StreamAgentStateUpdates')) {
    result.then(res => {
      const cloned = res.clone();
      (async () => {
        try {
          const reader = cloned.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const decoded = stripConnectFraming(value);
            const m = decoded.match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
            if (m) handleId(m[1]);
          }
        } catch { }
      })();
    });
  }

  if (urlStr.includes('GetConversation') || urlStr.includes('GetCascade')) {
    result.then(async res => {
      try {
        const text = await res.clone().text();
        const m = text.match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
        if (m) handleId(m[1]);
      } catch { }
    });
  }

  return result;
};

window.postToChat = async (cascadeId, text) => {
  const c = window.__agCaptured.last;
  if (!c) throw new Error('No Capture!');
  log(`📤 POST: Sending message to ${cascadeId}...`);
  const payload = JSON.parse(c.body);
  payload.cascadeId = cascadeId;
  payload.items = [{ text }];
  return _origFetch(c.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'x-codeium-csrf-token': c.headers['x-codeium-csrf-token']
    },
    body: JSON.stringify(payload)
  });
};

window.activateStream = async (cascadeId) => {
  const c = window.__agCaptured.last;
  if (!c) throw new Error('No Capture!');
  log(`🌊 STREAM: Activating stream for ${cascadeId}...`);
  const csrf = c.headers['x-codeium-csrf-token'];
  const base = c.url.replace('SendUserCascadeMessage', 'StreamAgentStateUpdates');
  const json = JSON.stringify({ conversationId: cascadeId, subscriberId: crypto.randomUUID() });
  const jsonBytes = new TextEncoder().encode(json);
  const envelope = new Uint8Array(5 + jsonBytes.length);
  envelope[0] = 0x00;
  new DataView(envelope.buffer).setUint32(1, jsonBytes.length, false);
  envelope.set(jsonBytes, 5);
  const res = await _origFetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/connect+json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': csrf },
    body: envelope
  });
  const reader = res.body.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const payload = stripConnectFraming(value);
        log(`📥 CHUNK: Received ${value.length} bytes (Decoded: ${payload.length} chars)`);
        window.__agReadLog.push({ kind: 'fetch-chunk', url: base, payload, ts: Date.now() });
      }
    } catch { }
  })();
  return new Promise(resolve => {
    const t0 = Date.now();
    const check = setInterval(() => {
      const has = window.__agReadLog.some(x => x.kind === 'fetch-chunk' && x.url?.includes('StreamAgentStateUpdates') && x.payload.includes(cascadeId) && x.ts > t0);
      if (has || Date.now() - t0 > 4000) { clearInterval(check); resolve(); }
    }, 100);
  });
};

window.postAndReadAuto = async (text, cascadeId, opts = {}, timeoutMs = 180000) => {
  const allSteps = opts.all === true;
  window.__agReadLog = window.__agReadLog.filter(x => !x.payload?.includes(cascadeId));
  await window.activateStream(cascadeId);
  const sentAt = Date.now();
  await window.postToChat(cascadeId, text);
  return new Promise((resolve, reject) => {
    let lastRunningTs = 0, lastIdleTs = 0, lastContentTs = 0;
    const iv = setInterval(() => {
      const now = Date.now();
      const newChunks = window.__agReadLog.filter(x => x.kind === 'fetch-chunk' && x.ts >= sentAt && x.payload?.includes(cascadeId));
      const fullBuffer = newChunks.map(c => c.payload).join('');
      
      if (fullBuffer.includes('"CASCADE_RUN_STATUS_RUNNING"')) {
          if (lastRunningTs === 0) log(`▶️ STATE: Agent is RUNNING`);
          lastRunningTs = now;
      }
      if (fullBuffer.includes('"CASCADE_RUN_STATUS_IDLE"')) {
          if (lastIdleTs === 0) log(`⏹️ STATE: Agent is IDLE`);
          lastIdleTs = now;
      }
      
      const matches = [...fullBuffer.matchAll(/"(?:modifiedResponse|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
      if (matches.length > 0 && now - lastContentTs > 1000) {
          log(`📝 MATCH: Found ${matches.length} text segments in stream`);
          lastContentTs = now;
      }

      const gracePeriod = fullBuffer.includes('CORTEX_STEP_TYPE_RUN_COMMAND') ? 8000 : 5000;

      if (lastIdleTs > 0 && lastIdleTs >= lastRunningTs && (now - lastContentTs > 3000) && (now - lastIdleTs > gracePeriod)) {
        log(`✅ DONE: Resolving response after ${now - sentAt}ms`);
        clearInterval(iv);
        const raw = [];
        const seen = new Set();
        for (const m of matches) {
           const r = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
           if (r.trim() && !seen.has(r)) { seen.add(r); raw.push(r); }
        }
        const steps = raw.filter((r, i) => !raw.some((other, j) => j > i && other.startsWith(r) && other.length > r.length));
        resolve({ answer: allSteps ? steps.join('\n\n---\n\n') : (steps.at(-1) || ''), steps });
      }
      if (now - sentAt > timeoutMs) { 
        log(`❌ TIMEOUT: Agent failed to respond in time`);
        clearInterval(iv); reject(new Error('Timeout')); 
      }
    }, 500);
  });
};

window.sendTo = (idx, text, opts = {}) => {
  const id = window.__chatRegistry[idx];
  if (!id) return Promise.reject(`Chat ${idx} not found.`);
  return window.postAndReadAuto(text, id, opts);
};

setInterval(() => {
  const cmd = localStorage.getItem('__cmd');
  if (!cmd) return;
  localStorage.removeItem('__cmd');
  const { chatIndex, text, reqId, opts } = JSON.parse(cmd);
  log(`🤖 CLI: Request for Agent [${chatIndex}] received`);
  window.sendTo(chatIndex, text, opts || {})
    .then(r => localStorage.setItem('__res_' + reqId, JSON.stringify({ answer: r.answer, steps: r.steps })))
    .catch(e => {
        log(`⚠️ ERROR: ${e}`);
        localStorage.setItem('__res_' + reqId, JSON.stringify({ answer: `ERROR: ${e}` }));
    });
}, 200);

log('🚀 Bridge v16 READY with Activity Logging');