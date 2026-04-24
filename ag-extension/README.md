# Antigravity Bridge Extension

Automatisches Injizieren und Steuern des Antigravity Chats aus VS Code.

## Voraussetzungen

Antigravity muss mit dem Remote Debugging Port gestartet werden:
```bash
./antigravity --remote-debugging-port=9222
```

## Features

- **Auto-Inject**: Injiziert das Bridge-Script automatisch beim Start von VS Code.
- **Status Dashboard**: Eine moderne Webansicht zur Überwachung von Verbindung, CSRF-Token und Chats.
- **Persistent Naming & Duties**: Speichere Namen und Verantwortlichkeiten für deine Agenten projektbezogen.
- **Global CLI**: Steuere deine Chats direkt aus dem Terminal mit `agbridge`.

## Global CLI (agbridge)

Die Extension installiert automatisch einen globalen Command `agbridge` in `~/.local/bin/`. Damit kannst du den Chat direkt aus jedem Terminal steuern:

```bash
# Einfache Nachricht
agbridge 1 "Wie geht es dir?"

# Volle Logs (Tool-Calls, Gedanken, Browser-Aktionen)
agbridge 1 "Analysiere den Code" --all
```

## Dashboard Features

- **Relinking**: Erkennt automatisch Chats aus Projekten wieder (via `ag-config.json`).
- **Duties**: Weise jedem Agenten eine feste Aufgabe zu ("Backend Specialist", etc.).
- **Copy Instructions**: Generiert einen fertigen Prompt für andere KI-Agenten, damit diese wissen, wie sie die Bridge über das Terminal steuern können.

## Verwendung

1. Antigravity mit Port 9222 starten.
2. Diese Extension laden/aktivieren.
3. Klicke auf den Statusbar-Button "AG Bridge Inactive" zum ersten Inject.
4. Nutze das Dashboard (Zap-Icon in der Statusbar) zum Verwalten der Chats.
