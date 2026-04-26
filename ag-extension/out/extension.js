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
    const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
    return path.join(root, 'ag-config.json');
}
function loadConfig() {
    const configPath = getConfigPath();
    let config = { chatNames: {}, chatDuties: {}, registry: {} };
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        catch { }
    }
    if (!config.chatDuties)
        config.chatDuties = {};
    if (!config.chatNames)
        config.chatNames = {};
    if (!config.registry)
        config.registry = {};
    return config;
}
function saveConfig(config) {
    const configPath = getConfigPath();
    const cliTimeout = vscode.workspace.getConfiguration('antigravity.bridge').get('cliTimeout', 10);
    config.ts = Date.now();
    config.cliTimeout = cliTimeout;
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
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: script + "\n" + syncScript }
            }));
        });
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
                    if (config.registry[newIdx]) {
                        vscode.window.showErrorMessage(`Index ${newIdx} is already in use!`);
                        return;
                    }
                    // Move data
                    config.registry[newIdx] = config.registry[message.idx];
                    config.chatNames[newIdx] = config.chatNames[message.idx];
                    config.chatDuties[newIdx] = config.chatDuties[message.idx];
                    delete config.registry[message.idx];
                    delete config.chatNames[message.idx];
                    delete config.chatDuties[message.idx];
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
            // SYNC FILE REGISTRY TO BROWSER (Source of Truth)
            const config = loadConfig();
            const syncScript = `(function(){
                const fileReg = ${JSON.stringify(config.registry)};
                const currentReg = JSON.parse(localStorage.getItem('__ag_registry') || '{}');
                const merged = { ...currentReg, ...fileReg };
                localStorage.setItem('__ag_registry', JSON.stringify(merged));
                window.__chatRegistry = merged;
            })()`;
            ws.send(JSON.stringify({ id: 99, method: 'Runtime.evaluate', params: { expression: syncScript } }));
            ws.send(JSON.stringify({
                id: 100,
                method: 'Runtime.evaluate',
                params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames, lastOutputs: window.__lastOutputs, lastPrompts: window.__lastPrompts, busyAgents: window.__busyAgents, captured: !!window.__agCaptured?.last, relinkMode: window.__relinkMode, logs: (window.__agLogs || []).slice(' + lastLogIndex + ') })' }
            }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 100) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const config = loadConfig();
                if (browserState.relinkMode === null && relinkInProgress !== null) {
                    relinkInProgress = null;
                }
                // PROCESS LOGS
                if (browserState.logs && browserState.logs.length > 0) {
                    browserState.logs.forEach((l) => logToChannel(l.msg));
                    lastLogIndex += browserState.logs.length;
                }
                // Clean up pending deletes once browser confirms they are gone
                for (const k of Array.from(pendingDeletes)) {
                    if (!(k in browserState.registry)) {
                        pendingDeletes.delete(k);
                    }
                }
                let changed = false;
                for (const k in browserState.registry) {
                    if (relinkInProgress === k)
                        continue;
                    if (pendingDeletes.has(k))
                        continue; // GUARD: Do not restore ghost agents!
                    if (!config.registry[k]) {
                        config.registry[k] = browserState.registry[k];
                        changed = true;
                    }
                }
                if (changed)
                    saveConfig(config);
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
                        lastOutputs: browserState.lastOutputs,
                        lastPrompts: browserState.lastPrompts
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
    const newName = await vscode.window.showInputBox({ prompt: `Name for Chat ${idx}`, value: config.chatNames[idx] || '' });
    if (newName !== undefined) {
        config.chatNames[idx] = newName;
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
    const duty = await vscode.window.showInputBox({ prompt: `Role for Chat ${idx}`, value: config.chatDuties[idx] || '' });
    if (duty !== undefined) {
        config.chatDuties[idx] = duty;
        saveConfig(config);
    }
}
async function resetAll() {
    const confirm = await vscode.window.showWarningMessage('Wipe ALL mappings and STOP relinking?', 'Yes', 'No');
    if (confirm !== 'Yes')
        return;
    relinkInProgress = null;
    // WIPING ABSOLUTELY EVERYTHING
    const config = loadConfig();
    config.registry = {};
    config.chatNames = {};
    config.chatDuties = {};
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 102, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry = {}; window.__chatNames = {}; window.__relinkMode = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}
async function relink(idx) {
    relinkInProgress = idx;
    const config = loadConfig();
    const oldId = config.registry[idx] || "";
    config.registry[idx] = "";
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 103, method: 'Runtime.evaluate', params: { expression: `window.__chatRegistry[${idx}] = ""; window.__relinkMode = ${idx}; window.__relinkOldId = "${oldId}";` } }));
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
            ws.send(JSON.stringify({ id: 104, method: 'Runtime.evaluate', params: { expression: `window.__relinkMode = null; window.__relinkOldId = null;` } }));
            ws.on('message', () => ws.close());
        });
    }
}
async function deleteAgent(idx) {
    // INSTANT DELETE. NO CONFIRMATION.
    const config = loadConfig();
    pendingDeletes.add(idx.toString());
    delete config.registry[idx];
    delete config.chatNames[idx];
    delete config.chatDuties[idx];
    saveConfig(config);
    const tab = await getAntigravityTab();
    if (tab) {
        const ws = new ws_1.default(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 105, method: 'Runtime.evaluate', params: { expression: `delete window.__chatRegistry[${idx}]; delete window.__chatNames[${idx}]; if(window.__relinkMode == ${idx}) window.__relinkMode = null;` } }));
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