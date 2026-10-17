# Design QA

- Source visual truth: `references/codex-official-sidebar.webp`, `references/codex-official-task-flow.webp`, `references/codex-official-agent-output.webp`, `references/codex-official-task-list.webp`
- Source page: https://openai.com/codex/
- Implementation screenshot: `prototype-desktop-final.png`
- Compact-window screenshot: `prototype-compact-final.png`
- Approval-state screenshot: `prototype-approval.png`
- Combined comparison evidence: `design-comparison.png`
- Viewport: 1280 x 720 desktop; 900 x 720 compact desktop
- State: active completed task, task history visible, review panel open; compact state defaults review panel closed

## Full-View Comparison

The official references establish a quiet neutral shell, narrow task navigation, document-like conversation flow, small inline activity states, and a single compact changed-files row. The implementation preserves those proportions and interaction priorities while adapting the content to Pi Agent and adding the requested review surface.

The first compact-window pass exposed a P2 issue: the 420px review overlay opened by default and obscured the conversation at 900px. The implementation now defaults the review panel to closed below 1120px, while retaining the explicit header toggle.

## Focused Region Comparison

- Sidebar: compact icon-and-label navigation, restrained selected state, recent-task hierarchy, and bottom runtime status match the source's density and quiet contrast.
- Conversation: user prompt remains visually secondary; assistant output is unframed and uses inline progress rows rather than nested cards.
- Change summary: file count, additions, deletions, and review affordance follow the source anatomy.
- Composer: stable bottom placement, compact model and permission controls, and one clear send/stop action preserve the source hierarchy.
- Review panel: intentionally extends the source with a functional file list and diff; it remains visually subordinate to the thread.

## Required Fidelity Surfaces

- Fonts and typography: system sans stack closely matches the source's UI typography. Weight, line height, truncation, and compact-label sizing are consistent. No actionable mismatch.
- Spacing and layout rhythm: 272px sidebar, centered 720px reading column, 62px header, and restrained 6-10px radii preserve source density. Compact default behavior was corrected. No actionable mismatch.
- Colors and visual tokens: warm gray navigation, white work surface, subtle borders, and semantic green/red diff colors match the neutral source without reproducing the promotional background. Contrast remains clear in the tested states.
- Image quality and asset fidelity: the product surface does not require raster imagery. All visible UI symbols use the Phosphor icon library; no placeholder art, handcrafted SVG, or CSS illustration is used.
- Copy and content: source product text is replaced intentionally with concise Simplified Chinese Pi Agent tasks, tool status, transport status, permissions, and review labels.

## Interaction Verification

- New task creates and selects an empty session.
- Suggested task populates the composer.
- Sending starts a run and creates a streaming assistant message.
- Permission request blocks the flow until allow or deny.
- Allow continues tool execution and produces change results.
- Review panel opens, closes, and changes the selected file.
- Model and permission selectors are operable.
- Browser console errors checked: none.
- Production build completed successfully.

## Comparison History

1. P2: compact window opened the review panel over the conversation. Fixed by deriving the initial review-panel state from the window width. Post-fix evidence: `prototype-compact-final.png`.
2. No remaining P0, P1, or P2 findings in the desktop, compact, approval, and completed states.

## Follow-up Polish

- P3: replace mock file-change content with live normalized Pi tool results after the real Agent Host is wired.
- P3: add native title-bar treatment per operating system when this prototype moves into Electron.

final result: passed
