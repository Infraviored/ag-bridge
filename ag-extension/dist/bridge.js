// 🚀 ANTIGRAVITY BRIDGE ORCHESTRATOR
const VERSION = '1.1.2';

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
}
function getQuotas() {
    try { return JSON.parse(localStorage.getItem('__ag_quotas') || '{}'); } catch(e) { return {}; }
}
function setQuotas(q) {
    localStorage.setItem('__ag_quotas', JSON.stringify(q));
    window.__agentQuotas = q;
}

window.__agId = Math.random().toString(36).substring(7);
window.__agLogs = window.__agLogs || [];
window.__agReadLog = window.__agReadLog || [];
window.__chatRegistry = getRegistry();
window.__agentQuotas = getQuotas();
window.__chatNames = JSON.parse(localStorage.getItem('__ag_names') || '{}');

// ── STARTUP SANITIZER (Only clear VERY old ghosts, e.g. > 30 mins) ──
function sanitizeBusyState() {
    const busy = getBusyState();
    const now = Date.now();
    for (const id in busy) {
        if (!busy[id].startTime || (now - busy[id].startTime > 30 * 60 * 1000)) {
            delete busy[id];
        }
    }
    setBusyState(busy); // Always set it so window.__busyAgents is initialized
}
sanitizeBusyState();

// Clear stale command mailboxes
localStorage.removeItem('__cmd');
for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('__ag_cmd_')) localStorage.removeItem(key);
}

window.__activeReaders = {};
window.__activeStreamCount = 0;
window.__cmdActive = false;
window.__lastOutputs = window.__lastOutputs || {};
window.__lastPrompts = window.__lastPrompts || {};
window.__activeTrajectories = window.__activeTrajectories || {};
window.__agLogHeartbeat = localStorage.getItem('__ag_log_heartbeat') === 'true';
window.__agCliTimeout = parseInt(localStorage.getItem('__ag_cli_timeout') || '600000');
window.__agTimeout = parseInt(localStorage.getItem('__ag_timeout') || '180000');

// ── GARBAGE COLLECTOR (Response TTL Sweeper) ──────────────────
setInterval(() => {
    let count = 0;
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('__res_')) {
            // Sweep everything. In production we'd check timestamps, 
            // but since agbridge is sync, any __res_ in localStorage 
            // that isn't picked up in 60s is junk.
            localStorage.removeItem(key);
            count++;
        }
    }
    if (count > 0 && window.__agVerbose) log(`🧹 GC: Purged ${count} stale responses.`, 'debug');
}, 60000);

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

console.log(`%c🚀 Bridge v${VERSION} loaded — TRUE PARALLELISM`, 'color:magenta; font-weight:bold; font-size:14px');

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
                        
                        // 🛡️ IGNORE DEVELOPER CHAT: Don't register the conversation we are currently using for orchestration
                        const developerConvId = window.__agCaptured?.bodyTemplate?.conversationId;
                        if (activeConversationId === developerConvId) {
                            // Skip discovery for self
                        } else if (!existingValues.includes(activeConversationId)) {
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
                            window.__lastOutputs[activeConversationId] = { text: snippet, ts: Date.now() };
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
                            window.__lastOutputs[conversationId] = { text: snippet, ts: Date.now() };
                        }
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
        const busyInfo = window.__busyAgents[conversationId];
        const last = window.__lastOutputs[conversationId] || "Thinking...";
        throw new Error(`AGENT ${chatIdx} STILL WORKING (Window: ${busyInfo.windowId}). LAST OUTPUT: ${last}`);
    }

    const busy = getBusyState();
    busy[conversationId] = { status: 'RUNNING', windowId: window.__agId, startTime: Date.now() };
    setBusyState(busy);

    window.__lastPrompts[conversationId] = (prompt.length > 400) ? '...' + prompt.slice(-400) : prompt;

    // PROACTIVE WAKEUP
    await window.activateStream(conversationId).catch(e => log(`⚠️ Stream wakeup failed: ${e.message}`, 'warn'));

    // DELAY & PURGE: Wait 1.5s for history replay burst to arrive before purging
    log(`⏳ Absorbing history replay...`, 'debug');
    await new Promise(r => setTimeout(r, 1500));

    log(`🧹 Purging old chunks for cascade ${cascadeId.slice(0,8)}...`);
    window.__agReadLog = window.__agReadLog.filter(x => !x.payload?.includes(cascadeId));

    log(`🚀 DISPATCH [ID: ${cascadeId.slice(0,8)}] (Agent ${chatIdx}): "${prompt.slice(0,40)}..."`, 'info');
    const payload = { ...c.bodyTemplate, cascadeId, items: [{ text: prompt }], sentAt: new Date().toISOString() };
    
    const res = await _origFetch(c.url, {
        method: 'POST',
        headers: c.headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`POST Failed: ${res.status}`);

    // DETERMINISTIC TRAJECTORY FILTERING: Extract the unique ID for this specific turn
    let activeTrajectoryId = null;
    try {
        const clonedRes = res.clone();
        const json = await clonedRes.json();
        
        // 🚨 PERMANENT TRAP FOR SERVER JSON
        log(`🚨 POST RESPONSE JSON CAPTURED:`, 'magenta');
        console.log(json);
        
        activeTrajectoryId = json.update?.trajectoryId;
        if (activeTrajectoryId) {
            window.__activeTrajectories[conversationId] = activeTrajectoryId;
            log(`🎯 SESSION KEY: ${activeTrajectoryId.slice(0,8)} (Trajectory Filter Active)`, 'debug');
        }
    } catch(e) {
        log(`⚠️ Failed to parse trajectoryId: ${e.message}`, 'warn');
    }

    const sentAt = Date.now();
    log(`📬 POST OK. Watching (sentAt=${sentAt}, patience=${window.__agTimeout}ms)...`, 'info');

    let lastRunningTs = 0, lastIdleTs = 0, lastChunkTs = 0;
    let isFastExit = false;
    const globalTimeoutMs = window.__agCliTimeout || 600000;
    const SILENCE_MS = window.__agTimeout;

    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            const now = Date.now();
            
            // 🛡️ TRAJECTORY FILTER: Deterministically ignore all history/replay/other chunks
            const allRelevant = window.__agReadLog.filter(x => {
                if (x.ts < sentAt) return false;
                if (!x.payload?.includes(cascadeId)) return false;
                if (activeTrajectoryId && !x.payload?.includes(activeTrajectoryId)) return false;
                return true;
            });
            
            // 🛡️ REPLAY PROTECTION: If we have proactive data, ignore passive (which may be history replay)
            const proactive = allRelevant.filter(x => x.source === 'proactive');
            const relevant = proactive.length > 0 ? proactive : allRelevant;

            for (const ch of relevant) {
                // 🛡️ REPLAY POLLUTION GUARD: Peek for internal timestamp
                const internalTsStr = ch.payload.match(/"sentAt"\s*:\s*"([^"]+)"/)?.[1];
                const internalTs = internalTsStr ? new Date(internalTsStr).getTime() : 0;
                
                // If the chunk is internally dated BEFORE our POST (with 5s buffer), it's a replay.
                if (internalTs > 0 && internalTs < sentAt - 5000) {
                    continue; 
                }

                lastChunkTs = Math.max(lastChunkTs, ch.ts);
                if (ch.payload.includes('"CASCADE_RUN_STATUS_RUNNING"')) lastRunningTs = ch.ts;
                if (ch.payload.includes('"CASCADE_RUN_STATUS_IDLE"'))    lastIdleTs = ch.ts;
                
                // ⚡ FAST-EXIT SIGNAL DETECTION (Strictly trust proactive if available)
                const canTrust = proactive.length > 0 ? (ch.source === 'proactive') : true;
                if (canTrust && ch.payload.includes('"terminationReason"')) {
                    
                    // 💰 QUOTA DETECTION
                    if (ch.payload.includes('"EXECUTOR_TERMINATION_REASON_ERROR"')) {
                        const q = getQuotas();
                        q[cascadeId] = true;
                        setQuotas(q);
                    } else if (ch.payload.includes('"EXECUTOR_TERMINATION_REASON_IDLE"')) {
                        const q = getQuotas();
                        if (q[cascadeId]) { delete q[cascadeId]; setQuotas(q); }
                    }

                    if (!isFastExit) {
                        log(`⚡ FAST-EXIT: Termination signal detected! (Source: ${ch.source}, InternalTs: ${internalTsStr || 'unknown'})`, 'success');
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

                // 🧟 GHOST WORK MONITOR: Audit if the agent continues working after "terminationReason"
                if (isFastExit) {
                    const exitTs = Date.now();
                    const ghostIv = setInterval(() => {
                        const now = Date.now();
                        if (now - exitTs > 30000) { clearInterval(ghostIv); return; }
                        
                        const leaked = window.__agReadLog.filter(x => 
                            x.ts > exitTs && !x.__reported &&
                            x.payload?.includes(cascadeId) && 
                            (activeTrajectoryId ? x.payload?.includes(activeTrajectoryId) : true) &&
                            x.payload?.includes('"modifiedResponse"')
                        );
                        
                        if (leaked.length > 0) {
                            log(`🚨 GHOST WORK DETECTED! Agent ${chatIdx} sent ${leaked.length} chunks AFTER termination signal.`, 'error');
                            leaked.forEach(x => x.__reported = true);
                        }
                    }, 1000);
                }

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
                
                // 💰 QUOTA DETECTION: If error reason is found and we have no real response, it's a quota wall.
                if (fullText.includes('"EXECUTOR_TERMINATION_REASON_ERROR"') && steps.length < 2) {
                    log(`✅ RESOLVED: QUOTA EXCEEDED signal captured.`, 'success');
                    resolve("QUOTA EXCEEDED");
                    return;
                }

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
        delete busy[conversationId];
        setBusyState(busy);
    });
};

// ── COMMAND DISPATCHER (Parallel Scanner) ──────────────────
(function startCommandDispatcher() {
    log('📡 Dispatcher standing by.', 'info');
    setInterval(() => {
        // Scan for all pending unique command mailboxes
        const keys = Object.keys(localStorage).filter(k => k.startsWith('__ag_cmd_'));
        if (keys.length === 0) {
            const legacy = localStorage.getItem('__cmd');
            if (legacy) {
                localStorage.removeItem('__cmd');
                processCommand(legacy);
            }
            return;
        }

        keys.forEach(targetKey => {
            const raw = localStorage.getItem(targetKey);
            if (!raw) return;

            try {
                const cmd = JSON.parse(raw);
                const cascadeId = window.__chatRegistry[cmd.chatIndex];
                
                // PARALLEL GUARD: Only pick up if the target agent isn't already busy
                if (cascadeId && !window.__busyAgents[cascadeId]) {
                    localStorage.removeItem(targetKey); // Acknowledge
                    processCommand(raw);
                }
            } catch (e) {
                log(`❌ Dispatcher crashed while reading command: ${e.message}`, 'error');
                try {
                    const reqIdMatch = raw.match(/"reqId"\s*:\s*"([^"]+)"/);
                    if (reqIdMatch) {
                        localStorage.setItem(`__res_${reqIdMatch[1]}`, JSON.stringify({ answer: `BRIDGE CRASH: ${e.message}` }));
                    }
                } catch(e2) {}
                localStorage.removeItem(targetKey);
            }
        });
    }, 400);

    function processCommand(raw) {
        try {
            const cmd = JSON.parse(raw);
            const { chatIndex, text, reqId, opts } = cmd;
            const cascadeId = window.__chatRegistry[chatIndex];
            
            if (window.__agVerbose) log(`📩 Received command [${reqId}] for Agent ${chatIndex}`, 'debug');

            if (!cascadeId) {
                localStorage.setItem(`__res_${reqId}`, JSON.stringify({ answer: `ERROR: No chat ${chatIndex}` }));
                return;
            }
            window.postAndReadAuto(text, cascadeId, opts?.all || false)
                .then(answer => {
                    localStorage.setItem(`__res_${reqId}`, JSON.stringify({ answer }));
                })
                .catch(err => {
                    localStorage.setItem(`__res_${reqId}`, JSON.stringify({ answer: `ERROR: ${err.message}` }));
                });
        } catch (e) {
            log(`❌ Dispatch Error: ${e.message}`, 'error');
        }
    }
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