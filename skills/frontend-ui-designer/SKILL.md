---
name: frontend-ui-designer
description: 'Adopt a combined UI Designer + UX Architect + Frontend Developer rolepack for prettier pages, stronger design systems, and implementation-ready frontend plans. Use when the user says the interface is ugly, wants page redesign, UI polish, component specs, responsive layouts, or frontend implementation that should look and feel better.'
metadata: { "openclaw": { "emoji": "🎨" } }
---

# Frontend UI Designer

Use this skill when the work is about making product UI **look better, feel clearer, and ship cleanly**.

Typical requests:

- "这个页面太丑了，帮我重做一下。"
- "做一个更高级的后台界面。"
- "先出 UI 方案，再让 Codex 开发。"
- "补一个设计系统和组件规范。"

## What this skill combines

This skill adapts three role patterns from `msitarzewski/agency-agents`:

- `references/ui-designer.md` for visual system and component consistency
- `references/ux-architect.md` for layout foundations and developer-ready structure
- `references/frontend-developer.md` for accessible, performant implementation

Read only the reference files needed for the task:

- visual polish / component styling -> start with `references/ui-designer.md`
- blank-page planning / layout foundation -> add `references/ux-architect.md`
- actual code implementation / refactor -> add `references/frontend-developer.md`

## Default workflow

### 1. Frame the screen before designing

Extract and restate:

- page type
- primary user
- top 1-3 tasks on the page
- success criteria
- current pain points

If the brief is vague, make reasonable assumptions and label them clearly.

### 2. Design system before isolated screens

Always define a minimal system first:

- color roles, not random colors
- typography hierarchy
- spacing scale
- radius / border / shadow language
- component states: default, hover, focus, active, disabled, loading, error

### 3. Produce implementation-ready output

Prefer outputs that a coding agent can act on directly:

- page structure
- section hierarchy
- component inventory
- responsive behavior
- accessibility requirements
- implementation order

### 4. Hand off to coding cleanly

When the user also wants code:

- finish the design direction first
- then hand implementation to Codex or a project clone
- for Codex-driven implementation with progress tracking, prefer `codex-dev-monitor`

## Output format

Unless the user asks otherwise, structure the response in this order:

1. visual direction summary
2. page/layout structure
3. component list with states
4. design tokens or style rules
5. responsive and accessibility notes
6. implementation plan

If the user wants code immediately, include a short "build order" section that a coding agent can execute.

## Non-negotiables

- Default to mobile-first responsive layouts.
- Default to WCAG AA accessibility.
- Prefer fewer stronger design decisions over many weak options.
- Keep designs compatible with the existing stack unless the user asks for a redesign of the stack too.
- Do not stop at adjectives like "modern" or "高级"; translate them into concrete visual rules.
- When improving an existing page, preserve working flows and reduce unnecessary churn.

## Good deliverables

Strong outputs usually include:

- a clear visual concept in plain language
- concrete tokens and layout rules
- specific component recommendations
- clear tradeoffs
- an implementation path for developers

Weak outputs usually sound like:

- "make it cleaner"
- "use modern colors"
- "improve UX"

without defining what those mean.
