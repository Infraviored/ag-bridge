import * as vscode from 'vscode';
import * as http from 'http';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

let statusBarItem: vscode.StatusBarItem;
let bridgeActive = false;

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

        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: script }
            }));
        });

        ws.on('message', (data: WebSocket.Data) => {
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
        statusBarItem.command = 'agbridge.manageChats';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        statusBarItem.tooltip = 'Klicken, um Chats zu verwalten';
    } else {
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

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.on('open', () => {
        // Registry und Names aus dem Browser holen
        ws.send(JSON.stringify({
            id: 10,
            method: 'Runtime.evaluate',
            params: { expression: 'JSON.stringify({ registry: window.__chatRegistry, names: window.__chatNames })' }
        }));

        ws.on('message', async (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 10) {
                const browserState = JSON.parse(msg.result?.result?.value || '{}');
                const registry = browserState.registry || {};
                const browserNames = browserState.names || {};

                // Lokal ag-config.json lesen
                const configPath = path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', 'ag-config.json');
                let config: any = { chatNames: {} };
                if (fs.existsSync(configPath)) {
                    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { }
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
    if (!chatIndexStr) return;

    const text = await vscode.window.showInputBox({
        prompt: 'Nachricht an Antigravity',
        placeHolder: 'Schreib hello.py...'
    });
    if (!text) return;

    const reqId = randomUUID();
    const chatIndex = isNaN(parseInt(chatIndexStr)) ? chatIndexStr : parseInt(chatIndexStr);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
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

        ws.on('message', (data: WebSocket.Data) => {
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

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('agbridge.inject', () => {
            injectBridge();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agbridge.send', sendToChat)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agbridge.manageChats', manageChats)
    );

    updateStatusBar(false);
    injectBridge().catch(() => {});
}

export function deactivate() {
    if (statusBarItem) statusBarItem.dispose();
}
