# Pi Agent Desktop

A Codex-inspired local desktop client for Pi Agent. The renderer consumes a stable application event protocol while Pi runs in an isolated Electron utility process.

## Implemented Loop

- Select and restore a local project directory
- Create or reopen Pi JSONL sessions
- Recover project metadata from `.pi/project.json` and reconcile it with Pi JSONL sessions
- Stream assistant text and tool lifecycle events
- Enforce read-only, ask-before-running, and full-access policies inside Agent Host
- Manage the Pi tool catalog globally and override enabled tools per project
- Approve or deny `bash`, `edit`, and `write` before execution
- Abort an active run
- Collect real Git status, line statistics, and unified patches
- Persist the last workspace and Pi session path across restarts
- Fall back to an interactive browser demo when Electron IPC is unavailable

## Architecture

```text
React renderer
  -> sandboxed contextBridge preload
  -> Electron main IPC broker
  -> utility-process Agent Host
  -> Pi SDK + Pi session JSONL
```

The renderer never imports Pi or Node APIs. `electron/agent-host.mjs` owns the working directory, Pi session, credentials, permission gate, tool execution, event normalization, and Git inspection.

## Data ownership

- Pi JSONL files are the source of truth for conversation messages, reasoning, and tool results.
- Electron `userData/projects.json` is the local Desktop project registry.
- `<project>/.pi/project.json` is the portable project manifest for names, project settings, and Session indexing.
- `Electron userData/desktop-settings.json` stores globally enabled tool IDs; project overrides are also written to the portable manifest.
- Opening or relinking a project reconciles the manifest and Pi Session list by `sessionId`. Empty Sessions are not indexed until the first user message is persisted.
- Archiving a Session only hides its Desktop entry; it does not delete the Pi JSONL file.

## Requirements

- Node.js 22.19 or newer
- Pi SDK is pinned to `@earendil-works/pi-coding-agent@1.3.0` and installed with this app; a separate global Pi CLI is not required.
- Pi provider credentials configured through `~/.pi/agent/auth.json` or Pi-supported environment variables

Without credentials, the desktop shell, workspace persistence, sessions, and Git review still work. Prompt submission reports the real Pi authentication error instead of simulating a response.

## Development

Start the renderer and desktop shell with one command:

```bash
npm install
npm run dev:desktop
```

The development launcher starts Vite first, waits for it to respond, then starts Electron. It chooses an available port from `4174` onward and passes that URL to Electron, so another local service using `4173` or `4174` will not be loaded accidentally. The browser-only renderer URL is printed in the terminal.

If you only need the browser renderer, run `npm run dev`; it uses `http://127.0.0.1:4174` and fails clearly when that fixed port is occupied.

For an automated local workspace smoke test:

```bash
PI_DESKTOP_TEST_WORKSPACE=/absolute/project/path npm run dev:desktop
```

## Build

```bash
npm run build
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Cross-platform target configuration is in `package.json`. macOS artifacts are DMG/ZIP, Windows artifacts are NSIS/portable, and Linux artifacts are AppImage/DEB.

## Verification

```bash
npm test
npm run test:desktop
npm run build
node --check electron/main.mjs
node --check electron/agent-host.mjs
node --check electron/preload.cjs
```

The Agent Host integration test uses the real Pi SDK with a local simulated model endpoint. It checks streaming text/reasoning, tools and permissions, attachments, model settings persistence, Skills reload, Session rename/restore, legacy version-3 JSONL compatibility, and cancellation without a real API key. The Electron smoke test checks the production renderer and the actual preload/IPC/utility-process boundary. Both tests use temporary state and leave existing projects, credentials, and sessions untouched.
