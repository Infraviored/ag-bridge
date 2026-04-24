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

// Option 3: Globaler CLI Command Setup
function setupGlobalCommand(extensionPath: string) {
    try {
        const binDir = path.join(process.env.HOME || '', '.local', 'bin');
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir, { recursive: true });
        }

        const scriptPath = path.join(extensionPath, 'send.mjs');
        const linkPath = path.join(binDir, 'agbridge');

        // Make executable
        if (fs.existsSync(scriptPath)) {
            fs.chmodSync(scriptPath, '755');
        }

        // Create Symlink
        if (fs.existsSync(linkPath)) {
            try {
                const existing = fs.readlinkSync(linkPath);
                if (existing !== scriptPath) {
                    fs.unlinkSync(linkPath);
                    fs.symlinkSync(scriptPath, linkPath);
                }
            } catch (e) {
                // If not a link, but a file exists, replace it
                fs.unlinkSync(linkPath);
                fs.symlinkSync(scriptPath, linkPath);
            }
        } else {
            fs.symlinkSync(scriptPath, linkPath);
        }
        console.log(`🚀 Global CLI 'agbridge' is ready at ${linkPath}`);
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
            console.log("🔗 Relinked ${Object.keys(config.registry || {}).length} chats from config");
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

        ws.on('error', () => {
            updateStatusBar(false);
        });

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

    dashboardPanel = vscode.window.createWebviewPanel(
        'agDashboard',
        'Antigravity Bridge Status',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
    });

    dashboardPanel.webview.onDidReceiveMessage(async message => {
        switch (message.command) {
            case 'rename':
                await renameChat(message.idx, message.id);
                updateDashboard();
                break;
            case 'defineDuty':
                await defineDuty(message.idx, message.id);
                updateDashboard();
                break;
            case 'refresh':
                updateDashboard();
                break;
        }
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
                params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames, captured: !!window.__agCaptured?.last })' }
            }));
        });

        ws.on('message', (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 100) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const config = loadConfig();

                const mergedRegistry = { ...config.registry, ...browserState.registry };
                
                let changed = false;
                for(const k in browserState.registry) {
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
                        registry: mergedRegistry,
                        names: { ...browserState.names, ...config.chatNames },
                        duties: config.chatDuties || {}
                    }
                });
                ws.close();
            }
        });
    } catch (e) {
        dashboardPanel.webview.postMessage({ type: 'status', data: { connected: false } });
    }
}

async function renameChat(idx: string, id: string) {
    const config = loadConfig();
    const newName = await vscode.window.showInputBox({
        prompt: `Name für Chat ${idx}`,
        value: config.chatNames[idx] || ''
    });

    if (newName !== undefined) {
        config.chatNames[idx] = newName;
        saveConfig(config);

        const tab = await getAntigravityTab();
        if (tab) {
            const ws = new WebSocket(tab.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 101,
                    method: 'Runtime.evaluate',
                    params: { expression: `window.__chatNames[${idx}] = "${newName}"; console.log("Name ${idx} synced")` }
                }));
                ws.on('message', () => ws.close());
            });
        }
    }
}

async function defineDuty(idx: string, id: string) {
    const config = loadConfig();
    const duty = await vscode.window.showInputBox({
        prompt: `Duty/Verantwortung für Chat ${idx}`,
        placeHolder: 'z.B. Backend Only, Frontend Specialist...',
        value: config.chatDuties[idx] || ''
    });

    if (duty !== undefined) {
        config.chatDuties[idx] = duty;
        saveConfig(config);
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
        h3 { color: #9cdcfe; border-bottom: 1px solid #444; padding-bottom: 5px; margin-top: 30px; }
        .status-row { display: flex; justify-content: space-between; margin-bottom: 10px; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; }
        .indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        .online { background: #4ec9b0; box-shadow: 0 0 8px #4ec9b0; }
        .offline { background: #f44747; box-shadow: 0 0 8px #f44747; }
        .chat-item { padding: 15px; background: rgba(255,255,255,0.05); margin-bottom: 10px; border-radius: 8px; border-left: 4px solid #569cd6; }
        .chat-name { font-weight: bold; color: #ce9178; font-size: 1.1em; }
        .chat-id { font-size: 0.75em; color: #808080; font-family: monospace; }
        .chat-duty { font-style: italic; color: #b5cea8; margin-top: 5px; font-size: 0.9em; background: rgba(0,0,0,0.15); padding: 5px 8px; border-radius: 4px; }
        .actions { display: flex; gap: 8px; margin-top: 10px; }
        button { background: #333; color: #ccc; border: 1px solid #444; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s; }
        button:hover { background: #444; border-color: #569cd6; color: #569cd6; }
        button.primary { background: #0e639c; color: white; border: none; }
        button.primary:hover { background: #1177bb; }
        button.copy-btn { background: #4ec9b0; color: #1e1e1e; border: none; font-weight: bold; width: 100%; margin-top: 20px; padding: 10px; }
        button.copy-btn:hover { background: #66e0c7; }
        .help-section { font-size: 0.9em; color: #aaaaaa; margin-top: 20px; padding: 15px; background: rgba(0,0,0,0.1); border-radius: 8px; border: 1px dashed #444; }
        .help-section code { color: #ce9178; background: rgba(0,0,0,0.3); padding: 2px 4px; border-radius: 3px; }
        .refresh-btn { float: right; }
    </style>
</head>
<body>
    <div class="container">
        <button class="refresh-btn" onclick="refresh()">Refresh</button>
        <h2>🚀 Antigravity Bridge</h2>
        
        <div class="status-row">
            <span>Connection:</span>
            <span id="bridge-status"><span class="indicator offline"></span> Offline</span>
        </div>
        <div class="status-row">
            <span>CSRF Intercept:</span>
            <span id="token-status"><span class="indicator offline"></span> -</span>
        </div>

        <div class="help-section">
            <strong>How to use:</strong> 
            Ensure Connection is 🟢. Write 1x in any chat to get 🟢 Ready. 
            Once ready, you can control these agents via terminal: <br>
            <code>agbridge &lt;idx&gt; "message" [--all]</code>
        </div>

        <h3>Active Registry</h3>
        <div id="chat-list"></div>

        <button class="copy-btn" id="copy-instr-btn" onclick="copyInstructions()">📋 Copy CLI Usage for other Agents</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let lastData = null;

        function refresh() { vscode.postMessage({ command: 'refresh' }); }
        function rename(idx, id) { vscode.postMessage({ command: 'rename', idx, id }); }
        function defineDuty(idx, id) { vscode.postMessage({ command: 'defineDuty', idx, id }); }

        function copyInstructions() {
            if (!lastData) return;
            let agents = "";
            Object.keys(lastData.registry).forEach(idx => {
                const name = lastData.names[idx] || 'Unnamed Agent';
                const duty = lastData.duties[idx] || 'General assistance';
                agents += \`- [\${idx}]: \${name} (Duty: \${duty})\\n\`;
            });

            const text = \`# Antigravity Bridge CLI Instructions
You can interact with the current Antigravity Chat agents using the global 'agbridge' command.
Command: agbridge <index|name> "your message" [--all]

Options:
  --all    Show full logs (tool calls, thoughts, browser actions). Use this for deep supervision.

Current Available Agents:
\${agents}

Example: agbridge 1 "Refactor the backend"
Note: Ensure the bridge is running and you have captured the CSRF token (write once manually in chat if needed).\`;

            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copy-instr-btn');
                const oldText = btn.innerText;
                btn.innerText = "✅ Instructions Copied!";
                btn.style.background = "#fff";
                setTimeout(() => { btn.innerText = oldText; btn.style.background = "#4ec9b0"; }, 2000);
            });
        }

        window.addEventListener('message', event => {
            const { type, data } = event.data;
            if (type === 'status') {
                lastData = data;
                const bStatus = document.getElementById('bridge-status');
                const tStatus = document.getElementById('token-status');
                
                if (data.connected) {
                    bStatus.innerHTML = '<span class="indicator online"></span> Online';
                    tStatus.innerHTML = data.tokenCaptured ? 
                        '<span class="indicator online"></span> Ready' : 
                        '<span class="indicator offline"></span> Idle (Write something!)';
                    
                    const list = document.getElementById('chat-list');
                    list.innerHTML = '';
                    const registry = data.registry || {};
                    const names = data.names || {};
                    const duties = data.duties || {};
                    
                    Object.keys(registry).forEach(idx => {
                        const id = registry[idx];
                        const name = names[idx] || 'Unnamed Agent';
                        const duty = duties[idx] || 'No duty defined...';
                        list.innerHTML += \`
                            <div class="chat-item">
                                <div class="chat-header">
                                    <div class="chat-info">
                                        <div class="chat-name">\${idx}: \${name}</div>
                                        <div class="chat-id">\${id}</div>
                                    </div>
                                </div>
                                <div class="chat-duty">" \${duty} "</div>
                                <div class="actions">
                                    <button class="primary" onclick="rename('\${idx}', '\${id}')">Rename</button>
                                    <button onclick="defineDuty('\${idx}', '\${id}')">Define Duty</button>
                                </div>
                            </div>
                        \`;
                    });
                } else {
                    bStatus.innerHTML = '<span class="indicator offline"></span> Offline';
                    document.getElementById('chat-list').innerHTML = '<p>Waiting for Antigravity...</p>';
                }
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

export function deactivate() {
    if (statusBarItem) statusBarItem.dispose();
}
