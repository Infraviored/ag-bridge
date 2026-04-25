// ANTIGRAVITY BRIDGE SCRIPT v26 — STATE-AWARE
const _origFetch = window.fetch;
window.__origFetch = _origFetch;

window.__agLogs = window.__agLogs || [];
window.__agReadLog = window.__agReadLog || [];
window.__chatRegistry = window.__chatRegistry || {};
window.__chatNames = window.__chatNames || {};
window.__activeReaders = {};
window.__activeStreamCount = 0;
window.__cmdActive = false;

// ── VERBOSE LOGGING ─────────────────────────────────────────
function log(msg, level = 'info') {
    const entry = { ts: Date.now(), msg: `[BRIDGE] ${msg}` };
    window.__agLogs.push(entry);
    const styles = {
        info: 'color:gold',
        warn: 'color:orange; font-weight:bold',
        error: 'color:white; background:red; font-weight:bold; padding: 2px 4px',
        success: 'color:lime; font-weight:bold',
        debug: 'color:cyan; font-size: 10px',
        term: 'color:red; font-weight:heavy; font-size: 14px; text-decoration: underline'
    };
    console.log(`%c${entry.msg}`, styles[level] || styles.info);
}

console.log('%c🚀 Bridge v26 loaded — STATE-AWARE ORCHESTRATION', 'color:magenta; font-weight:bold; font-size:14px');

// ── FETCH WRAPPER (Passive Tap) ─────────────────────────────
window.fetch = async function(...args) {
    const urlStr = args[0]?.toString() || "";
    const res = await _origFetch.apply(this, arguments);

    if (urlStr.includes('StreamAgentStateUpdates')) {
        window.__activeStreamCount++;
        log(`🌊 [PASSIVE] Stream Tap Started (#${window.__activeStreamCount})`, 'info');
        
        const cloned = res.clone();
        const reader = cloned.body.getReader();
        const decoder = new TextDecoder();

        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        log(`🏁 [PASSIVE] STREAM-DONE (Server Closed)`, 'term');
                        window.__activeStreamCount--;
                        break;
                    }
                    const chunk = decoder.decode(value, { stream: true });
                    window.__agReadLog.push({ ts: Date.now(), source: 'passive', payload: chunk });

                    // 🆕 AUTO-DISCOVERY OF NEW CHATS
                    const m = chunk.match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
                    if (m) {
                        const id = m[1];
                        if (!Object.values(window.__chatRegistry).includes(id)) {
                            const idx = Object.keys(window.__chatRegistry).length + 1;
                            window.__chatRegistry[idx] = id;
                            log(`🆕 AUTO-DISCOVERY: Chat ${idx} detected (${id.slice(0,8)}...)`, 'success');
                        }
                    }

                    // Instant peek for the user
                    if (chunk.includes('modifiedResponse')) {
                        log(`📝 [PASSIVE] Data: ${chunk.match(/"modifiedResponse":"((?:[^"\\]|\\.)*)"/)?.[1]?.slice(0,60)}...`, 'debug');
                    }
                }
            } catch (e) { 
                if (!e.message.includes('aborted')) {
                    log(`❌ [PASSIVE] Stream Error: ${e.message}`, 'error');
                }
                window.__activeStreamCount--;
            }
        })();
    }

    if (urlStr.includes('SendUserCascadeMessage')) {
        const body = args[1]?.body;
        if (body) {
            try {
                const text = typeof body === 'string' ? body : await (new Response(body)).text();
                window.__agCaptured = {
                    last: Date.now(),
                    url: urlStr,
                    headers: args[1]?.headers || {},
                    bodyTemplate: JSON.parse(text)
                };
                log(`📡 [CAPTURE] Endpoint & Headers secured.`, 'success');
            } catch (e) {}
        }
    }
    return res;
};

// ── PROACTIVE STREAM (v5 Style) ─────────────────────────────
// ── POST AND READ (The "8s Silence" Logic) ────────────────
window.postAndReadAuto = async function(prompt, cascadeId, allSteps = false) {
    const c = window.__agCaptured;
    if (!c) throw new Error("No context captured. Type one message manually.");

    log(`🧹 Purging old chunks for cascade ${cascadeId.slice(0,8)}...`);
    window.__agReadLog = window.__agReadLog.filter(x => !x.payload?.includes(cascadeId));

    log(`🚀 DISPATCH: "${prompt.slice(0,40)}..."`, 'info');
    const payload = { ...c.bodyTemplate, cascadeId, items: [{ text: prompt }], sentAt: new Date().toISOString() };
    
    const res = await _origFetch(c.url, {
        method: 'POST',
        headers: c.headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`POST Failed: ${res.status}`);

    const sentAt = Date.now();
    log(`📬 POST OK. Watching (sentAt=${sentAt}, patience=${window.__agTimeout}ms)...`, 'info');

    let lastRunningTs = 0, lastIdleTs = 0, lastChunkTs = 0;
    let isFastExit = false;
    const globalTimeoutMs = window.__agCliTimeout || 600000; // Match CLI or 10m fallback
    const SILENCE_MS = window.__agTimeout;

    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            const now = Date.now();
            const relevant = window.__agReadLog.filter(x => x.ts >= sentAt && x.payload?.includes(cascadeId));

            for (const ch of relevant) {
                lastChunkTs = Math.max(lastChunkTs, ch.ts);
                if (ch.payload.includes('"CASCADE_RUN_STATUS_RUNNING"')) lastRunningTs = ch.ts;
                if (ch.payload.includes('"CASCADE_RUN_STATUS_IDLE"'))    lastIdleTs = ch.ts;
                
                // ⚡ FAST-EXIT SIGNAL DETECTION
                if (ch.payload.includes('"terminationReason"') || ch.payload.includes('"artifactSnapshotsUpdate"')) {
                    if (!isFastExit) {
                        log(`⚡ FAST-EXIT: Termination signal detected! Resolving...`, 'success');
                        isFastExit = true;
                    }
                }
            }

            const isIdle = lastIdleTs > 0 && lastIdleTs >= lastRunningTs;
            const silenceTime = lastChunkTs > 0 ? (now - lastChunkTs) : (now - sentAt);
            const canResolve = isFastExit || (isIdle && (silenceTime > SILENCE_MS));

            if ((now - sentAt) % 2500 < 600 && !isFastExit) {
                const state = lastRunningTs > lastIdleTs ? 'RUNNING' : (lastIdleTs > 0 ? 'IDLE' : 'WAITING');
                const suffix = state === 'RUNNING' ? ` (Waiting for tool... ${((globalTimeoutMs - (now - sentAt))/1000).toFixed(0)}s left)` : ` (Silence: ${(silenceTime/1000).toFixed(1)}s/${SILENCE_MS/1000}s)`;
                log(`⏳ HEARTBEAT: Chunks=${relevant.length} | State=${state}${suffix}`, 'debug');
            }

            if (canResolve) {
                clearInterval(iv);
                const fullText = relevant.map(x => x.payload).join('');
                const matches = [...fullText.matchAll(/"(?:modifiedResponse|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
                const raw = matches.map(m => m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
                
                // DETERMINISTIC DUMP (Conditional)
                if (window.__agVerbose && relevant.length > 0) {
                    log(`🏁 --- TRIPLE DUMP START (Total Chunks: ${relevant.length}) ---`, 'warn');
                    log(`[1/3] FIRST CHUNK:\n${relevant[0].payload}`, 'debug');
                    if (relevant.length > 2) log(`[2/3] PENULTIMATE CHUNK:\n${relevant.at(-2).payload}`, 'debug');
                    log(`[3/3] FINAL CHUNK:\n${relevant.at(-1).payload}`, 'debug');
                    log(`🏁 --- TRIPLE DUMP END ---`, 'warn');
                }

                const steps = raw.filter((r, i) => !raw.some((other, j) => j > i && other.startsWith(r) && other.length > r.length));
                const finalAnswer = allSteps ? steps.join('\n\n---\n\n') : (steps.at(-1) || '');
                log(`✅ RESOLVED: ${steps.length} steps captured.`, 'success');
                resolve(finalAnswer);
            }

            if (now - sentAt > globalTimeoutMs) {
                clearInterval(iv);
                log(`❌ TIMEOUT (${globalTimeoutMs/1000}s): Total chunks=${relevant.length}, lastIdle=${lastIdleTs>0}`, 'error');
                reject(new Error(`Timeout. Chunks: ${relevant.length}`));
            }
        }, 500);
    });
};

// ── COMMAND DISPATCHER ──────────────────────────────────────
(function startCommandDispatcher() {
    log('📡 Dispatcher standing by.', 'info');
    setInterval(() => {
        const raw = localStorage.getItem('__cmd');
        if (!raw || window.__cmdActive) return;
        localStorage.removeItem('__cmd');
        window.__cmdActive = true;
        const cmd = JSON.parse(raw);
        const { chatIndex, text, reqId, opts } = cmd;
        const cascadeId = window.__chatRegistry[chatIndex];
        if (!cascadeId) {
            localStorage.setItem(`__res_${reqId}`, JSON.stringify({ answer: `ERROR: No chat ${chatIndex}` }));
            window.__cmdActive = false;
            return;
        }
        window.postAndReadAuto(text, cascadeId, opts?.all || false)
            .then(answer => {
                localStorage.setItem(`__res_${reqId}`, JSON.stringify({ answer }));
                window.__cmdActive = false;
            })
            .catch(err => {
                localStorage.setItem(`__res_${reqId}`, JSON.stringify({ answer: `ERROR: ${err.message}` }));
                window.__cmdActive = false;
            });
    }, 300);
})();

// ── DIAGNOSTIC TOOL ─────────────────────────────────────────
window.dumpBridge = () => {
    console.table(window.__agReadLog.slice(-20).map(x => ({
        time: new Date(x.ts).toLocaleTimeString(),
        src: x.source,
        len: x.payload.length,
        data: x.payload.slice(0, 100)
    })));
};