import * as vscode from 'vscode';
import * as http from 'http';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

let statusBarItem: vscode.StatusBarItem;
let dashboardPanel: vscode.WebviewPanel | undefined;
let bridgeActive = false;
let relinkInProgress: string | null = null; // Guard against race conditions

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
    config.ts = Date.now();
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
        console.error('Failed to setup global command:', e);
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
            updateStatusBar(false);
            return;
        }
        const scriptPath = path.join(__dirname, 'bridge.js');
        const finalScriptPath = fs.existsSync(scriptPath) ? scriptPath : path.join(__dirname, '..', 'src', 'bridge.js');
        if (!fs.existsSync(finalScriptPath)) return;
        const script = fs.readFileSync(finalScriptPath, 'utf8');

        const config = loadConfig();
        const syncScript = `
            Object.assign(window.__chatRegistry, ${JSON.stringify(config.registry || {})});
            Object.assign(window.__chatNames, ${JSON.stringify(config.chatNames || {})});
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
                updateStatusBar(true);
            }
        });
        ws.on('error', () => updateStatusBar(false));
    } catch (e) {
        updateStatusBar(false);
    }
}

function updateStatusBar(active: boolean) {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.show();
    }
    if (active) {
        statusBarItem.text = '$(zap) AG Bridge Active';
        statusBarItem.command = 'agbridge.showDashboard';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
        statusBarItem.text = '$(circle-slash) AG Bridge Inactive';
        statusBarItem.command = 'agbridge.inject';
        statusBarItem.backgroundColor = undefined;
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
                params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames, captured: !!window.__agCaptured?.last, relinkMode: window.__relinkMode })' }
            }));
        });
        ws.on('message', (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 100) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const config = loadConfig();
                
                // If the bridge says relinkMode is null, but we have relinkInProgress, 
                // it means the bridge JUST FINISHED relinking.
                if (browserState.relinkMode === null && relinkInProgress !== null) {
                   relinkInProgress = null;
                }

                // SYNC REGISTRY (Only if NOT currently relinking that specific index)
                let changed = false;
                for(const k in browserState.registry) {
                    if (relinkInProgress === k) continue; // DON'T SYNC WHILE RELINKING
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
                        relinkMode: browserState.relinkMode
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
    const duty = await vscode.window.showInputBox({ prompt: `Duty/Role for Chat ${idx}`, value: config.chatDuties[idx] || '' });
    if (duty !== undefined) { config.chatDuties[idx] = duty; saveConfig(config); }
}

async function resetAll() {
    const confirm = await vscode.window.showWarningMessage('Wipe ALL agent mappings?', 'Yes', 'No');
    if (confirm !== 'Yes') return;
    const config = loadConfig();
    config.registry = {};
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 102, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry = {}; window.__relinkMode = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}

async function relink(idx: string) {
    relinkInProgress = idx; // LOCK IT
    const config = loadConfig();
    config.registry[idx] = ""; 
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 103, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry[${idx}] = ""; window.__relinkMode = ${idx};` } }));
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
        .container { background: rgba(45, 45, 45, 0.8); border-radius: 12px; padding: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
        h2 { color: #569cd6; margin: 0 0 20px 0; display: flex; align-items: center; gap: 10px; }
        h3 { color: #9cdcfe; border-bottom: 1px solid #444; padding-bottom: 5px; margin-top: 30px; display: flex; justify-content: space-between; align-items: center; }
        .status-row { display: flex; justify-content: space-between; margin-bottom: 10px; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; }
        .indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        .online { background: #4ec9b0; box-shadow: 0 0 8px #4ec9b0; }
        .offline { background: #f44747; box-shadow: 0 0 8px #f44747; }
        .chat-item { padding: 15px; background: rgba(255,255,255,0.05); margin-bottom: 10px; border-radius: 8px; border-left: 4px solid #569cd6; transition: 0.3s; }
        .chat-item.relinking { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.2); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0px #f59e0b; } 50% { box-shadow: 0 0 15px #f59e0b; } 100% { box-shadow: 0 0 0px #f59e0b; } }
        .chat-name { font-weight: bold; color: #ce9178; font-size: 1.1em; }
        .chat-id { font-size: 0.75em; color: #808080; font-family: monospace; overflow-wrap: break-word; }
        .chat-duty { font-style: italic; color: #b5cea8; margin-top: 5px; font-size: 0.9em; background: rgba(0,0,0,0.15); padding: 5px 8px; border-radius: 4px; }
        .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        button { background: #333; color: #ccc; border: 1px solid #444; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s; }
        button:hover { background: #444; border-color: #569cd6; color: #569cd6; }
        button.primary { background: #0e639c; color: white; border: none; }
        button.danger { color: #f44747; border-color: #f44747; }
        button.danger:hover { background: #f44747; color: white; }
        button.copy-btn { background: #4ec9b0; color: #1e1e1e; border: none; font-weight: bold; width: 100%; margin-top: 20px; padding: 10px; }
        .refresh-btn { float: right; margin-left: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <button class="refresh-btn" onclick="refresh()">Refresh</button>
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
        function copyInstructions() {
            if (!lastData) return;
            let agents = "";
            Object.keys(lastData.registry).forEach(idx => { agents += \`- [\${idx}]: \${lastData.names[idx] || 'Agent'} (Role: \${lastData.duties[idx] || 'GenInt'})\\n\`; });
            const text = \`# Antigravity Orchestration\\nAgents:\\n\${agents}\\n\\nCommand: agbridge <idx> "prompt" [--all]\`;
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copy-instr-btn');
                btn.innerText = "✅ Copied!";
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
                    const isRelinking = (data.relinkMode == idx) || (!id);
                    list.innerHTML += \`
                        <div class="chat-item \${isRelinking ? 'relinking' : ''}">
                            <div class="chat-name">\${idx}: \${data.names[idx] || 'Agent'} \${isRelinking ? '(LISTENING...)' : ''}</div>
                            <div class="chat-id">\${id || 'ID EMPTY — INTERACT IN CHAT'}</div>
                            <div class="chat-duty">" \${data.duties[idx] || 'No role'} "</div>
                            <div class="actions">
                                <button class="primary" onclick="rename('\${idx}')">Name</button>
                                <button onclick="defineDuty('\${idx}')">Role</button>
                                <button onclick="relink('\${idx}')">Relink</button>
                            </div>
                        </div>\`;
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
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.inject', () => injectBridge()));
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.showDashboard', () => showDashboard()));
    updateStatusBar(false);
    injectBridge().catch(() => {});
}

export function deactivate() { if (statusBarItem) statusBarItem.dispose(); }
