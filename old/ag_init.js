// ════════════════════════════════════════════════════════════
// ANTIGRAVITY BRIDGE SCRIPT v5 — DevTools Console
// ════════════════════════════════════════════════════════════
const _origFetch = window.fetch;
window.__origFetch = _origFetch;
window.__agReadLog = [];
window.__agCaptured = { history: [] };
window.__chatRegistry = {};
window.__chatNames = {};
window.__activeReaders = {};

window.fetch = async function (input, init, ...rest) {
  const url = (input instanceof Request ? input.url : input?.url ?? input) || '';
  const urlStr = String(url);
  const result = _origFetch.apply(this, arguments);

  if (urlStr.includes('SendUserCascadeMessage')) {
    const headers = Object.fromEntries(new Headers(init?.headers || {}).entries());
    const body = init?.body ?? null;
    const bodyStr = typeof body === 'string' ? body
      : (body instanceof Uint8Array ? new TextDecoder().decode(body) : '');
    const rec = { url: urlStr, headers, body: bodyStr, ts: Date.now() };
    window.__agCaptured.last = rec;
    window.__agCaptured.history.push(rec);
    console.log(`%c📡 Capture! CSRF=${headers['x-codeium-csrf-token']?.slice(0, 8)}...`, 'color:lime');
  }

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
            const chunk = dec.decode(value, { stream: true });
            window.__agReadLog.push({ kind: 'fetch-chunk', url: urlStr, chunk, ts: Date.now() });
            const m = chunk.match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
            if (m) {
              const id = m[1];
              if (!Object.values(window.__chatRegistry).includes(id)) {
                const idx = Object.keys(window.__chatRegistry).length + 1;
                window.__chatRegistry[idx] = id;
                console.log(`%c🆕 Chat ${idx}: ${id}`, 'color:lime; font-size:14px; font-weight:bold');
              }
            }
          }
        } catch { }
      })();
    }).catch(() => { });
  }

  if (urlStr.includes('GetConversation') || urlStr.includes('GetCascade')) {
    result.then(async res => {
      try {
        const text = await res.clone().text();
        const m = text.match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
        if (m) {
          const id = m[1];
          if (!Object.values(window.__chatRegistry).includes(id)) {
            const idx = Object.keys(window.__chatRegistry).length + 1;
            window.__chatRegistry[idx] = id;
            console.log(`%c🆕 Chat ${idx}: ${id}`, 'color:lime; font-size:14px; font-weight:bold');
          }
        }
      } catch { }
    }).catch(() => { });
  }

  return result;
};

window.postToChat = async (cascadeId, text) => {
  const c = window.__agCaptured.last;
  if (!c) throw new Error('Kein Capture — einmal manuell in einen Chat schreiben!');
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
  if (!c) throw new Error('Kein Capture!');
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
    headers: {
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      'x-codeium-csrf-token': csrf
    },
    body: envelope
  });
  const reader = res.body.getReader();
  window.__activeReaders[cascadeId] = reader;
  const dec = new TextDecoder();
  (async () => {
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
      const has = window.__agReadLog.some(x =>
        x.kind === 'fetch-chunk' &&
        x.url?.includes('StreamAgentStateUpdates') &&
        x.chunk.includes(cascadeId) &&
        x.ts > t0
      );
      if (has || Date.now() - t0 > 4000) { clearInterval(check); resolve(); }
    }, 50);
  });
};

window.postAndReadAuto = async (text, cascadeId, opts = {}, timeoutMs = 90000) => {
  const allSteps = opts.all === true;
  window.__agReadLog = window.__agReadLog.filter(x => !x.chunk?.includes(cascadeId));
  await window.activateStream(cascadeId);
  const sentAt = Date.now();
  await window.postToChat(cascadeId, text);

  return new Promise((resolve, reject) => {
    let lastRunningTs = 0, lastIdleTs = 0;
    const iv = setInterval(() => {
      const now = Date.now();
      const newChunks = window.__agReadLog.filter(x =>
        x.kind === 'fetch-chunk' &&
        x.url?.includes('StreamAgentStateUpdates') &&
        x.chunk?.includes(cascadeId) &&
        x.ts >= sentAt
      );
      for (const ch of newChunks) {
        if (ch.chunk.includes('"CASCADE_RUN_STATUS_RUNNING"')) lastRunningTs = ch.ts;
        if (ch.chunk.includes('"CASCADE_RUN_STATUS_IDLE"')) lastIdleTs = ch.ts;
      }

      if (lastIdleTs > 0 && lastIdleTs >= lastRunningTs && now - lastIdleTs > 3000) {
        clearInterval(iv);

        const raw = [];
        const seen = new Set();
        for (const ch of newChunks)
          for (const m of [...ch.chunk.matchAll(/"modifiedResponse":"((?:[^"\\]|\\.)*)"/g)]) {
            const r = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            if (!seen.has(r)) { seen.add(r); raw.push(r); }
          }

        // j > i: nur frühere Prefixe entfernen, spätere (längere) behalten
        const steps = raw.filter((r, i) =>
          !raw.some((other, j) => j > i && other.startsWith(r) && other.length > r.length)
        );

        const filesSeen = new Set();
        for (const ch of newChunks)
          for (const m of [...ch.chunk.matchAll(/"uri"\s*:\s*"file:\/\/([^"]+)"/g)])
            filesSeen.add(m[1]);
        const files = [...filesSeen];

        const answer = allSteps ? steps.join('\n\n---\n\n') : (steps.at(-1) || '');
        const idx = Object.entries(window.__chatRegistry).find(([, v]) => v === cascadeId)?.[0] || '?';
        const name = window.__chatNames[idx] || `chat${idx}`;

        console.log(`%cAGENT ${idx} | ${name}`, 'color:gold; font-weight:bold; font-size:13px');
        console.log(`%c${answer}`, 'color:cyan');
        if (files.length > 0)
          console.log(`%c📁 ${files.join('\n📁 ')}`, 'color:orange');

        resolve({ answer, steps, files });
      }
      if (now - sentAt > timeoutMs) { clearInterval(iv); reject(new Error('Timeout')); }
    }, 300);
  });
};

window.sendTo = (idx, text, opts = {}) => {
  const id = window.__chatRegistry[idx];
  if (!id) { console.warn(`Kein Chat ${idx}`, window.__chatRegistry); return Promise.reject(`Kein Chat ${idx}`); }
  return window.postAndReadAuto(text, id, opts);
};

// IPC Loop für node send.mjs
setInterval(() => {
  const cmd = localStorage.getItem('__cmd');
  if (!cmd) return;
  localStorage.removeItem('__cmd');
  const { chatIndex, text, reqId, opts } = JSON.parse(cmd);
  window.sendTo(chatIndex, text, opts || {})
    .then(r => localStorage.setItem('__res_' + reqId, JSON.stringify({ answer: r.answer, steps: r.steps, files: r.files })))
    .catch(e => localStorage.setItem('__res_' + reqId, JSON.stringify({ answer: `ERROR: ${e}` })));
}, 200);

// Beispiele:
// sendTo(1, "schreib hello.py und führ aus")
// sendTo(1, "schreib hello.py und führ aus", { all: true })   ← alle Zwischenschritte
// sendTo("heino", "was ist dein name")                        ← by name
console.log('%c🚀 Bridge v5 bereit — node wizard.mjs starten!', 'color:gold; font-size:14px; font-weight:bold');