// ANTIGRAVITY BRIDGE SCRIPT v26 — STATE-AWARE
const _origFetch = window.fetch;
window.__origFetch = _origFetch;

window.__agLogs = window.__agLogs || [];
window.__agReadLog = window.__agReadLog || [];
// ── SHARED STATE (localStorage backed) ──────────────────────
function getRegistry() {
    try { return JSON.parse(localStorage.getItem('__ag_registry') || '{}'); } catch(e) { return {}; }
}
function setRegistry(reg) {
    localStorage.setItem('__ag_registry', JSON.stringify(reg));
    window.__chatRegistry = reg;
}
function getBusyState() {
    try { return JSON.parse(localStorage.getItem('__ag_busy') || '{}'); } catch(e) { return {}; }
}
function setBusyState(busy) {
    localStorage.setItem('__ag_busy', JSON.stringify(busy));
    window.__busyAgents = busy;
    if (window.__agVerbose) {
        log(`⚙️ [STATE] Busy status updated: ${JSON.stringify(busy)}`, 'debug');
    }
}

window.__agLogs = window.__agLogs || [];
window.__agReadLog = window.__agReadLog || [];
window.__chatRegistry = getRegistry();
window.__chatNames = JSON.parse(localStorage.getItem('__ag_names') || '{}');
window.__busyAgents = getBusyState();
window.__activeReaders = {};
window.__activeStreamCount = 0;
window.__cmdActive = false;
window.__lastOutputs = window.__lastOutputs || {};
window.__lastPrompts = window.__lastPrompts || {};
window.__agLogHeartbeat = localStorage.getItem('__ag_log_heartbeat') === 'true';
window.__agCliTimeout = parseInt(localStorage.getItem('__ag_cli_timeout') || '600000');
window.__agTimeout = parseInt(localStorage.getItem('__ag_timeout') || '180000');

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

// ── KEYBOARD SHORTCUTS ──────────────────────────────────────
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (window.__relinkMode) {
            log(`🚫 [RELINK] Cancelled via ESCAPE`, 'warn');
            window.__relinkMode = null;
            window.__relinkOldId = null;
        }
    }
}, true);

// ── FETCH WRAPPER (Passive Tap) ─────────────────────────────
window.fetch = async function(...args) {
    const urlStr = args[0]?.toString() || "";
    const res = await _origFetch.apply(this, arguments);

    if (urlStr.includes('StreamAgentStateUpdates')) {
        window.__activeStreamCount++;
        log(`🌊 [PASSIVE] Stream Tap Started (#${window.__activeStreamCount}) | URL: ${urlStr}`, 'info');
        log(`👀 [USER ACTIVITY] Manual tab switch or chat hydration detected.`, 'info');
        if (args[1]) {
            log(`📡 [DEBUG] Stream Options: ${JSON.stringify({ headers: args[1].headers, method: args[1].method })}`, 'debug');
        }
        
        const cloned = res.clone();
        const reader = cloned.body.getReader();
        const decoder = new TextDecoder();
        let activeConversationId = null;

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

                    // 🆕 AUTO-DISCOVERY OF NEW CHATS (Cross-Window Safe)
                    const m = chunk.match(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/);
                    if (m) {
                        activeConversationId = m[1];
                        const reg = getRegistry();
                        const existingValues = Object.values(reg);
                        if (!existingValues.includes(activeConversationId)) {
                            // 🆕 Discovery Logic: Prioritize Relink Mode
                            let targetIdx = window.__relinkMode;
                            if (targetIdx) {
                                log(`🔗 [RELINK-DISCOVERY] Mapping ${activeConversationId.slice(0,8)} to Slot ${targetIdx}`, 'success');
                                window.__relinkMode = null;
                                window.__relinkOldId = null;
                            } else {
                                // Standard auto-discovery
                                targetIdx = 1;
                                while (reg[targetIdx]) targetIdx++;
                                log(`🆕 AUTO-DISCOVERY: Chat ${targetIdx} detected (${activeConversationId.slice(0,8)}...)`, 'success');
                            }
                            
                            reg[targetIdx] = activeConversationId;
                            setRegistry(reg);
                        }
                    }

                    // Instant peek for the user
                    if (chunk.includes('modifiedResponse')) {
                        const text = chunk.match(/"modifiedResponse":"((?:[^"\\]|\\.)*)"/)?.[1];
                        if (text && activeConversationId) {
                            const clean = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                            const snippet = clean.length > 400 ? '...' + clean.slice(-400) : clean;
                            window.__lastOutputs[activeConversationId] = snippet;
                        }
                    }

                    if (chunk.includes('"userMessage"') || chunk.includes('"role":"user"') || chunk.includes('"role": "user"')) {
                        const text = chunk.match(/"(?:text|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
                        if (text && activeConversationId) {
                            const clean = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                            const snippet = clean.length > 400 ? '...' + clean.slice(-400) : clean;
                            window.__lastPrompts[activeConversationId] = snippet;
                        }
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
                const parsed = JSON.parse(text);
                const headers = Object.fromEntries(new Headers(args[1]?.headers || {}).entries());
                window.__agCaptured = {
                    last: Date.now(),
                    url: urlStr,
                    headers: headers,
                    bodyTemplate: parsed
                };
                log(`📡 [CAPTURE] Endpoint Secured. CSRF: ${headers['x-codeium-csrf-token']?.slice(0,8)}...`, 'success');
            } catch (e) {
                log(`📡 [CAPTURE ERROR] Failed to parse body: ${e.message}`, 'error');
            }
        }
    }
    return res;
};

// ── PROACTIVE STREAM (Wakes up background agents) ───────────
window.activateStream = async function(conversationId) {
    const c = window.__agCaptured;
    if (!c) throw new Error("No context captured for proactive stream.");

    log(`⚙️ [PROACTIVE] Activating stream for ${conversationId.slice(0,8)}...`, 'info');
    
    try {
        const csrf = c.headers['x-codeium-csrf-token'];
        const base = c.url.replace('SendUserCascadeMessage', 'StreamAgentStateUpdates');
        
        // Construct Connect-Protocol Binary Envelope
        const json = JSON.stringify({ conversationId, subscriberId: crypto.randomUUID() });
        const jsonBytes = new TextEncoder().encode(json);
        const envelope = new Uint8Array(5 + jsonBytes.length);
        
        envelope[0] = 0x00; // Uncompressed
        new DataView(envelope.buffer).setUint32(1, jsonBytes.length, false); // Big-Endian Length
        envelope.set(jsonBytes, 5);

        log(`📡 [PROACTIVE] POST -> ${base} (${jsonBytes.length} bytes)`, 'debug');

        const res = await _origFetch(base, {
            method: 'POST',
            headers: {
                ...c.headers,
                'content-type': 'application/connect+json',
                'connect-protocol-version': '1'
            },
            body: envelope
        });

        if (!res.ok) {
            log(`❌ [PROACTIVE] Activation failed: ${res.status}`, 'error');
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        window.__activeReaders = window.__activeReaders || {};
        window.__activeReaders[conversationId] = reader;

        log(`🌊 [PROACTIVE] Stream established for ${conversationId.slice(0,8)}`, 'success');

        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        log(`🏁 [PROACTIVE] Stream closed for ${conversationId.slice(0,8)}`, 'info');
                        break;
                    }
                    const chunk = decoder.decode(value, { stream: true });
                    window.__agReadLog.push({ ts: Date.now(), source: 'proactive', conversationId, payload: chunk });
                    
                    // Dashboard updates for background agents
                    if (chunk.includes('modifiedResponse')) {
                        const text = chunk.match(/"modifiedResponse":"((?:[^"\\]|\\.)*)"/)?.[1];
                        if (text) {
                            const clean = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                            const snippet = clean.length > 400 ? '...' + clean.slice(-400) : clean;
                            window.__lastOutputs[conversationId] = snippet;
                        }
                    }

                    if (chunk.includes('"CASCADE_RUN_STATUS_RUNNING"')) {
                        const busy = getBusyState();
                        busy[conversationId] = true;
                        setBusyState(busy);
                    }
                    if (chunk.includes('"CASCADE_RUN_STATUS_IDLE"')) {
                        const busy = getBusyState();
                        busy[conversationId] = false;
                        setBusyState(busy);
                    }
                    
                    // Trace logs for debugging
                    if (window.__agVerbose) {
                        log(`📥 [PROACTIVE] Chunk received (${chunk.length} bytes)`, 'debug');
                    }
                }
            } catch (e) {
                log(`❌ [PROACTIVE] Read error for ${conversationId.slice(0,8)}: ${e.message}`, 'error');
            } finally {
                delete window.__activeReaders[conversationId];
            }
        })();
    } catch (e) {
        log(`❌ [PROACTIVE] Fatal activation error: ${e.message}`, 'error');
    }
};
// ── POST AND READ (The "8s Silence" Logic) ────────────────
window.postAndReadAuto = async function(prompt, cascadeId, allSteps = false) {
    const c = window.__agCaptured;
    if (!c) throw new Error("No context captured. Type one message manually.");

    // BUSY GUARD: Determine conversationId and chatIdx from registry
    let conversationId = cascadeId;
    let chatIdx = "?";

    const entryByValue = Object.entries(window.__chatRegistry).find(([, id]) => id === cascadeId);
    if (entryByValue) {
        chatIdx = entryByValue[0];
    } else {
        const entryByIndex = Object.entries(window.__chatRegistry).find(([idx]) => cascadeId.startsWith(`ag-${idx}-`));
        if (entryByIndex) {
            chatIdx = entryByIndex[0];
            conversationId = entryByIndex[1];
        }
    }

    if (!conversationId || conversationId.length < 10) {
        log(`⚠️ [ORCHESTRATION] Unknown agent for cascade ${cascadeId}. Registry state: ${JSON.stringify(window.__chatRegistry)}`, 'warn');
        throw new Error(`Agent not discovered yet. Please focus the chat for ${cascadeId} briefly or wait for auto-discovery.`);
    }

    if (window.__busyAgents[conversationId]) {
        const last = window.__lastOutputs[conversationId] || "Thinking...";
        throw new Error(`AGENT ${chatIdx} STILL WORKING. LAST OUTPUT: ${last}`);
    }

    const busy = getBusyState();
    busy[conversationId] = true;
    setBusyState(busy);

    window.__lastPrompts[conversationId] = (prompt.length > 400) ? '...' + prompt.slice(-400) : prompt;

    // PROACTIVE WAKEUP
    await window.activateStream(conversationId).catch(e => log(`⚠️ Stream wakeup failed: ${e.message}`, 'warn'));

    log(`🧹 Purging old chunks for cascade ${cascadeId.slice(0,8)}...`);
    window.__agReadLog = window.__agReadLog.filter(x => !x.payload?.includes(cascadeId));

    log(`🚀 DISPATCH (Agent ${chatIdx}): "${prompt.slice(0,40)}..."`, 'info');
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
            const allRelevant = window.__agReadLog.filter(x => x.ts >= sentAt && x.payload?.includes(cascadeId));
            
            // 🛡️ REPLAY PROTECTION: If we have proactive data, ignore passive (which may be history replay)
            const proactive = allRelevant.filter(x => x.source === 'proactive');
            const relevant = proactive.length > 0 ? proactive : allRelevant;

            for (const ch of relevant) {
                lastChunkTs = Math.max(lastChunkTs, ch.ts);
                if (ch.payload.includes('"CASCADE_RUN_STATUS_RUNNING"')) lastRunningTs = ch.ts;
                if (ch.payload.includes('"CASCADE_RUN_STATUS_IDLE"'))    lastIdleTs = ch.ts;
                
                // ⚡ FAST-EXIT SIGNAL DETECTION (Strictly trust proactive if available)
                const canTrust = proactive.length > 0 ? (ch.source === 'proactive') : true;
                if (canTrust && (ch.payload.includes('"terminationReason"') || ch.payload.includes('"artifactSnapshotsUpdate"'))) {
                    if (!isFastExit) {
                        log(`⚡ FAST-EXIT: Termination signal detected (${ch.source})! Resolving...`, 'success');
                        isFastExit = true;
                    }
                }
            }

            const isIdle = lastIdleTs > 0 && lastIdleTs >= lastRunningTs;
            const silenceTime = lastChunkTs > 0 ? (now - lastChunkTs) : (now - sentAt);
            const canResolve = isFastExit || (isIdle && (silenceTime > SILENCE_MS));

            if (window.__agLogHeartbeat && (now - sentAt) % 2500 < 600 && !isFastExit) {
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
                window.__busyAgents[conversationId] = false;
                reject(new Error(`Timeout. Chunks: ${relevant.length}`));
            }
        }, 500);
    }).finally(() => {
        const busy = getBusyState();
        busy[conversationId] = false;
        setBusyState(busy);
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