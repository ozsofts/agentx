# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

When the sidebar is collapsed, show the Pi Agent logo in the header. Hovering or focusing that logo must reveal the sidebar expand control in the same position; clicking it expands the sidebar.

On desktop widths, keep the sidebar management entry as an icon-only gear at the bottom right, alongside the Agent Host status. Preserve the existing mobile footer layout.

Model settings must show configured providers together with credential sources and direct links to edit them, so users do not need to inspect providers one by one. Never expose stored credential values in the renderer.

Keep rendered Markdown headings compact and proportional to the surrounding body text, with restrained weight and spacing rather than oversized document-style titles.

Model request failures must be visible in the chat with a clear reason and expandable original details, remain visible after session restore, and mark the run as failed rather than completed.

The first Skills release is local-first: provide a bundled catalog, local-folder import, workspace-scoped install/remove, and Pi session reload. Keep catalog sources behind the same UI/transport contract so an enterprise Skills Hub can be added later without changing the installation boundary.

The first Tools release is registry-driven: global enabled tool IDs live in Desktop settings, projects may inherit or override them, and Agent Host resolves IDs to Pi runtime tool names when creating a Session. Treat tools without trusted registry metadata as executable-risk operations.
