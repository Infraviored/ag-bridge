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
const os = __importStar(require("os"));
let statusBarItem;
let dashboardPanel;
let outputChannel;
let bridgeActive = false;
let relinkInProgress = null;
let pendingDeletes = new Set(); // Guard against race condition
let lastLogIndex = 0;
let isPolling = false;
let lastHeartbeat = 0;
let globalExtensionPath;
var BridgeState;
(function (BridgeState) {
    BridgeState[BridgeState["MissingRDP"] = 0] = "MissingRDP";
    BridgeState[BridgeState["PromptOnce"] = 1] = "PromptOnce";
    BridgeState[BridgeState["Active"] = 2] = "Active";
})(BridgeState || (BridgeState = {}));
function logToChannel(msg) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Antigravity Bridge");
    }
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
function getConfigPath() {
    const home = os.homedir();
    return path.join(home, '.agbridge', 'config.json');
}
function loadConfig() {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return {
                agents: config.agents || {},
                settings: config.settings || { cliTimeout: 600, timeout: 180, logHeartbeat: false }
            };
        }
        catch (e) {
            logToChannel(`Error loading config: ${e}`);
        }
    }
    return { agents: {}, settings: { cliTimeout: 600, timeout: 180, logHeartbeat: false } };
}
function saveConfig(config) {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
// Global CLI Command Setup
function setupGlobalCommand(extensionPath) {
    try {
        const binDir = path.join(process.env.HOME || '', '.local', 'bin');
        if (!fs.existsSync(binDir))
            fs.mkdirSync(binDir, { recursive: true });
        const scriptPath = path.join(extensionPath, 'send.mjs');
        const linkPath = path.join(binDir, 'agbridge');
        if (fs.existsSync(scriptPath))
            fs.chmodSync(scriptPath, '755');
        if (fs.existsSync(linkPath)) {
            try {
                const existing = fs.readlinkSync(linkPath);
                if (existing !== scriptPath) {
                    fs.unlinkSync(linkPath);
                    fs.symlinkSync(scriptPath, linkPath);
                }
            }
            catch (e) {
                fs.unlinkSync(linkPath);
                fs.symlinkSync(scriptPath, linkPath);
            }
        }
        else {
            fs.symlinkSync(scriptPath, linkPath);
        }
    }
    catch (e) {
        logToChannel(`[ERROR] Global command setup failed: ${e}`);
    }
}
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
            updateStatusBar(BridgeState.MissingRDP);
            return;
        }
        const scriptPath = path.join(__dirname, '..', 'dist', 'bridge.js');
        const finalScriptPath = fs.existsSync(scriptPath) ? scriptPath : path.join(__dirname, '..', 'src', 'bridge.js');
        if (!fs.existsSync(finalScriptPath))
            return;
        const script = fs.readFileSync(finalScriptPath, 'utf8');
        const config = loadConfig();
        const verbose = vscode.workspace.getConfiguration('antigravity.bridge').get('verbose', false);
        const registry = {};
        const names = {};
        const duties = {};
        Object.entries(config.agents).forEach(([idx, a]) => {
            registry[idx] = a.id;
            names[idx] = a.name;
            duties[idx] = a.duty;
        });
        const syncScript = `
            Object.assign(window.__chatRegistry, ${JSON.stringify(registry)});
            Object.assign(window.__chatNames, ${JSON.stringify(names)});
            Object.assign(window.__chatDuties, ${JSON.stringify(duties)});
            window.__agVerbose = ${verbose};
            window.__agTimeout = ${config.settings.timeout * 1000};
            window.__agCliTimeout = ${config.settings.cliTimeout * 1000};
        `;
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: script + "\n" + syncScript }
            }));
        });
        const server = http.createServer();
        server.on('request', async (req, res) => {
            const url = new URL(req.url || '/', `http://${req.headers.host}`);
            if (url.pathname === '/cmd') {
                const chatIndex = url.searchParams.get('idx');
                const text = url.searchParams.get('text');
                const reqId = url.searchParams.get('reqId');
                const mode = url.searchParams.get('mode'); // e.g. "get-lost"
                if (mode === 'get-lost' && chatIndex) {
                    const tab = await getAntigravityTab();
                    if (tab) {
                        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
                        ws.on('open', () => {
                            ws.send(JSON.stringify({
                                id: 107,
                                method: 'Runtime.evaluate',
                                params: { expression: `JSON.parse(localStorage.getItem('__ag_outputs') || '{}')[${chatIndex}] || "No cached output found."` }
                            }));
                            ws.on('message', (data) => {
                                const result = JSON.parse(data.toString());
                                const output = result.result?.result?.value || "Error fetching cache.";
                                res.writeHead(200, { 'Content-Type': 'text/plain' });
                                res.end(output);
                                ws.close();
                            });
                        });
                        return;
                    }
                }
            }
        });
        server.listen(9223);
        ws.on('message', (data) => {
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
    }
    catch (e) {
        updateStatusBar(BridgeState.MissingRDP);
    }
}
function updateStatusBar(state) {
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
    dashboardPanel = vscode.window.createWebviewPanel('agDashboard', 'Antigravity Bridge Status', vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(globalExtensionPath)]
    });
    dashboardPanel.onDidDispose(() => dashboardPanel = undefined);
    dashboardPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'changeIndex':
                const newIdx = await vscode.window.showInputBox({ prompt: `New Index for Agent ${message.idx}`, value: message.idx });
                if (newIdx && newIdx !== message.idx) {
                    const config = loadConfig();
                    if (config.agents[newIdx]) {
                        vscode.window.showErrorMessage(`Index ${newIdx} is already in use!`);
                        return;
                    }
                    config.agents[newIdx] = config.agents[message.idx];
                    delete config.agents[message.idx];
                    saveConfig(config);
                    // Push to browser
                    const tab = await getAntigravityTab();
                    if (tab) {
                        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
                        ws.on('open', () => {
                            ws.send(JSON.stringify({ id: 107, method: 'Runtime.evaluate', params: { expression: `
                                        window.__chatRegistry[${newIdx}] = window.__chatRegistry[${message.idx}];
                                        window.__chatNames[${newIdx}] = window.__chatNames[${message.idx}];
                                        delete window.__chatRegistry[${message.idx}];
                                        delete window.__chatNames[${message.idx}];
                                        if(window.__relinkMode == ${message.idx}) window.__relinkMode = ${newIdx};
                                    ` } }));
                            ws.on('message', () => ws.close());
                        });
                    }
                }
                break;
            case 'rename':
                await renameChat(message.idx);
                break;
            case 'defineDuty':
                await defineDuty(message.idx);
                break;
            case 'resetAll':
                await resetAll();
                break;
            case 'relink':
                await relink(message.idx);
                break;
            case 'cancelRelink':
                await cancelRelink(message.idx);
                break;
            case 'deleteAgent':
                await deleteAgent(message.idx);
                break;
            case 'refresh':
                updateDashboard();
                break;
        }
        updateDashboard();
    });
    dashboardPanel.webview.html = getDashboardHtml(dashboardPanel.webview, globalExtensionPath);
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
            const config = loadConfig();
            const registry = {};
            const names = {};
            const duties = {};
            Object.entries(config.agents).forEach(([idx, a]) => {
                registry[idx] = a.id;
                names[idx] = a.name;
                duties[idx] = a.duty;
            });
            const syncScript = `(function(){
                window.__chatRegistry = window.__chatRegistry || {};
                window.__chatNames = window.__chatNames || {};
                window.__chatDuties = window.__chatDuties || {};
                
                const fileReg = ${JSON.stringify(registry)};
                const fileNames = ${JSON.stringify(names)};
                const fileDuties = ${JSON.stringify(duties)};
                
                Object.assign(window.__chatRegistry, fileReg);
                Object.assign(window.__chatNames, fileNames);
                Object.assign(window.__chatDuties, fileDuties);
                
                localStorage.setItem('__ag_registry', JSON.stringify(window.__chatRegistry));
            })()`;
            ws.send(JSON.stringify({ id: 99, method: 'Runtime.evaluate', params: { expression: syncScript } }));
            const evalStr = `JSON.stringify({ 
                registry: window.__chatRegistry, 
                names: window.__chatNames, 
                duties: window.__chatDuties,
                lastOutputs: window.__lastOutputs, 
                lastPrompts: window.__lastPrompts, 
                busyAgents: JSON.parse(localStorage.getItem('__ag_busy') || '{}'), 
                captured: !!window.__agCaptured?.last, 
                relinkMode: window.__relinkMode, 
                settings: { cliTimeout: window.__agCliTimeout / 1000, timeout: window.__agTimeout / 1000, logHeartbeat: window.__agLogHeartbeat },
                logs: (window.__agLogs || []).slice(${lastLogIndex}) 
            })`;
            ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: evalStr } }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 2) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const config = loadConfig();
                // Sync browser state BACK to central config if needed (e.g. relink happened in browser)
                let changed = false;
                Object.entries(browserState.registry).forEach(([idx, id]) => {
                    const idStr = id;
                    if (!config.agents[idx]) {
                        config.agents[idx] = { id: idStr, name: `Agent ${idx}`, duty: 'General Intelligence' };
                        changed = true;
                    }
                    else if (config.agents[idx].id !== idStr) {
                        config.agents[idx].id = idStr;
                        changed = true;
                    }
                });
                if (changed)
                    saveConfig(config);
                // Clean up pending deletes once browser confirms they are gone
                for (const k of Array.from(pendingDeletes)) {
                    if (!(k in browserState.registry)) {
                        pendingDeletes.delete(k);
                    }
                }
                dashboardPanel?.webview.postMessage({
                    type: 'status',
                    data: {
                        ...browserState,
                        connected: bridgeActive,
                        tokenCaptured: browserState.captured
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
async function renameChat(idx) {
    const config = loadConfig();
    const newName = await vscode.window.showInputBox({ prompt: `Name for Chat ${idx}`, value: config.agents[idx]?.name || '' });
    if (newName !== undefined) {
        if (!config.agents[idx])
            config.agents[idx] = { id: '', name: '', duty: '' };
        config.agents[idx].name = newName;
        saveConfig(config);
        const tab = await getAntigravityTab();
        if (tab) {
            const ws = new ws_1.default(tab.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({ id: 101, method: 'Runtime.evaluate', params: { expression: `window.__chatNames[${idx}] = "${newName}";` } }));
                ws.on('message', () => ws.close());
            });
        }
    }
}
async function defineDuty(idx) {
    const config = loadConfig();
    const duty = await vscode.window.showInputBox({ prompt: `Role for Chat ${idx}`, value: config.agents[idx]?.duty || '' });
    if (duty !== undefined) {
        if (!config.agents[idx])
            config.agents[idx] = { id: '', name: '', duty: '' };
        config.agents[idx].duty = duty;
        saveConfig(config);
    }
}
async function resetAll() {
    const confirm = await vscode.window.showWarningMessage('Wipe ALL mappings and STOP relinking?', 'Yes', 'No');
    if (confirm !== 'Yes')
        return;
    relinkInProgress = null;
    const config = loadConfig();
    config.agents = {};
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 102, method: 'Runtime.evaluate', params: { expression: `setRegistry({}); window.__chatNames = {}; window.__relinkMode = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}
async function relink(idx) {
    relinkInProgress = idx;
    const config = loadConfig();
    const oldId = config.agents[idx]?.id || "";
    if (config.agents[idx])
        config.agents[idx].id = "";
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 103, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry[${idx}] = ""; setRegistry(window.__chatRegistry); window.__relinkMode = ${idx}; window.__relinkOldId = "${oldId}";` } }));
            ws.on('message', () => ws.close());
        });
    }
}
async function cancelRelink(idx) {
    relinkInProgress = null;
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 104, method: 'Runtime.evaluate', params: { expression: `setRegistry(window.__chatRegistry); window.__relinkMode = null; window.__relinkOldId = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}
async function deleteAgent(idx) {
    const config = loadConfig();
    pendingDeletes.add(idx.toString());
    delete config.agents[idx];
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 105, method: 'Runtime.evaluate', params: { expression: `delete window.__chatRegistry[${idx}]; setRegistry(window.__chatRegistry); delete window.__chatNames[${idx}]; if(window.__relinkMode == ${idx}) window.__relinkMode = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}
function getDashboardHtml(webview, extensionPath) {
    const iconPath = vscode.Uri.file(path.join(extensionPath, 'agbridge-icon.png'));
    const iconUri = webview.asWebviewUri(iconPath);
    const htmlPath = path.join(extensionPath, 'src', 'dashboard.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    // Replace placeholders
    html = html.replace(/\${iconUri}/g, iconUri.toString());
    return html;
}
function activate(context) {
    globalExtensionPath = context.extensionPath;
    setupGlobalCommand(context.extensionPath);
    outputChannel = vscode.window.createOutputChannel("Antigravity Bridge");
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.inject', () => injectBridge()));
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.showDashboard', () => showDashboard()));
    injectBridge().catch(() => { });
    // Background polling for logs and status
    setInterval(async () => {
        if (isPolling)
            return;
        isPolling = true;
        try {
            const tab = await getAntigravityTab();
            if (!tab) {
                updateStatusBar(BridgeState.MissingRDP);
            }
            else {
                // Check for captured context
                const ws = new ws_1.default(tab.webSocketDebuggerUrl);
                ws.on('open', () => {
                    ws.send(JSON.stringify({
                        id: 200,
                        method: 'Runtime.evaluate',
                        params: { expression: '!!window.__agCaptured?.last' }
                    }));
                });
                ws.on('message', (data) => {
                    const msg = JSON.parse(data.toString());
                    if (msg.command === 'changeIndex') {
                        const config = loadConfig();
                        const oldIdx = msg.idx;
                        vscode.window.showInputBox({ prompt: `New index for ${config.agents[oldIdx]?.name || 'Agent'}`, value: oldIdx }).then(newIdx => {
                            if (newIdx && newIdx !== oldIdx) {
                                config.agents[newIdx] = config.agents[oldIdx];
                                delete config.agents[oldIdx];
                                saveConfig(config);
                                updateDashboard();
                            }
                        });
                    }
                    if (msg.command === 'rename') {
                        const config = loadConfig();
                        vscode.window.showInputBox({ prompt: 'Agent Name', value: config.agents[msg.idx]?.name }).then(name => {
                            if (name) {
                                if (!config.agents[msg.idx])
                                    config.agents[msg.idx] = { id: '', name: '', duty: '' };
                                config.agents[msg.idx].name = name;
                                saveConfig(config);
                                updateDashboard();
                            }
                        });
                    }
                    if (msg.command === 'defineDuty') {
                        const config = loadConfig();
                        vscode.window.showInputBox({ prompt: 'Agent Duty', value: config.agents[msg.idx]?.duty }).then(duty => {
                            if (duty) {
                                if (!config.agents[msg.idx])
                                    config.agents[msg.idx] = { id: '', name: '', duty: '' };
                                config.agents[msg.idx].duty = duty;
                                saveConfig(config);
                                updateDashboard();
                            }
                        });
                    }
                    if (msg.command === 'saveSettings') {
                        const config = loadConfig();
                        config.settings.cliTimeout = msg.settings.cliTimeout;
                        config.settings.timeout = msg.settings.timeout;
                        config.settings.logHeartbeat = msg.settings.logHeartbeat;
                        saveConfig(config);
                        // Push to browser immediately
                        if (tab) {
                            const ws2 = new ws_1.default(tab.webSocketDebuggerUrl);
                            ws2.on('open', () => {
                                ws2.send(JSON.stringify({
                                    id: 106,
                                    method: 'Runtime.evaluate',
                                    params: {
                                        expression: `localStorage.setItem('__ag_cli_timeout', '${config.settings.cliTimeout * 1000}'); localStorage.setItem('__ag_timeout', '${config.settings.timeout * 1000}'); localStorage.setItem('__ag_log_heartbeat', '${config.settings.logHeartbeat}'); window.__agLogHeartbeat = ${config.settings.logHeartbeat}; window.__agCliTimeout = ${config.settings.cliTimeout * 1000}; window.__agTimeout = ${config.settings.timeout * 1000};`
                                    }
                                }));
                                ws2.on('message', () => ws2.close());
                            });
                        }
                    }
                    if (msg.command === 'resetAll') {
                        const config = loadConfig();
                        config.agents = {};
                        saveConfig(config);
                        updateDashboard();
                    }
                    if (msg.command === 'deleteAgent') {
                        const config = loadConfig();
                        delete config.agents[msg.idx];
                        saveConfig(config);
                        updateDashboard();
                    }
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
        }
        catch (e) {
            updateStatusBar(BridgeState.MissingRDP);
        }
        isPolling = false;
    }, 2000);
}
function deactivate() { if (statusBarItem)
    statusBarItem.dispose(); }
//# sourceMappingURL=extension.js.map