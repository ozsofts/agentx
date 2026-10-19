# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Use “Agentx” as the product name in the sidebar, native application menu, window/browser title, installers and execution/loading/approval copy. Keep Pi as the underlying SDK name only where technical diagnostics or real file paths require it. Branding changes must preserve existing Desktop userData, Pi configuration and Session storage paths.

On macOS, development and local production launchers must use the branded Agentx.app runtime. app.setName() and JavaScript menu labels alone do not change the system menu/Dock identity. Validate the native running application's localized name as well as renderer labels; never modify the original Electron dependency bundle in place.

When the sidebar is collapsed, show the Agentx logo in the header. Hovering or focusing that logo must reveal the sidebar expand control in the same position; clicking it expands the sidebar.

When the project sidebar is collapsed to icons, hovering or focusing a project icon opens that project's session list to its right. Keep the list open while moving into it, allow scrolling and session selection without expanding the sidebar, and show the current and running sessions. Dismiss it on leaving, outside click or Escape; keep native webpage previews beneath this overlay.

On desktop widths, keep the sidebar management entry as an icon-only gear at the bottom right, alongside the Agent Host status. Preserve the existing mobile footer layout.

The sidebar gear toggles management and the previous chat, preserving its draft, scroll position and work-panel tabs. Keep only the sidebar's compact connection indicator; put detailed runtime/transport/model/authentication/backend connection information in General > System information. Do not repeat status beneath the composer or in the management header.

Model settings must show configured providers together with credential sources and direct links to edit them, so users do not need to inspect providers one by one. Never expose stored credential values in the renderer.

Model settings offer explicit draft-configuration testing and live provider model discovery. Testing sends only a short standalone model request, never chat/project content or tools, and does not save configuration. Discovery must distinguish remote visibility from Pi chat compatibility and actual invocation permission; preserve unknown/non-chat entries for inspection without inventing model capabilities. Keep stored secrets in Agent Host, redact error details, and never imply browser Mock operations are real tests.

Keep rendered Markdown headings compact and proportional to the surrounding body text, with restrained weight and spacing rather than oversized document-style titles.

Show each reasoning block expanded while it is streaming and prevent collapsing it or its containing process group during that block. Collapse the block when reasoning ends, independently of the rest of the task, and allow reopening it without removing any recorded content. Restored reasoning starts collapsed.

Keep the composer editable while a Session runs. Default additional messages to follow-up queuing and offer explicit steering at Pi's next assistant/tool boundary; steering never cancels an in-flight model call or command. Show pending inputs separately until Pi consumes them, then append a distinct user/assistant exchange in consumption order. Scope queues and drafts by Session. Stop and model failure pause unconsumed inputs for explicit resend, editing or removal; do not auto-run them after an error. Pending queues are runtime state, not persisted chat messages, and must not be added to the transcript until consumed.

Present pending inputs as compact single rows joined to the top of the composer: queue icon and truncated message at left, inline Steer, trash and ellipsis at right. Allow per-item cancellation and conversion between follow-up and steering during a run. The more menu offers full content and moving the message back to the composer for editing, without overwriting an existing draft. Prevent modifying an input once delivery to Pi has begun.

Keep the composer in normal layout flow so attachments and errors cannot cover the last messages. Stream output in small batches with stable Markdown renderer types. Follow new output only when the reader is near the bottom; preserve their position when reading earlier messages and offer a return-to-latest control. Avoid repeatedly restarting smooth scroll for tokens.

Model request failures must be visible in the chat with a clear reason and expandable original details, remain visible after session restore, and mark the run as failed rather than completed.

Use the shared body-level Modal for dialogs. Keep them within the viewport, scroll long content inside the dialog, isolate background scrolling and focus, and restore interaction when closed. Escape cancels confirmations; dismissing command approval must reject rather than permit execution.

The first Skills release is local-first: provide a bundled catalog, local-folder import, workspace-scoped install/remove, and Pi session reload. Keep catalog sources behind the same UI/transport contract so an enterprise Skills Hub can be added later without changing the installation boundary.

Display explicit Skill invocations in chat as `/skill:name` with the user's task, including after session restore. Keep expanded Skill instructions in the Pi model context and original session history; never render the full expanded block as the user's chat bubble.

The first Tools release is registry-driven: global enabled tool IDs live in Desktop settings, projects may inherit or override them, and Agent Host resolves IDs to Pi runtime tool names when creating a Session. Treat tools without trusted registry metadata as executable-risk operations.

The right side is a Session-scoped tabbed work panel. With no open content, show choices to view changes, open a file or open a website; never create a Diff tab automatically. Diff, files and websites are closeable tabs. Closing the last tab returns to the chooser, while collapsing the panel preserves all tabs and the selected item. The + menu offers the same operations and the external-folder grant. Put tabs and fixed actions in the top application header, aligned with the conversation header, with horizontal tab scrolling and a reversible expanded view.

HTTP/HTTPS links in chat open in the work panel and reveal it when collapsed; reuse an existing tab for the same current URL within that Session. Offer copying and opening in the system browser as explicit context actions. Desktop websites use a sandboxed WebContentsView with no preload, Node integration, app IPC or local-preview protocol, a separate nonpersistent browser session, navigation/history controls and readable errors. Route new-window links to panel tabs. Hide native views when inactive, collapsed, in management, during resize, or beneath dialogs/operation menus, and release them on tab/window close. Browser-only demos must disclose iframe limitations.

Keep separate file previews for images, static SVG, Markdown, HTML, Mermaid and GLB models. Static HTML must resolve workspace-relative resources without giving preview content access to Electron APIs or enabling scripts. Refresh changed files and their loaded local resources without stealing the active tab.

Preview files stay inside the current project by default. Opening a file or folder outside it requires an explicit native-dialog grant: show the granted path in the panel, keep it revocable per document, scope file grants to that file and folder grants to that subtree, and drop grants when the project changes. Chat links never widen the scope on their own.

Render GLB models inside the work panel with the local Three.js viewer; never auto-launch an external viewer, upload a model, or imply CAD3D review status. When the file carries CAD3D semantic extras, expose region selection (default to the densest region, not the whole 10 km drawing), semantic layer toggles, and status/assumption badges, and state that the model is a planning review artifact rather than construction-grade BIM.

Support interior inspection honestly: a first-person walk mode that keeps eye height, mouse-drag look and no wall collision, rendering model materials double-sided only while walking and restoring their original sides on exit; plus an optional height clipping plane for plan sections. Because these models are massing shells without floors, partitions or furniture, disclose an empty interior instead of implying a building information model.

Keep the work panel compact: omit a separate title row, place open-file and close-panel actions at the far right of the tab bar, and show left/right scroll controls when tabs overflow. Panel actions must remain visible while the tabs scroll.

The work panel's left edge is resizable, with a 320px minimum and at least 360px left for chat in desktop split view. Fit narrow overlays to available space, remember the user's width, and let double-clicking the separator restore the default. Support keyboard resizing as well as pointer dragging, including across HTML previews.

Keep current-session actions in the header ellipsis menu: rename, HTML/JSONL export, JSONL import, information and reversible archive. Import must confirm the destination project and create a distinct session without replacing existing records. Empty drafts remain unpersisted until the first user message; disable disruptive actions while a task runs.

Keep runtime state scoped by Session: permission labels must reflect the Host's actual mode, and switching sessions must not interrupt background runs. Index a session as soon as its first user message is persisted and show running sessions in the sidebar. Work-panel tabs, selected preview, visibility, changes and approval decisions belong to their session, including between sessions in the same project. Release inactive idle Host processes while retaining their lightweight session overrides; running Hosts remain alive until settled or explicitly stopped.

Local Agent is a permanent product mode for user-authorized local file analysis and local tools. Local and remote Agent modes coexist and share authenticated model/business APIs. Keep execution location, file permissions, sessions and artifacts explicit per mode; selecting remote mode must not silently transfer local files or sessions. Local file processing may still send selected content to a remote model, so do not imply it guarantees on-device inference.
