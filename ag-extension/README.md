# Antigravity Bridge: Unlimited Agent Orchestration

The Antigravity Bridge is designed to **break the browser sandbox**. It enables external, terminal-based agents (such as the Cloud Code Agent) to command, orchestrate, and supervise the full cognitive power of Antigravity Chat agents via a standardized CLI.

## 🔓 Unlimited Freedom
Traditional AI chat interfaces are trapped behind a browser UI. This bridge transforms Antigravity into a **headless orchestration engine**. 
*   **Delegate Tasks**: An external agent can spawn sub-tasks across multiple specialized Antigravity agents.
*   **True Parallelism**: Command multiple agents simultaneously. The Bridge handles concurrent execution without session interference.
*   **Deep Supervision**: Use the `--all` flag to audit the internal reasoning and tool-calling of Antigravity agents from your CLI.

## 🛠 Prerequisites

### 1. Remote Debugging Port
Antigravity must be launched with the remote debugging port enabled:
```bash
antigravity --remote-debugging-port=9222
```

### 2. Standardized Launcher (Recommended)
Use the symmetrical `.desktop` launcher provided in `~/links/local_applications/antigravity.desktop`. It automatically enables the debug port for both Profile A and B.

### 3. CLI PATH Requirement
The `agbridge` command is installed to `~/.local/bin/`. Ensure this is in your `$PATH`.

## 💻 The Power Command: `agbridge`

Command syntax: `agbridge <index|name> "your prompt" [--all]`

### Interaction Modes:
- **Standard (Fast)**: `agbridge 1 "..."` 
  - Returns only the final result. Best for data retrieval or quick checks.
- **Supervised (Deep)**: `agbridge 1 "..." --all` 
  - **Full Transparency**: Streams every thought, tool call, and browser interaction. 
  - This allows an external agent to "watch the hands" of the Antigravity agent during complex operations.

## 📊 Dashboard & Command Center

The VS Code dashboard acts as your orchestration hub:
- **Registry**: Map human-readable names and specific "Duties" (responsibilities) to each chat instance.
- **Orchestration Prompt**: Generate a pre-formatted instruction set for external agents, telling them exactly how to command the local bridge.

## 📝 The Workflow

1.  **Launch** Antigravity with port 9222.
2.  **Activate** the extension in VS Code and open the Dashboard (Zap Icon).
3.  **Prime** the connection by sending one manual message in any Antigravity chat.
4.  **Unleash**: Use your external CLI agent to command the bridge.
5.  **Scale**: Run multiple `agbridge` commands in parallel for complex multi-agent workflows.

## 🧪 Testing

The Bridge includes a test suite in the `tests/` directory:
- `tests/parallel_test.sh`: Verifies that multiple agents can be commanded concurrently without collisions.

---
*Built for the age of agentic collaboration. Break the UI. Command the terminal.*
