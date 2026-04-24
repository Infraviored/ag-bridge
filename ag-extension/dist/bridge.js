// ════════════════════════════════════════════════════════════
// ANTIGRAVITY BRIDGE SCRIPT v18 — 5s Patience & Stream-Done
// ════════════════════════════════════════════════════════════
const _origFetch = window.fetch;
window.__origFetch = _origFetch;

window.__agLogs = window.__agLogs || [];
window.__agReadLog = window.__agReadLog || [];
window.__chatRegistry = window.__chatRegistry || {};
window.__chatNames = window.__chatNames || {};
window.__relinkMode = null;
window.__relinkOldId = null;

function log(msg) {
    const entry = { ts: Date.now(), msg: `[BRIDGE] ${msg}` };
    window.__agLogs.push(entry);
    console.log(`%c${entry.msg}`, "color:gold");
}

window.fetch = async function(...args) {
    const url = args[0]?.toString() || "";
    const res = await _origFetch.apply(this, arguments);

    if (url.includes('StreamAgentStateUpdates')) {
        const cloned = res.clone();
        const reader = cloned.body.getReader();
        const decoder = new TextDecoder();
        
        // Track stream state globally for postAndReadAuto to see
        window.__activeStreamDone = false;

        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        window.__activeStreamDone = true;
                        break;
                    }
                    const chunk = decoder.decode(value, { stream: true });
                    window.__agReadLog.push({
                        ts: Date.now(),
                        url: url,
                        payload: chunk
                    });
                }
            } catch (e) {
                log(`Stream Read Error: ${e.message}`);
                window.__activeStreamDone = true;
            }
        })();
    }

    if (url.includes('SendUserCascadeMessage')) {
        const body = args[1]?.body;
        if (body) {
            try {
                const text = typeof body === 'string' ? body : await (new Response(body)).text();
                const json = JSON.parse(text);
                const cascadeId = json.cascadeId;
                const headers = args[1]?.headers || {};
                
                window.__agCaptured = {
                    last: Date.now(),
                    cascadeId,
                    headers: {
                        'x-codeium-csrf-token': headers['x-codeium-csrf-token'],
                        'cookie': headers['cookie']
                    }
                };
                log(`📡 CAPTURE: Headers & CascadeId (${cascadeId}) captured.`);
            } catch (e) {}
        }
    }
    return res;
};

window.postAndReadAuto = async function(prompt, cascadeId, allSteps = false) {
    const sentAt = Date.now();
    log(`🚀 POST: "${prompt.slice(0,30)}..." to ${cascadeId}`);

    if (!window.__agCaptured?.headers) {
        throw new Error("No security headers captured. Type one message in any chat manually.");
    }

    const res = await _origFetch('https://www.antigravity.com/api/SendUserCascadeMessage', {
        method: 'POST',
        headers: {
            ...window.__agCaptured.headers,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            cascadeId: cascadeId,
            text: prompt,
            sentAt: new Date().toISOString()
        })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let lastRunningTs = 0;
    let lastIdleTs = 0;
    let lastChunkTs = 0;
    const timeoutMs = 90000;

    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            const now = Date.now();
            
            const newChunks = window.__agReadLog.filter(x => 
                x.ts >= sentAt && 
                x.url?.includes('StreamAgentStateUpdates') &&
                x.payload?.includes(cascadeId)
            );

            for (const ch of newChunks) {
                lastChunkTs = Math.max(lastChunkTs, ch.ts);
                if (ch.payload.includes('"CASCADE_RUN_STATUS_RUNNING"')) lastRunningTs = ch.ts;
                if (ch.payload.includes('"CASCADE_RUN_STATUS_IDLE"')) lastIdleTs = ch.ts;
            }

            // PATIENCE RULES:
            const isIdle = lastIdleTs > 0 && lastIdleTs >= lastRunningTs;
            const hasPatience = (now - lastChunkTs > 5000); // 5s Patience
            const isStreamDone = window.__activeStreamDone === true;

            // Resolve IF: (Idle AND 5s passed) OR (Server closed the stream)
            if ((isIdle && hasPatience) || (isIdle && isStreamDone)) {
                clearInterval(iv);
                
                const fullText = newChunks.map(x => x.payload).join('');
                const matches = [...fullText.matchAll(/"(?:modifiedResponse|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
                
                const raw = matches.map(m => m[1]
                    .replace(/\\n/g, '\n')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                );

                const steps = raw.filter((r, i) => 
                    !raw.some((other, j) => j > i && other.startsWith(r) && other.length > r.length)
                );

                const finalAnswer = allSteps ? steps.join('\n\n---\n\n') : (steps.at(-1) || '');
                log(`✅ COMPLETE: Captured ${steps.length} steps. ${isStreamDone ? '(Stream-Done)' : '(Silence-Timeout)'}`);
                resolve(finalAnswer);
            }

            if (now - sentAt > timeoutMs) {
                clearInterval(iv);
                reject(new Error("Response Timeout (90s)"));
            }
        }, 500);
    });
};