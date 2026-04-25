import * as vscode from 'vscode';
import * as http from 'http';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

let statusBarItem: vscode.StatusBarItem;
let dashboardPanel: vscode.WebviewPanel | undefined;
let outputChannel: vscode.OutputChannel;
let bridgeActive = false;
let relinkInProgress: string | null = null;
let pendingDeletes: Set<string> = new Set(); // Guard against race condition
let lastLogIndex = 0;
let isPolling = false;
let lastHeartbeat = 0;

enum BridgeState {
    MissingRDP,
    PromptOnce,
    Active
}

function logToChannel(msg: string) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Antigravity Bridge");
    }
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function getConfigPath(): string {
    const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
    return path.join(root, 'ag-config.json');
}

function loadConfig(): any {
    const configPath = getConfigPath();
    let config: any = { chatNames: {}, chatDuties: {}, registry: {} };
    if (fs.existsSync(configPath)) {
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { }
    }
    if (!config.chatDuties) config.chatDuties = {};
    if (!config.chatNames) config.chatNames = {};
    if (!config.registry) config.registry = {};
    return config;
}

function saveConfig(config: any) {
    const configPath = getConfigPath();
    const cliTimeout = vscode.workspace.getConfiguration('antigravity.bridge').get('cliTimeout', 10);
    config.ts = Date.now();
    config.cliTimeout = cliTimeout;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Global CLI Command Setup
function setupGlobalCommand(extensionPath: string) {
    try {
        const binDir = path.join(process.env.HOME || '', '.local', 'bin');
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
        const scriptPath = path.join(extensionPath, 'send.mjs');
        const linkPath = path.join(binDir, 'agbridge');
        if (fs.existsSync(scriptPath)) fs.chmodSync(scriptPath, '755');
        if (fs.existsSync(linkPath)) {
            try {
                const existing = fs.readlinkSync(linkPath);
                if (existing !== scriptPath) {
                    fs.unlinkSync(linkPath);
                    fs.symlinkSync(scriptPath, linkPath);
                }
            } catch (e) {
                fs.unlinkSync(linkPath);
                fs.symlinkSync(scriptPath, linkPath);
            }
        } else {
            fs.symlinkSync(scriptPath, linkPath);
        }
    } catch (e) {
        logToChannel(`[ERROR] Global command setup failed: ${e}`);
    }
}

async function getAntigravityTab(): Promise<any> {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const tabs = JSON.parse(data);
                    const tab = tabs.find((t: any) => t.url?.includes('workbench.html') && t.type === 'page');
                    resolve(tab);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (e) => reject(e));
    });
}

async function injectBridge() {
    try {
        const tab = await getAntigravityTab();
        if (!tab) {
            updateStatusBar(BridgeState.MissingRDP);
            return;
        }
        const scriptPath = path.join(__dirname, '..', 'dist', 'bridge.js');
        const finalScriptPath = fs.existsSync(scriptPath) ? scriptPath : path.join(__dirname, '..', 'src', 'bridge.js');
        if (!fs.existsSync(finalScriptPath)) return;
        const script = fs.readFileSync(finalScriptPath, 'utf8');

        const config = loadConfig();
        const verbose = vscode.workspace.getConfiguration('antigravity.bridge').get('verbose', false);
        const timeoutMinutes = vscode.workspace.getConfiguration('antigravity.bridge').get('timeout', 1);
        const cliTimeoutMinutes = vscode.workspace.getConfiguration('antigravity.bridge').get('cliTimeout', 10);
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const cliTimeoutMs = cliTimeoutMinutes * 60 * 1000;
        
        const syncScript = `
            Object.assign(window.__chatRegistry, ${JSON.stringify(config.registry || {})});
            Object.assign(window.__chatNames, ${JSON.stringify(config.chatNames || {})});
            window.__agVerbose = ${verbose};
            window.__agTimeout = ${timeoutMs};
            window.__agCliTimeout = ${cliTimeoutMs};
        `;

        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: script + "\n" + syncScript }
            }));
        });
        ws.on('message', (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
                ws.close();
                bridgeActive = true;
                logToChannel("✨ Bridge successfully injected into browser.");
                // Let the poll loop take over status bar from here
            }
        });
        ws.on('error', (e) => {
            logToChannel(`[ERROR] Injection WebSocket error: ${e.message}`);
            updateStatusBar(BridgeState.MissingRDP);
        });
    } catch (e) {
        updateStatusBar(BridgeState.MissingRDP);
    }
}

function updateStatusBar(state: BridgeState) {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.show();
    }
    
    statusBarItem.command = 'agbridge.showDashboard';
    statusBarItem.backgroundColor = undefined;

    switch (state) {
        case BridgeState.MissingRDP:
            statusBarItem.text = '$(error) AG-Bridge: Missing RDP';
            statusBarItem.tooltip = 'Antigravity must be launched with --remote-debugging-port=9222. Please restart the IDE with debugging enabled.';
            statusBarItem.command = 'agbridge.inject'; // Allow retry
            break;
        case BridgeState.PromptOnce:
            statusBarItem.text = '$(question) AG-Bridge: Prompt Once';
            statusBarItem.tooltip = 'Remote debugging port is open, but no context has been captured. Please send one manual message in Antigravity Chat to prime the bridge.';
            break;
        case BridgeState.Active:
            statusBarItem.text = '$(zap) AG-Bridge: Active';
            statusBarItem.tooltip = 'Bridge is active and context is captured. External agents can now orchestrate this window.';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            break;
    }
}

async function showDashboard() {
    if (dashboardPanel) {
        dashboardPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }
    dashboardPanel = vscode.window.createWebviewPanel('agDashboard', 'Antigravity Bridge Status', vscode.ViewColumn.Beside, { enableScripts: true });
    dashboardPanel.onDidDispose(() => dashboardPanel = undefined);

    dashboardPanel.webview.onDidReceiveMessage(async message => {
        switch (message.command) {
            case 'rename': await renameChat(message.idx); break;
            case 'defineDuty': await defineDuty(message.idx); break;
            case 'resetAll': await resetAll(); break;
            case 'relink': await relink(message.idx); break;
            case 'cancelRelink': await cancelRelink(message.idx); break;
            case 'deleteAgent': await deleteAgent(message.idx); break;
            case 'refresh': updateDashboard(); break;
        }
        updateDashboard();
    });

    dashboardPanel.webview.html = getDashboardHtml();
    updateDashboard();
}

async function updateDashboard() {
    if (!dashboardPanel) return;
    try {
        const tab = await getAntigravityTab();
        if (!tab) {
            dashboardPanel.webview.postMessage({ type: 'status', data: { connected: false } });
            return;
        }
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 100,
                method: 'Runtime.evaluate',
                params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames, lastOutputs: window.__lastOutputs, busyAgents: window.__busyAgents, captured: !!window.__agCaptured?.last, relinkMode: window.__relinkMode, logs: (window.__agLogs || []).slice(' + lastLogIndex + ') })' }
            }));
        });
        ws.on('message', (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 100) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const config = loadConfig();
                
                if (browserState.relinkMode === null && relinkInProgress !== null) {
                   relinkInProgress = null;
                }

                // PROCESS LOGS
                if (browserState.logs && browserState.logs.length > 0) {
                    browserState.logs.forEach((l: any) => logToChannel(l.msg));
                    lastLogIndex += browserState.logs.length;
                }

                // Clean up pending deletes once browser confirms they are gone
                for (const k of Array.from(pendingDeletes)) {
                    if (!(k in browserState.registry)) {
                        pendingDeletes.delete(k);
                    }
                }

                let changed = false;
                for(const k in browserState.registry) {
                    if (relinkInProgress === k) continue; 
                    if (pendingDeletes.has(k)) continue; // GUARD: Do not restore ghost agents!

                    if(config.registry[k] !== browserState.registry[k]) { 
                        config.registry[k] = browserState.registry[k]; 
                        changed = true; 
                    }
                }
                if(changed) saveConfig(config);

                dashboardPanel?.webview.postMessage({
                    type: 'status',
                    data: {
                        connected: true,
                        tokenCaptured: browserState.captured,
                        registry: { ...config.registry, ...browserState.registry },
                        names: { ...browserState.names, ...config.chatNames },
                        duties: config.chatDuties || {},
                        relinkMode: browserState.relinkMode,
                        busyAgents: browserState.busyAgents,
                        lastOutputs: browserState.lastOutputs
                    }
                });
                ws.close();
            }
        });
    } catch (e) {
        dashboardPanel.webview.postMessage({ type: 'status', data: { connected: false } });
    }
}

async function renameChat(idx: string) {
    const config = loadConfig();
    const newName = await vscode.window.showInputBox({ prompt: `Name for Chat ${idx}`, value: config.chatNames[idx] || '' });
    if (newName !== undefined) {
        config.chatNames[idx] = newName;
        saveConfig(config);
        const tab = await getAntigravityTab();
        if (tab) {
            const ws = new WebSocket(tab.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({ id: 101, method: 'Runtime.evaluate', params: { expression: `window.__chatNames[${idx}] = "${newName}";` } }));
                ws.on('message', () => ws.close());
            });
        }
    }
}

async function defineDuty(idx: string) {
    const config = loadConfig();
    const duty = await vscode.window.showInputBox({ prompt: `Role for Chat ${idx}`, value: config.chatDuties[idx] || '' });
    if (duty !== undefined) { config.chatDuties[idx] = duty; saveConfig(config); }
}

async function resetAll() {
    const confirm = await vscode.window.showWarningMessage('Wipe ALL mappings and STOP relinking?', 'Yes', 'No');
    if (confirm !== 'Yes') return;
    relinkInProgress = null;
    
    // WIPING ABSOLUTELY EVERYTHING
    const config = loadConfig();
    config.registry = {};
    config.chatNames = {};
    config.chatDuties = {};
    saveConfig(config);
    
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 102, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry = {}; window.__chatNames = {}; window.__relinkMode = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}

async function relink(idx: string) {
    relinkInProgress = idx;
    const config = loadConfig();
    const oldId = config.registry[idx] || "";
    config.registry[idx] = ""; 
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 103, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry[${idx}] = ""; window.__relinkMode = ${idx}; window.__relinkOldId = "${oldId}";` } }));
            ws.on('message', () => ws.close());
        });
    }
}

async function cancelRelink(idx: string) {
    relinkInProgress = null;
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 104, method: 'Runtime.evaluate', params: { expression: `window.__relinkMode = null; window.__relinkOldId = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}

async function deleteAgent(idx: string) {
    // INSTANT DELETE. NO CONFIRMATION.
    const config = loadConfig();
    pendingDeletes.add(idx.toString());

    delete config.registry[idx];
    delete config.chatNames[idx];
    delete config.chatDuties[idx];
    saveConfig(config);
    
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 105, method: 'Runtime.evaluate', params: { expression: `delete window.__chatRegistry[${idx}]; delete window.__chatNames[${idx}]; if(window.__relinkMode == ${idx}) window.__relinkMode = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}

function getDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #1e1e1e; color: #d4d4d4; padding: 20px; line-height: 1.5; }
        .container { position: relative; background: rgba(45, 45, 45, 0.8); border-radius: 12px; padding: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
        h2 { color: #569cd6; margin: 0 0 20px 0; display: flex; align-items: center; gap: 10px; }
        h3 { color: #9cdcfe; border-bottom: 1px solid #444; padding-bottom: 5px; margin-top: 30px; display: flex; justify-content: space-between; align-items: center; }
        .status-row { display: flex; justify-content: space-between; margin-bottom: 10px; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; }
        .indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        .online { background: #4ec9b0; box-shadow: 0 0 8px #4ec9b0; }
        .offline { background: #f44747; box-shadow: 0 0 8px #f44747; }
        .chat-item { padding: 15px; background: rgba(255,255,255,0.05); margin-bottom: 10px; border-radius: 8px; border-left: 4px solid #569cd6; transition: 0.3s; position: relative; }
        .chat-item.relinking { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.2); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0px #f59e0b; } 50% { box-shadow: 0 0 15px #f59e0b; } 100% { box-shadow: 0 0 0px #f59e0b; } }
        .chat-name { font-weight: bold; color: #ce9178; font-size: 1.1em; }
        .chat-id { font-size: 0.75em; color: #808080; font-family: monospace; overflow-wrap: break-word; padding-right: 25px; }
        .chat-duty { font-style: italic; color: #b5cea8; margin-top: 5px; font-size: 0.9em; background: rgba(0,0,0,0.15); padding: 5px 8px; border-radius: 4px; }
        .last-thought { margin-top: 10px; font-size: 0.85em; color: #888; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; white-space: pre-wrap; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
        .busy-badge { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #34d399; margin-right: 6px; box-shadow: 0 0 8px #34d399; animation: pulse-busy 2s infinite; }
        @keyframes pulse-busy { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
        .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        button { background: #333; color: #ccc; border: 1px solid #444; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s; }
        button:hover { background: #444; border-color: #569cd6; color: #569cd6; }
        button.primary { background: #0e639c; color: white; border: none; }
        button.danger { color: #f44747; border-color: #f44747; }
        button.danger:hover { background: #f44747; color: white; }
        button.warning { color: #f59e0b; border-color: #f59e0b; }
        button.copy-btn { background: #4ec9b0; color: #1e1e1e; border: none; font-weight: bold; width: 100%; margin-top: 20px; padding: 10px; }
        .delete-btn { position: absolute; top: 15px; right: 15px; background: transparent; border: none; color: #444; font-size: 18px; padding: 0; min-width: 0; }
        .delete-btn:hover { color: #f44747; }
        .refresh-btn { position: absolute; top: 20px; right: 20px; background: rgba(255,255,255,0.1); border: none; }
        .refresh-btn:hover { background: rgba(255,255,255,0.2); color: white; border-color: transparent; }
    </style>
</head>
<body>
    <div class="container">
        <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
        <h2>🚀 Antigravity Command Center</h2>
        <div class="status-row"><span>Status:</span><span id="bridge-status">Offline</span></div>
        <div class="status-row"><span>Gateway:</span><span id="token-status">-</span></div>
        <h3>Registry <button class="danger" onclick="resetAll()">Wipe</button></h3>
        <div id="chat-list"></div>
        <button class="copy-btn" id="copy-instr-btn" onclick="copyInstructions()">📋 Copy Delegation Prompt</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let lastData = null;
        function refresh() { vscode.postMessage({ command: 'refresh' }); }
        function rename(idx) { vscode.postMessage({ command: 'rename', idx }); }
        function defineDuty(idx) { vscode.postMessage({ command: 'defineDuty', idx }); }
        function resetAll() { vscode.postMessage({ command: 'resetAll' }); }
        function relink(idx) { vscode.postMessage({ command: 'relink', idx }); }
        function cancelRelink(idx) { vscode.postMessage({ command: 'cancelRelink', idx }); }
        function deleteAgent(idx) { vscode.postMessage({ command: 'deleteAgent', idx }); }
        function copyInstructions() {
            if (!lastData) return;
            let agents = "";
            Object.keys(lastData.registry).forEach(idx => { 
                agents += '- [Agent ' + idx + ']: ' + (lastData.names[idx] || 'Agent') + ' (Primary Duty: ' + (lastData.duties[idx] || 'General Intelligence') + ')\\n'; 
            });
            const text = '# ANTIGRAVITY ORCHESTRATION PROTOCOL\\n\\n' +
                'You are an orchestrator with access to specialized sub-agents via the \\\'agbridge\\\' CLI. Each agent maintains a persistent, context-aware session.\\n\\n' +
                '## AVAILABLE AGENTS:\\n' + agents + '\\n' +
                '## CONTROL INTERFACE:\\n' +
                '- Use \\\'agbridge <idx> "prompt"\\\' to delegate a task to a specific agent.\\n' +
                '- Use \\\'agbridge <idx> "prompt" --all\\\' for strict supervision. This retrieves the COMPLETE execution path, including all intermediate thoughts and tool calls. WARNING: This may blow the context window; use only when full transparency of the agent\\\'s path is required.\\n\\n' +
                '## GUIDELINES:\\n' +
                '1. DELEGATE tasks based on the specific duties listed above.\\n' +
                '2. PERSISTENCE is active; you do not need to re-explain context to an agent in the same session.';
            
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copy-instr-btn');
                btn.innerText = "✅ Protocol Copied!";
                setTimeout(() => btn.innerText = "📋 Copy Delegation Prompt", 2000);
            });
        }
        window.addEventListener('message', event => {
            const { type, data } = event.data;
            if (type === 'status') {
                lastData = data;
                document.getElementById('bridge-status').innerHTML = data.connected ? '<span class="indicator online"></span> Online' : '<span class="indicator offline"></span> Offline';
                document.getElementById('token-status').innerHTML = data.tokenCaptured ? '<span class="indicator online"></span> Ready' : '<span class="indicator offline"></span> Idle';
                const list = document.getElementById('chat-list');
                list.innerHTML = '';
                const allIndices = new Set([...Object.keys(data.registry), ...Object.keys(data.names), ...Object.keys(data.duties)]);
                Array.from(allIndices).sort((a,b) => parseInt(a)-parseInt(b)).forEach(idx => {
                    const id = data.registry[idx];
                    const name = data.names[idx] || 'Agent';
                    const duty = data.duties[idx] || 'No role';
                    const isBusy = id && data.busyAgents && data.busyAgents[id];
                    const lastText = (id && data.lastOutputs && data.lastOutputs[id]) ? data.lastOutputs[id] : 'No activity recorded...';
                    const isRelinking = (data.relinkMode == idx);
                    const anyRelinking = (data.relinkMode !== null);
                    
                    const busyBadge = isBusy ? '<span class="busy-badge"></span>' : '';
                    const listeningText = isRelinking ? '(LISTENING...)' : '';
                    const idText = id || (isRelinking ? 'WAITING FOR NEW CHAT...' : 'UNLINKED');
                    
                    let buttons = '<button class="primary" onclick="rename(\\''+idx+'\\')">Name</button>' +
                                  '<button onclick="defineDuty(\\''+idx+'\\')">Role</button>';
                                  
                    if (isRelinking) {
                        buttons += '<button class="warning" onclick="cancelRelink(\\''+idx+'\\')">Cancel</button>';
                    } else {
                        const disabled = anyRelinking ? 'disabled' : '';
                        buttons += '<button ' + disabled + ' onclick="relink(\\''+idx+'\\')">Relink</button>';
                    }

                    list.innerHTML += 
                        '<div class="chat-item ' + (isRelinking ? 'relinking' : '') + '">' +
                            '<button class="delete-btn" onclick="deleteAgent(\\''+idx+'\\')">×</button>' +
                            '<div class="chat-name">' + busyBadge + idx + ': ' + name + ' ' + listeningText + '</div>' +
                            '<div class="chat-id">' + idText + '</div>' +
                            '<div class="chat-duty">" ' + duty + ' "</div>' +
                            '<div class="last-thought">' + lastText + '</div>' +
                            '<div class="actions">' + buttons + '</div>' +
                        '</div>';
                });
            }
        });
        setInterval(refresh, 2000);
    </script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
    setupGlobalCommand(context.extensionPath);
    outputChannel = vscode.window.createOutputChannel("Antigravity Bridge");
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.inject', () => injectBridge()));
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.showDashboard', () => showDashboard()));
    
    injectBridge().catch(() => {});
    
    // Background polling for logs and status
    setInterval(async () => {
        if (isPolling) return;
        isPolling = true;
        
        try {
            const tab = await getAntigravityTab();
            if (!tab) {
                updateStatusBar(BridgeState.MissingRDP);
            } else {
                // Check for captured context
                const ws = new WebSocket(tab.webSocketDebuggerUrl);
                ws.on('open', () => {
                    ws.send(JSON.stringify({
                        id: 200,
                        method: 'Runtime.evaluate',
                        params: { expression: '!!window.__agCaptured?.last' }
                    }));
                });
                ws.on('message', (data: WebSocket.Data) => {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === 200) {
                        const captured = msg.result?.result?.value;
                        updateStatusBar(captured ? BridgeState.Active : BridgeState.PromptOnce);
                        ws.close();
                    }
                });
                ws.on('error', () => {
                    updateStatusBar(BridgeState.MissingRDP);
                    ws.close();
                });

                if (dashboardPanel) {
                    await updateDashboard();
                }
            }
        } catch (e) {
            updateStatusBar(BridgeState.MissingRDP);
        }
        isPolling = false;
    }, 2000);
}

export function deactivate() { if (statusBarItem) statusBarItem.dispose(); }
