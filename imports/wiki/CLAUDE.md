# CLAUDE.md

Guidance for Claude Code working in **DG-Wiki** — the user-facing documentation hub for the DG family.

## Project Overview

DG-Wiki is a single-page React + Vite + Tailwind v4 SPA hosted on Cloudflare Pages (wiki.0xnullai.com). It renders Markdown content for the four sister projects (DG-Kit / DG-Agent / DG-Chat / DG-MCP) with an in-browser editor that persists local edits to `localStorage` and offers a one-click "open PR on GitHub" link to contribute back.

The visual identity matches DG-Agent and DG-Chat: white + sky-cyan in light mode, near-black + warm amber in dark mode. Big Shoulders Display for headings, system Chinese-friendly stack for body, JetBrains Mono for code.

## Repo Layout

```
src/
  App.tsx                 main shell: Header + DocTabs + content/edit panel
  main.tsx                React entry
  components/
    Header.tsx            wordmark + project picker dropdown + actions
    ProjectPicker.tsx     dropdown that switches between the 4 projects
    DocTabs.tsx           secondary tabs (manual / developer / faq)
    MarkdownView.tsx      react-markdown + remark-gfm
    EditPanel.tsx         split-screen Markdown editor with live preview
    PublishDialog.tsx     GitHub PAT-backed PR submission flow
    TableOfContents.tsx   auto-generated TOC from h2/h3 of current md
    Waveform.tsx          decorative animated SVG path
  content/                Markdown sources organised by project / doc type
    kit/{overview,developer,api}.md
    agent/{manual,developer,faq}.md
    chat/{manual,developer,faq}.md
    mcp/{manual,developer,faq}.md
  hooks/
    use-theme.ts          dark/light persisted to localStorage
    use-page-content.ts   per-page content with localStorage override
  lib/
    projects.ts           Project + Document data model
    github.ts             GitHub REST helpers for PR submission
  styles/
    index.css             tokens (DG family palette) + markdown styling
.github/workflows/
  ci.yml                  lint + build on PR + push
  (deploy.yml removed)    deploys now run on Cloudflare, which builds from GitHub automatically on push to main
```

## Branch & PR Convention

DG-Wiki uses a **single-branch model** (different from the other 4 DG repos):

- Default branch: `main`
- All PRs base to `main`
- Push to `main` → Cloudflare auto-deploy (wiki.0xnullai.com)

There is no `dev` branch, no release-guard, no version-bump discipline. Pure docs site, low blast radius — keep it simple.

## Commands

```bash
npm install
npm run dev          # http://localhost:5173/
npm run build        # tsc -b + Vite build
npm run preview      # preview the production build
npm run lint
```

## Test & Commit Workflow

Before commits:

1. `npm run lint` — must pass
2. `npm run build` — Vite must succeed (TypeScript strict)

No vitest suite — content-heavy pages don't benefit from unit tests. Bigger refactors still get visual verification via `npm run dev`.

Conventional commit style (`type(scope): subject`). Most edits are `docs(content): update X.md` or `fix(ui): ...`.

## Editing Content

- The Markdown sources live in `src/content/<project>/<doc>.md` and are imported via `?raw`
- Each project's metadata + document list lives in `src/lib/projects.ts`
- To add a new doc to an existing project: write `src/content/<project>/<id>.md`, append to that project's `documents` in `projects.ts`
- To rename: keep the file's `id` stable so `localStorage` keys keep mapping to the same content

## Visual Identity

- **Light theme**: `--accent: #58c8f2` (sky cyan); `--accent-strong: #3ab5e6`
- **Dark theme**: `--accent: #ffe99d` (warm pale amber); `--accent-strong: #ffb800`
- All other tokens (bg, surface-border, text, etc.) match DG-Agent's tokens.css exactly
- Decorative grid is 88px squares at very low opacity (`--grid` token)
- Reusable component classes: `.dg-card`, `.dg-pill`, `.dg-button`

## Sister Projects

| Project | Branch model | Purpose |
|---|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | dev → main | Shared TypeScript runtime |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | dev → main + dev mirror | Browser AI controller |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | dev → main | Multi-user P2P room |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | dev → main | MCP server for Claude Desktop |
| **DG-Wiki** | **single main** | Documentation hub (this repo) |

When updating wiki pages, also keep the four sister-project READMEs (in their own repos) in sync with significant feature changes.

## Code Conventions

- TypeScript with `strict: true`
- React 19 (function components, hooks)
- Tailwind v4 via `@tailwindcss/vite` plugin (no separate `tailwind.config`)
- CSS variables for all theming, `.dg-*` utility classes for surfaces
- UI strings in **Chinese (Simplified)**
- No emojis in content unless they're decorative single-char glyphs (▸, ◉, §)
