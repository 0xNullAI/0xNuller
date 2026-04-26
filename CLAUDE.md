# CLAUDE.md

Guidance for Claude Code working in **DG-Wiki** — the user-facing documentation hub for the DG family.

## Project Overview

DG-Wiki is a single-page React + Vite + Tailwind v4 SPA hosted on GitHub Pages. It renders Markdown content for the four sister projects (DG-Kit / DG-Agent / DG-Chat / DG-MCP) with an in-browser editor that persists local edits to `localStorage` and offers a one-click "open PR on GitHub" link to contribute back.

The visual identity matches DG-Agent and DG-Chat: white + sky-cyan in light mode, near-black + warm amber in dark mode. Big Shoulders Display for headings, system Chinese-friendly stack for body, JetBrains Mono for code.

## Repo Layout

```
src/
  App.tsx                 main shell: Sidebar + Header + content/edit panel
  main.tsx                React entry
  components/
    Sidebar.tsx           project nav, modified-state indicators
    Header.tsx            page meta, edit toggle, theme toggle, GitHub link
    MarkdownView.tsx      react-markdown + remark-gfm
    EditPanel.tsx         split-screen Markdown editor with live preview
    Waveform.tsx          decorative animated SVG path
  content/                Markdown sources (one per page)
    home.md
    kit.md
    agent.md
    chat.md
    mcp.md
    about.md
  hooks/
    use-theme.ts          dark/light persisted to localStorage
    use-page-content.ts   per-page content with localStorage override
  lib/
    pages.ts              PAGES array (id, label, accent, default md, source path)
  styles/
    index.css             tokens (DG family palette) + markdown styling
public/
  favicon.svg
.github/workflows/
  deploy.yml              GitHub Pages build + deploy on push to main
```

## Branch & PR Convention

- Default branch: `main`
- Small project, all changes go directly on `main`
- Push to `main` → GitHub Pages workflow auto-deploys to `https://0xnullai.github.io/DG-Wiki/`

## Commands

```bash
npm install
npm run dev          # http://localhost:5173/DG-Wiki/
npm run build        # tsc -b + Vite build
npm run preview      # preview the production build
npm run lint
```

## Test & Commit Workflow

Before commits:

1. `npm run lint` — must pass
2. `npm run build` — Vite must succeed (TypeScript strict mode is on)

Conventional commit style (`type(scope): subject`). Most edits are `docs(content): update X.md`.

## Editing Content

- The Markdown sources live in `src/content/<id>.md` and are imported via `?raw` (Vite raw imports)
- Each page's metadata (label, accent color, GitHub edit link) lives in `src/lib/pages.ts`
- To add a new page: create `src/content/<id>.md`, append to `PAGES` in `pages.ts`
- To rename: keep the file name the same as the `id` so `localStorage` keys keep mapping to the same content

## Visual Identity

- **Light theme**: `--accent: #58c8f2` (sky cyan); `--accent-strong: #3ab5e6`
- **Dark theme**: `--accent: #ffe99d` (warm pale amber); `--accent-strong: #ffb800`
- All other tokens (bg, surface-border, text, etc.) match DG-Agent's tokens.css exactly
- Decorative grid is 88px squares at very low opacity (`--grid` token)
- Reusable component classes: `.dg-card`, `.dg-pill`, `.dg-button`

## Sister Projects

| Project | Purpose |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | Shared TypeScript runtime |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP server for Claude Desktop |

When updating wiki pages, also keep the four sister-project READMEs (in their own repos) in sync with significant feature changes.

## Code Conventions

- TypeScript with `strict: true`
- React 19 (function components, hooks)
- Tailwind v4 via `@tailwindcss/vite` plugin (no separate `tailwind.config`)
- CSS variables for all theming, `.dg-*` utility classes for surfaces
- UI strings in **Chinese (Simplified)**
- No emojis in content unless they're decorative single-char glyphs (▸, ◉, §)
