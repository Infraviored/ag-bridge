// ════════════════════════════════════════════════════════════
// ANTIGRAVITY BRIDGE SCRIPT v12 — No Blacklist (Pure Discovery)
// ════════════════════════════════════════════════════════════
const _origFetch = window.fetch;
window.__origFetch = _origFetch;
window.__agReadLog = [];
window.__agCaptured = { history: [] };
window.__chatRegistry = {};
window.__chatNames = {};
window.__relinkMode = null;
window.__relinkOldId = null;

window.fetch = async function (input, init, ...rest) {
  const url = (input instanceof Request ? input.url : input?.url ?? input) || '';
  const urlStr = String(url);
  const result = _origFetch.apply(this, arguments);

  if (urlStr.includes('SendUserCascadeMessage')) {
    const headers = Object.fromEntries(new Headers(init?.headers || {}).entries());
    const bodyStr = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : (init?.body ?? '');
    window.__agCaptured.last = { url: urlStr, headers, body: bodyStr, ts: Date.now() };
  }

  const handleId = (id) => {
    // 1. RELINK MODE
    if (window.__relinkMode !== null) {
      if (id === window.__relinkOldId) return;

      const targetIdx = window.__relinkMode;
      
      Object.keys(window.__chatRegistry).forEach(k => {
        if (window.__chatRegistry[k] === id && String(k) !== String(targetIdx)) {
          window.__chatRegistry[k] = ""; 
        }
      });

      window.__chatRegistry[targetIdx] = id;
      console.log(`%c🔗 RELINK SUCCESS: [${targetIdx}] -> ${id}`, 'color:lime; font-weight:bold');
      window.__relinkMode = null;
      window.__relinkOldId = null;
      return;
    }

    // 2. AUTO-ASSIGNMENT
    if (Object.values(window.__chatRegistry).includes(id)) return;

    let foundSlot = false;
    const sortedIndices = Object.keys(window.__chatRegistry).map(Number).sort((a,b) => a-b);
    for (const idx of sortedIndices) {
      if (!window.__chatRegistry[idx] || window.__chatRegistry[idx] === "") {
        window.__chatRegistry[idx] = id;
        console.log(`%c🎯 AUTO-FILL: [${idx}] -> ${id}`, 'color:lime; font-weight:bold');
        foundSlot = true;
        break;
      }
    }

    if (!foundSlot) {
      let nextIdx = 1;
      while (window.__chatRegistry[nextIdx]) nextIdx++;
      window.__chatRegistry[nextIdx] = id;
      console.log(`%c🆕 AUTO-NEW: [${nextIdx}] -> ${id}`, 'color:lime; font-weight:bold');
    }
  };

  if (urlStr.includes('StreamAgentStateUpdates')) {
    result.then(res => {
      const cloned = res.clone();
      (async () => {
        try {
          const reader = cloned.body.getReader();
          const dec = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const m = dec.decode(value, { stream: true }).match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
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
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        window.__agReadLog.push({ kind: 'fetch-chunk', url: base, chunk: dec.decode(value, { stream: true }), ts: Date.now() });
      }
    } catch { }
  })();
  return new Promise(resolve => {
    const t0 = Date.now();
    const check = setInterval(() => {
      const has = window.__agReadLog.some(x => x.kind === 'fetch-chunk' && x.url?.includes('StreamAgentStateUpdates') && x.chunk.includes(cascadeId) && x.ts > t0);
      if (has || Date.now() - t0 > 4000) { clearInterval(check); resolve(); }
    }, 100);
  });
};

window.postAndReadAuto = async (text, cascadeId, opts = {}, timeoutMs = 120000) => {
  const allSteps = opts.all === true;
  window.__agReadLog = window.__agReadLog.filter(x => !x.chunk?.includes(cascadeId));
  await window.activateStream(cascadeId);
  const sentAt = Date.now();
  await window.postToChat(cascadeId, text);
  return new Promise((resolve, reject) => {
    let lastRunningTs = 0, lastIdleTs = 0, lastContentTs = 0;
    const iv = setInterval(() => {
      const now = Date.now();
      const newChunks = window.__agReadLog.filter(x => x.kind === 'fetch-chunk' && x.ts >= sentAt && x.chunk?.includes(cascadeId));
      for (const ch of newChunks) {
        if (ch.chunk.includes('"CASCADE_RUN_STATUS_RUNNING"')) lastRunningTs = ch.ts;
        if (ch.chunk.includes('"CASCADE_RUN_STATUS_IDLE"')) lastIdleTs = ch.ts;
        if (ch.chunk.includes('"modifiedResponse"') || ch.chunk.includes('"text"')) lastContentTs = ch.ts;
      }
      if (lastIdleTs > 0 && lastIdleTs >= lastRunningTs && (now - lastContentTs > 2000) && (now - lastIdleTs > 1500)) {
        clearInterval(iv);
        const raw = [];
        const seen = new Set();
        for (const ch of newChunks) {
          const matches = [...ch.chunk.matchAll(/"(?:modifiedResponse|text)":"((?:[^"\\]|\\.)*)"/g)];
          for (const m of matches) {
            const r = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            if (r.trim() && !seen.has(r)) { seen.add(r); raw.push(r); }
          }
        }
        const steps = raw.filter((r, i) => !raw.some((other, j) => j > i && other.startsWith(r) && other.length > r.length));
        resolve({ answer: allSteps ? steps.join('\n\n---\n\n') : (steps.at(-1) || ''), steps });
      }
      if (now - sentAt > timeoutMs) { clearInterval(iv); reject(new Error('Timeout')); }
    }, 400);
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
  window.sendTo(chatIndex, text, opts || {})
    .then(r => localStorage.setItem('__res_' + reqId, JSON.stringify({ answer: r.answer, steps: r.steps })))
    .catch(e => localStorage.setItem('__res_' + reqId, JSON.stringify({ answer: `ERROR: ${e}` })));
}, 200);

console.log('%c🚀 Bridge v12 — Pure Discovery READY', 'color:gold; font-weight:bold');