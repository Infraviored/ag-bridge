"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const ws_1 = __importDefault(require("ws"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let statusBarItem;
let dashboardPanel;
let bridgeActive = false;
async function getAntigravityTab() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const tabs = JSON.parse(data);
                    const tab = tabs.find((t) => t.url?.includes('workbench.html') && t.type === 'page');
                    resolve(tab);
                }
                catch (e) {
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
        if (!fs.existsSync(finalScriptPath))
            return;
        const script = fs.readFileSync(finalScriptPath, 'utf8');
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: script }
            }));
        });
        ws.on('message', (data) => {
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
    }
    catch (e) {
        updateStatusBar(false);
    }
}
function updateStatusBar(active) {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.show();
    }
    if (active) {
        statusBarItem.text = '$(zap) AG Bridge Active';
        statusBarItem.command = 'agbridge.showDashboard';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    }
    else {
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
    dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
    });
    dashboardPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'rename':
                await renameChat(message.idx, message.id);
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
    if (!dashboardPanel)
        return;
    try {
        const tab = await getAntigravityTab();
        if (!tab) {
            dashboardPanel.webview.postMessage({ type: 'status', data: { connected: false } });
            return;
        }
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 100,
                method: 'Runtime.evaluate',
                params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames, captured: !!window.__agCaptured?.last })' }
            }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 100) {
                const state = JSON.parse(msg.result?.result?.value || '{}');
                // config laden
                const configPath = path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', 'ag-config.json');
                let config = { chatNames: {} };
                if (fs.existsSync(configPath)) {
                    try {
                        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }
                    catch { }
                }
                dashboardPanel?.webview.postMessage({
                    type: 'status',
                    data: {
                        connected: true,
                        tokenCaptured: state.captured,
                        registry: state.registry,
                        names: { ...state.names, ...config.chatNames }
                    }
                });
                ws.close();
            }
        });
    }
    catch (e) {
        dashboardPanel.webview.postMessage({ type: 'status', data: { connected: false } });
    }
}
async function renameChat(idx, id) {
    const configPath = path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', 'ag-config.json');
    let config = { chatNames: {} };
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        catch { }
    }
    const newName = await vscode.window.showInputBox({
        prompt: `Name für Chat ${idx} (${id})`,
        value: config.chatNames[idx] || ''
    });
    if (newName !== undefined) {
        config.chatNames[idx] = newName;
        config.ts = Date.now();
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        const tab = await getAntigravityTab();
        if (tab) {
            const ws = new ws_1.default(tab.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 101,
                    method: 'Runtime.evaluate',
                    params: { expression: `window.__chatNames[${idx}] = "${newName}"; console.log("Name synced")` }
                }));
                ws.on('message', () => ws.close());
            });
        }
    }
}
function getDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #1e1e1e;
            color: #d4d4d4;
            padding: 20px;
            margin: 0;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background: rgba(45, 45, 45, 0.8);
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            border: 1px solid rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
        }
        h2 { color: #569cd6; margin-top: 0; display: flex; align-items: center; gap: 10px; }
        .status-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 15px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
        }
        .indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 8px;
        }
        .online { background: #4ec9b0; box-shadow: 0 0 8px #4ec9b0; }
        .offline { background: #f44747; box-shadow: 0 0 8px #f44747; }
        .chat-list { margin-top: 20px; }
        .chat-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px;
            background: rgba(255,255,255,0.05);
            margin-bottom: 8px;
            border-radius: 6px;
            transition: background 0.2s;
        }
        .chat-item:hover { background: rgba(255,255,255,0.08); }
        .chat-info { flex: 1; }
        .chat-name { font-weight: bold; color: #ce9178; }
        .chat-id { font-size: 0.8em; color: #808080; display: block; }
        button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        button:hover { background: #1177bb; }
        .refresh-btn { float: right; background: transparent; border: 1px solid #569cd6; color: #569cd6; }
    </style>
</head>
<body>
    <div class="container">
        <button class="refresh-btn" onclick="refresh()">Refresh</button>
        <h2>🚀 Antigravity Bridge</h2>
        
        <div class="status-row">
            <span>Bridge Connection:</span>
            <span id="bridge-status"><span class="indicator offline"></span> Disconnected</span>
        </div>
        <div class="status-row">
            <span>CSRF Token:</span>
            <span id="token-status"><span class="indicator offline"></span> Missing</span>
        </div>

        <h3>Detected Chats</h3>
        <div id="chat-list" class="chat-list">
            <p style="color: #808080;">No chats detected yet...</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function rename(idx, id) {
            vscode.postMessage({ command: 'rename', idx, id });
        }

        window.addEventListener('message', event => {
            const { type, data } = event.data;
            if (type === 'status') {
                const bStatus = document.getElementById('bridge-status');
                const tStatus = document.getElementById('token-status');
                
                if (data.connected) {
                    bStatus.innerHTML = '<span class="indicator online"></span> Connected';
                    tStatus.innerHTML = data.tokenCaptured ? 
                        '<span class="indicator online"></span> Captured' : 
                        '<span class="indicator offline"></span> Missing (Write in chat!)';
                    
                    const list = document.getElementById('chat-list');
                    list.innerHTML = '';
                    const registry = data.registry || {};
                    const names = data.names || {};
                    
                    const keys = Object.keys(registry);
                    if (keys.length === 0) {
                        list.innerHTML = '<p style="color: #808080;">No chats detected yet...</p>';
                    } else {
                        keys.forEach(idx => {
                            const id = registry[idx];
                            const name = names[idx] || 'No Name';
                            list.innerHTML += \`
                                <div class="chat-item">
                                    <div class="chat-info">
                                        <span class="chat-name">\${name} (Chat \${idx})</span>
                                        <span class="chat-id">\${id}</span>
                                    </div>
                                    <button onclick="rename('\${idx}', '\${id}')">Rename</button>
                                </div>
                            \`;
                        });
                    }
                } else {
                    bStatus.innerHTML = '<span class="indicator offline"></span> Disconnected';
                    tStatus.innerHTML = '<span class="indicator offline"></span> -';
                    document.getElementById('chat-list').innerHTML = '<p style="color: #f44747;">Cannot reach Antigravity. Is it running on port 9222?</p>';
                }
            }
        });

        // Polling for live updates
        setInterval(refresh, 2000);
    </script>
</body>
</html>`;
}
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.inject', () => {
        injectBridge();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.showDashboard', showDashboard));
    updateStatusBar(false);
    injectBridge().catch(() => { });
}
function deactivate() {
    if (statusBarItem)
        statusBarItem.dispose();
}
//# sourceMappingURL=extension.js.map