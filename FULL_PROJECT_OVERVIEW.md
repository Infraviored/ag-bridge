# 🔬 Antigravity Bridge — Vollständige Dokumentation

**Stand: 24. April 2026 | Verifiziert: Beide Chats vollautomatisch steuerbar**

***

## Was wir gebaut haben

Einen Mechanismus, der es erlaubt, aus jedem externen Prozess heraus (Terminal, Python, Node.js, Claude Code) Nachrichten in beliebige Antigravity-Chats zu schicken und deren Antworten vollständig maschinell auszulesen — ohne auch nur einen einzigen Klick in der UI.

Das Ergebnis:

```
node send.mjs heino "schreib hello.py"  →  Agent antwortet + erstellt Datei  ✅
node send.mjs gerdi "dein name?"        →  Agent antwortet mit Name            ✅
```


***

## Technisches Fundament

### Wie Antigravity intern kommuniziert

Antigravity läuft als Electron/VSCode-App. Die Webview kommuniziert mit einem lokalen Language-Server über HTTPS auf einem **dynamisch vergebenen Port** (z.B. `127.0.0.1:46093`). Das Protokoll ist **Connect RPC** — ein HTTP-kompatibles gRPC-Subset. Alle Endpunkte liegen unter:

```
https://127.0.0.1:<PORT>/exa.language_server_pb.LanguageServerService/<METHOD>
```


### Die drei relevanten Endpunkte

| Endpunkt | Methode | Zweck |
| :-- | :-- | :-- |
| `SendUserCascadeMessage` | POST | Nachricht in einen Chat schicken |
| `StreamAgentStateUpdates` | POST (Streaming) | Antwort-Stream des Agents abonnieren |
| `HandleCascadeUserInteraction` | POST | Tool-Call-Approvals (auto-approve) |

### Die drei kritischen Identifikatoren

| Wert | Woher | Ändert sich |
| :-- | :-- | :-- |
| **PORT** | Automatisch gecaptured aus URL | Bei jedem Neustart |
| **`x-codeium-csrf-token`** | Automatisch gecaptured aus Request-Header | Bei jedem Neustart |
| **`cascadeId`** | Automatisch aus Stream-Chunks extrahiert | Nie (Chat-persistent) |

### Das Connect RPC Envelope-Format

Requests an `StreamAgentStateUpdates` brauchen `application/connect+json` mit einem **5-Byte-Envelope-Header**:

```
Byte 0:    Flags (0x00 = kein Flag)
Bytes 1-4: Payload-Länge als uint32 big-endian
Bytes 5+:  JSON-Payload
```

Das war der erste große Blocker — das `o`-Zeichen am Anfang des abgefangenen Bodys ist **kein mysteriöser Prefix**, sondern schlicht das erste Byte des JSON (`{` hat in manchen Encodings denselben Hex-Wert). Der echte Header ist `00 00 00 00` gefolgt von der Länge.

***

## Was der Fetch-Interceptor macht

Der gesamte Mechanismus basiert darauf, dass wir `window.fetch` monkey-patchen. Der Hook tut drei Dinge gleichzeitig:

**1. CSRF + Port + Body cachen (`SendUserCascadeMessage`)**
Jedes Mal wenn Antigravity selbst eine Nachricht sendet (also wenn du manuell schreibst), speichern wir URL, alle Header (inklusive CSRF-Token) und den kompletten Body in `window.__agCaptured.last`. Damit haben wir alles was wir brauchen um beliebige weitere Requests zu fälschen — Port, CSRF, cascadeConfig.

**2. Chat-IDs automatisch registrieren (`StreamAgentStateUpdates`)**
In den Stream-Chunks stecken die `conversationId`s aller Chats. Sobald eine neue ID auftaucht, wird sie als `window.__chatRegistry[N]` gespeichert. Das passiert automatisch im Hintergrund beim normalen Betrieb von Antigravity.

**3. Alle Chunks in `__agReadLog` sammeln**
Jeder eingehende Stream-Chunk wird mit Timestamp geloggt. `postAndReadAuto` filtert später nach `cascadeId` und `sentAt` um sauber nur die Chunks der richtigen Antwort zu bekommen.

***

## Warum Chat 2 im Hintergrund nicht einfach so funktioniert

Antigravity öffnet `StreamAgentStateUpdates` **nur für den aktuell sichtbaren Chat**. Ein Chat im Hintergrund hat keinen offenen Stream. Das bedeutet:

- `SendUserCascadeMessage` → `200 {}` ✅ (Nachricht landet im Chat)
- Antwort-Chunks kommen nie an ❌ (kein Stream offen)


### Die Lösung: Antigravity-Reconnect triggern

Wenn wir selbst einen `StreamAgentStateUpdates`-Request für die Ziel-`cascadeId` schicken, erkennt Antigravity einen neuen Subscriber und öffnet **seinen eigenen Stream neu**. Unser Request wird von AG dabei gekillt (`BodyStreamBuffer aborted`) — das ist **gewollt und normal**. AGs neuer Stream liefert die Chunks dann korrekt in unseren Fetch-Hook. Das ist `activateStream()`.

***

## CSRF-Token: Session-weit, nicht chat-weit

**Wichtige Erkenntnis:** Ein einziger CSRF-Token gilt für **alle Chats** einer Antigravity-Session. Es reicht also, einmalig in einen beliebigen Chat manuell zu schreiben — danach kann man jeden Chat steuern. Die `cascadeId`-Registrierung braucht zwar trotzdem den Stream (der Chat muss mindestens einmal geöffnet gewesen sein), aber kein zweites manuelles Schreiben.

***

## Das `modifiedResponse`-Pattern

Die Antwort des Agents steckt **nicht** im Response-Body von `SendUserCascadeMessage` (der ist leer: `{}`). Sie steckt in den `StreamAgentStateUpdates`-Chunks als JSON-Feld `"modifiedResponse":"..."`.

Das Feld wird während der Antwort-Generierung **mehrfach** mit wachsendem Inhalt gesendet (Streaming-Deltas als vollständige Snapshots). Deshalb brauchen wir die Prefix-Dedup-Logik:

```js
const steps = raw.filter((r, i) =>
  !raw.some((other, j) => j > i && other.startsWith(r) && other.length > r.length)
);
```

Nur `j > i` entfernen — kürzere frühere Versionen rausfiltern, aber keine späteren. Das ergibt entweder die finale Antwort (`steps.at(-1)`) oder alle Zwischenschritte (`steps.join('\n\n---\n\n')` bei `--all`).

***

## Status-Detection: Wann ist der Agent fertig?

Der Agent signalisiert seinen Zustand über `executorLoopStatus`:

- `"CASCADE_RUN_STATUS_RUNNING"` → Agent denkt / führt Tool-Calls aus
- `"CASCADE_RUN_STATUS_IDLE"` → Agent fertig

Wir warten auf `IDLE`, aber erst nachdem mindestens 3 Sekunden nach dem letzten `RUNNING`-Chunk vergangen sind. Das verhindert false positives bei kurzen IDLE-Lücken zwischen Tool-Calls.

***

## Dateipfade aus dem Stream lesen

Tool-Calls die Dateien erstellen oder lesen enthalten `"uri":"file:///pfad/zur/datei"` in den Chunks. Das ist woher `📁 /home/...` in der Ausgabe kommt:

```js
for (const m of [...ch.chunk.matchAll(/"uri"\s*:\s*"file:\/\/([^"]+)"/g)])
  filesSeen.add(m[^1]);
```


***

## System Prompt und Modell-Konfiguration auslesen

Die Chunks enthalten in `generatorMetadatasUpdate` die komplette Planner-Konfiguration. Was bereits verifiziert extrahiert wurde:

- `modelName: "gemini-3-flash-agent"` → Antigravity läuft auf Gemini 3 Flash
- `fastApplyModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH"` → Fast-Apply nutzt Gemini 2.5 Flash
- `checkpointModel: "MODEL_PLACEHOLDER_M50"` → Checkpoint-Kompression eigenes Modell
- `intentModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH"` → Intent-Klassifikation Gemini 2.5 Flash
- `maxOutputTokens: 65536` → Kontext-Limit pro Response
- `autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF"` → Commands brauchen Approve

Der **echte System Prompt** (was der Planner ans Modell schickt) steckt in `notifyingPrompt` im `generatorMetadatas`-Chunk. Zum Auslesen nach einem `postAndReadAuto`:

```js
window.__agReadLog
  .filter(x => x.kind === 'fetch-chunk' && x.chunk.includes('notifyingPrompt'))
  .forEach(x => {
    const m = x.chunk.match(/"notifyingPrompt":"((?:[^"\\]|\\.)*)"/);
    if (m) console.log(m[^1].replace(/\\n/g,'\n').replace(/\\"/g,'"'));
  });
```

Der komplette Conversation-Context (was das Modell als History sieht) liegt in Chunks mit `CORTEX_STEP_TYPE_CONVERSATION_HISTORY`.

***

## Die drei Scripts im Überblick

**`bridge.js` (DevTools Console)**
Das Herzstück. Wird nach jedem Neustart von Antigravity einmalig in die DevTools-Konsole eingefügt. Installiert den Fetch-Interceptor, baut alle globalen Funktionen auf (`postToChat`, `activateStream`, `postAndReadAuto`, `sendTo`) und startet den IPC-Polling-Loop der auf `localStorage.__cmd` wartet.

**`wizard.mjs` (Node.js, einmalig)**
Setup-Tool. Verbindet sich per Chrome DevTools Protocol (CDP) auf Port 9222 mit dem Antigravity-Tab, wartet interaktiv auf Chat-Registrierungen und CSRF-Capture, fragt dann die Namen für jeden Chat ab, schreibt `ag-config.json` und zeigt die fertige Übersicht. Nur einmal nach jedem Neustart ausführen.

**`send.mjs` (Node.js, täglich)**
Das eigentliche CLI-Tool. Liest `ag-config.json`, schreibt den Command per CDP in `localStorage.__cmd`, pollt `localStorage.__res_<reqId>` bis die Antwort da ist, gibt sie formatiert aus. Unterstützt Index oder Name als Ziel, `--all` für alle Zwischenschritte.

***

## Startup-Prozedur nach jedem Neustart

```
1. Antigravity starten
2. Mindestens einen Chat öffnen (Tab anklicken reicht)
3. DevTools: Help → Toggle Developer Tools
4. "allow pasting" → Enter (einmalig)
5. bridge.js komplett einfügen → Enter
6. Einmal manuell in irgendeinen Chat tippen → Enter
   → "📡 Capture! CSRF=..." erscheint
7. node wizard.mjs starten → Chats benennen → fertig
8. Ab jetzt: node send.mjs heino "..."
```


***

## IPC-Mechanismus: Wie Terminal und Browser kommunizieren

Node.js kann nicht direkt `window.fetch` aufrufen. Die Bridge löst das über **Chrome DevTools Protocol (CDP)**:

```
Terminal                  Chrome DevTools Protocol        Browser (Antigravity)
─────────────────────     ────────────────────────────    ────────────────────────
send.mjs schreibt    →    Runtime.evaluate:               Bridge-Loop liest
localStorage.__cmd        localStorage.setItem(...)       __cmd alle 200ms

send.mjs pollt       ←    Runtime.evaluate:               Bridge schreibt
localStorage.__res_X      localStorage.getItem(...)       __res_X nach sendTo()
```

Das ist bewusst simpel gehalten — kein WebSocket-Server, keine zusätzliche Dependency außer `ws`.

***

## Bekannte Eigenheiten

| Problem | Ursache | Fix |
| :-- | :-- | :-- |
| `__agCaptured.last` ist `null` | Bridge läuft, aber noch kein CSRF gecaptured | Einmal manuell in Chat tippen |
| `415 Unsupported Media Type` | falscher Content-Type beim Stream-Trigger | `application/connect+json` verwenden (nicht `application/json`) |
| `BodyStreamBuffer aborted` | AG killt unseren Trigger-Stream — gewollt | Ignorieren |
| Antwort kommt nicht | Chat nie im Stream erschienen | Chat einmal öffnen (Tab anklicken) |
| Alter Hook-Rauschen (`[READ]`-Logs) | Altes Script noch im `window.fetch`-Stack | Antigravity komplett neu starten |
| `steps` enthält Duplikate | Prefix-Filter war `j !== i` statt `j > i` | Im finalen Script gefixt |

<span style="display:none">[^2][^3][^4]</span>

<div align="center">⁂</div>

[^1]: console.log-activateStream-postAndReadAuto-ge.md

[^2]: funktioniert-KNAPP_-wie-jetzt-mit-node__ndefined.md

[^3]: Die-ganze-Read-Kacke-ist-noch-immer-da.-Allerdings.md

[^4]: YYYYYYEEEEESS-trage-das-jetzt-nochaml-ALLLES-ALL.md

