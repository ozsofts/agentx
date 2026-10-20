# Agentx

A Codex-inspired local desktop client for Pi Agent. The renderer consumes a stable application event protocol while Pi runs in an isolated Electron utility process.

## Implemented Loop

- Select and restore a local project directory
- Keep project actions in the sidebar: project rows show only their name, with a hover/focus card for directory, session count, pinning and editing. Paste images or supported UTF-8 text/code files into the composer as pending attachments; ordinary pasted text stays in the draft.
- Create or reopen Pi JSONL sessions
- Use the conversation header menu to rename, inspect, export HTML/complete JSONL, import JSONL into a confirmed project, or archive a session. Imports receive independent IDs and preserve the source file; archives retain JSONL and can be restored in project information. Empty drafts are saved only after the first message, and disruptive actions are blocked while running.
- Recover project metadata from `.pi/project.json` and reconcile it with Pi JSONL sessions
- Stream assistant text and tool lifecycle events
- Keep active reasoning expanded, collapse each block when it finishes, and reopen it without discarding recorded reasoning.
- Type during a run: additional inputs queue above the composer. Use each row's **Steer** action to supplement the current task at the next assistant/tool boundary, delete to cancel an unconsumed input, or the more menu to inspect/edit it or switch back to follow-up. Stop or model failure pauses remaining inputs for explicit resend. Queues and drafts are scoped by Session and retained while the app runs; pending inputs enter JSONL only when consumed, and pending queues are not saved across application restarts.
- Index the first user message immediately, show running Sessions in the sidebar, and switch between Sessions while background tasks continue. Live runs use separate utility processes; inactive idle processes are released and can reopen from JSONL. Quitting the application still stops its local Hosts.
- Keep permissions and work-panel tabs/visibility scoped to the selected Session. Preview state is retained during this app run, not across restarts.
- Test draft model credentials/Base URL with a standalone short request, or fetch/search the provider's live model catalog. Discovery supports OpenAI-compatible, Anthropic and Gemini endpoints; unknown models remain visible but require a Pi adapter before selection. Browser Mock mode does not perform real provider tests.
- Enforce read-only, ask-before-running, and full-access policies inside Agent Host
- Manage the Pi tool catalog globally and override enabled tools per project
- Approve or deny `bash`, `edit`, and `write` before execution
- Abort an active run
- Collect real Git status, line statistics, and unified patches
- Use the tabbed work panel for Diff, images, static SVG, Markdown, sandboxed HTML with local resources, Mermaid diagrams, and local GLB models with CAD3D region/layer controls, interior walk mode and section clipping
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

See [model services and coding-agent runtimes](docs/model-services-and-agent-runtimes.md) for discovery limits and the proposed independent-agent integration boundary.

## Work panel

Open **工作面板** in the conversation header. An empty panel offers **查看变更**, **打开文件**, and **打开网页**. The **+** menu offers the same choices and external-folder authorization. Tabs sit alongside the conversation header, scroll horizontally when needed, and can all be closed; closing the last tab returns to the chooser. Collapsing preserves the selected tab, and an expand control temporarily fills the workspace. File tabs can switch between preview and source; image previews support fit and zoom. Mermaid works both in `.mmd` / `.mermaid` files and fenced `mermaid` blocks in Markdown.

HTTP/HTTPS links in chat reveal a website tab in the current Session's panel; repeated links reuse that tab. Desktop browsing uses isolated sandboxed Electron WebContentsViews with address/history/refresh controls, readable load failures and an explicit system-browser fallback. Pages have no Desktop preload, Node integration or local-preview protocol, use a separate in-memory browser session, and cannot request local permissions or start downloads. New-window links become panel tabs. Native views hide beneath dialogs/operation menus, in management and when their tab is inactive; closing a web tab releases its process. The browser-only demo uses restricted iframes and explains that some websites refuse embedding.

Desktop previews resolve HTML/CSS/image/font resources relative to the document or project root through a workspace-scoped, revocable `pi-preview:` URL. HTML runs in an iframe with scripts and Electron APIs disabled; SVG is displayed as a static image. JavaScript-driven web applications require a future browser mode. Requests outside the project, including external symlink targets, are rejected. Text previews are limited to 2 MB, images to 20 MB, and open file tabs to 24.

Open files and their loaded resources are watched for changes, including atomic file replacement. Updates refresh the affected preview without changing the selected tab; a refresh button is also available. Panel tabs, selection and visibility are retained per Session while the application runs. Tabs are not persisted across app restarts. The browser demo can open local file snapshots, but workspace-relative resources and automatic refresh require the desktop host.

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

On macOS, `npm run dev:desktop`, `npm start` and the desktop smoke test use a cached, locally signed `Agentx.app` so the system menu and Dock also show Agentx. The first launch prepares this runtime under `node_modules/.cache/agentx-electron`; subsequent launches reuse it. The original Electron dependency and existing Desktop/Pi data paths are preserved. Launch through these scripts rather than invoking `electron .` directly, which uses the stock Electron bundle name.

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
