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
const crypto_1 = require("crypto");
let statusBarItem;
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
                vscode.window.showInformationMessage('🚀 Antigravity Bridge injiziert!');
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
        statusBarItem.command = 'agbridge.manageChats';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        statusBarItem.tooltip = 'Klicken, um Chats zu verwalten';
    }
    else {
        statusBarItem.text = '$(circle-slash) AG Bridge Inactive';
        statusBarItem.command = 'agbridge.inject';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'Bridge inaktiv. Klicken zum Injizieren.';
    }
}
async function manageChats() {
    const tab = await getAntigravityTab();
    if (!tab) {
        vscode.window.showErrorMessage('Antigravity nicht erreichbar.');
        return;
    }
    const ws = new ws_1.default(tab.webSocketDebuggerUrl);
    ws.on('open', () => {
        // Registry und Names aus dem Browser holen
        ws.send(JSON.stringify({
            id: 10,
            method: 'Runtime.evaluate',
            params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames })' }
        }));
        ws.on('message', async (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 10) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const registry = browserState.registry || {};
                const browserNames = browserState.names || {};
                // Lokal ag-config.json lesen
                const configPath = path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', 'ag-config.json');
                let config = { chatNames: {} };
                if (fs.existsSync(configPath)) {
                    try {
                        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }
                    catch { }
                }
                const items = Object.keys(registry).map(idx => {
                    const id = registry[idx];
                    const name = config.chatNames[idx] || browserNames[idx] || '';
                    return {
                        label: `Chat ${idx}`,
                        description: name ? `[${name}] ${id.slice(0, 8)}...` : id,
                        idx: idx,
                        id: id
                    };
                });
                if (items.length === 0) {
                    vscode.window.showInformationMessage('Noch keine Chats erkannt. Schreib erst etwas im Antigravity Chat.');
                    ws.close();
                    return;
                }
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Wähle einen Chat zum Umbenennen'
                });
                if (selected) {
                    const newName = await vscode.window.showInputBox({
                        prompt: `Name für Chat ${selected.idx} (${selected.id})`,
                        value: config.chatNames[selected.idx] || ''
                    });
                    if (newName !== undefined) {
                        // In ag-config.json speichern
                        config.chatNames[selected.idx] = newName;
                        config.registry = registry;
                        config.ts = Date.now();
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                        // Zurück in den Browser syncen
                        ws.send(JSON.stringify({
                            id: 11,
                            method: 'Runtime.evaluate',
                            params: { expression: `window.__chatNames[${selected.idx}] = "${newName}"; console.log("Name ${selected.idx} -> ${newName} synced")` }
                        }));
                        vscode.window.showInformationMessage(`Chat ${selected.idx} heißt nun "${newName}"`);
                    }
                }
                ws.close();
            }
        });
    });
}
async function sendToChat() {
    const tab = await getAntigravityTab();
    if (!tab) {
        vscode.window.showErrorMessage('Kein Antigravity Tab gefunden.');
        return;
    }
    const chatIndexStr = await vscode.window.showInputBox({
        prompt: 'Chat Index oder Name (z.B. 1)',
        placeHolder: '1'
    });
    if (!chatIndexStr)
        return;
    const text = await vscode.window.showInputBox({
        prompt: 'Nachricht an Antigravity',
        placeHolder: 'Schreib hello.py...'
    });
    if (!text)
        return;
    const reqId = (0, crypto_1.randomUUID)();
    const chatIndex = isNaN(parseInt(chatIndexStr)) ? chatIndexStr : parseInt(chatIndexStr);
    const ws = new ws_1.default(tab.webSocketDebuggerUrl);
    ws.on('open', () => {
        const cmd = JSON.stringify({ chatIndex, text, reqId, opts: { all: false } });
        ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: `localStorage.setItem('__cmd', ${JSON.stringify(cmd)})` }
        }));
        const iv = setInterval(() => {
            ws.send(JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: { expression: `localStorage.getItem('__res_${reqId}')` }
            }));
        }, 500);
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 2 && msg.result?.result?.value) {
                const res = JSON.parse(msg.result.result.value);
                clearInterval(iv);
                ws.close();
                const channel = vscode.window.createOutputChannel("Antigravity Bridge");
                channel.appendLine(`--- AG RESPONSE (${chatIndex}) ---`);
                channel.appendLine(res.answer);
                if (res.files && res.files.length > 0) {
                    channel.appendLine(`Files: ${res.files.join(', ')}`);
                }
                channel.show();
            }
        });
    });
}
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.inject', () => {
        injectBridge();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.send', sendToChat));
    context.subscriptions.push(vscode.commands.registerCommand('agbridge.manageChats', manageChats));
    updateStatusBar(false);
    injectBridge().catch(() => { });
}
function deactivate() {
    if (statusBarItem)
        statusBarItem.dispose();
}
//# sourceMappingURL=extension.js.map