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
            // updateStatusBar(false); // Silent fail on auto-start is fine, but message on manual is better
            return;
        }

        const scriptPath = path.join(__dirname, 'bridge.js');
        // Falls im out-Ordner nicht gefunden (z.B. während Entwicklung), schau im src-Ordner
        const finalScriptPath = fs.existsSync(scriptPath) ? scriptPath : path.join(__dirname, '..', 'src', 'bridge.js');
        if (!fs.existsSync(finalScriptPath)) {
            console.error('Bridge script not found at', finalScriptPath);
            return;
        }
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

        ws.on('error', (e: Error) => {
            console.error('WS Error:', e);
            updateStatusBar(false);
        });

    } catch (e) {
        console.error('Inject Error:', e);
        updateStatusBar(false);
    }
}

function updateStatusBar(active: boolean) {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'agbridge.inject';
        statusBarItem.show();
    }
    if (active) {
        statusBarItem.text = '$(zap) AG Bridge Active';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        statusBarItem.tooltip = 'Bridge ist aktiv. Klicken zum Re-Injektieren.';
    } else {
        statusBarItem.text = '$(circle-slash) AG Bridge Inactive';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'Bridge inaktiv. Klicken zum Injizieren (Port 9222 muss offen sein).';
    }
}

async function sendToChat() {
    const tab = await getAntigravityTab();
    if (!tab) {
        vscode.window.showErrorMessage('Kein Antigravity Tab gefunden. Port 9222?');
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
                
                vscode.window.showInformationMessage(`Antigravity Antwort erhalten!`);
                
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
    
    ws.on('error', (e) => {
        vscode.window.showErrorMessage(`WebSocket Fehler: ${e.message}`);
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Antigravity Bridge Extension is now active!');

    context.subscriptions.push(
        vscode.commands.registerCommand('agbridge.inject', () => {
            injectBridge();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agbridge.send', sendToChat)
    );

    updateStatusBar(false);

    // Auto-inject on start
    injectBridge().catch(() => {});
}

export function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
