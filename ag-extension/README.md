# Antigravity Bridge Extension

Automatisches Injizieren und Steuern des Antigravity Chats aus VS Code.

## Voraussetzungen

Antigravity muss mit dem Remote Debugging Port gestartet werden:
```bash
./antigravity --remote-debugging-port=9222
```

## Features

- **Auto-Inject**: Injiziert das Bridge-Script automatisch beim Start von VS Code (falls Antigravity läuft).
- **Statusbar**: Zeigt an, ob die Bridge aktiv ist. Ein Klick re-injiziert das Script.
- **Commands**:
  - `AG: Inject Bridge`: Manueller Inject.
  - `AG: Send to Chat`: Sendet einen Prompt an einen spezifischen Chat (1, 2, ...).

## Verwendung

1. Antigravity mit Port 9222 starten.
2. Diese Extension laden/aktivieren.
3. In der Command Palette `AG: Send to Chat` wählen.
4. Prompt eingeben und Ergebnis im Output Channel "Antigravity Bridge" sehen.
