<div align="center">

# DG-Wiki

**Unified documentation hub for the DG-Lab Coyote project family**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![Site](https://img.shields.io/badge/site-wiki.0xnullai.com-58c8f2)](https://wiki.0xnullai.com)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-58c8f2)](https://github.com/0xNullAI/DG-Kit)

[中文](wiki-README.md) | English

</div>

## What it is

DG-Wiki is the central docs site for the four sister projects: [DG-Kit](https://github.com/0xNullAI/DG-Kit), [DG-Agent](https://github.com/0xNullAI/DG-Agent), [DG-Chat](https://github.com/0xNullAI/DG-Chat), and [DG-MCP](https://github.com/0xNullAI/DG-MCP). Each page covers intro / installation / usage manual / FAQ / troubleshooting.

Includes **in-browser editing**: hit ✎ in the top bar to open a split-screen Markdown editor; local changes persist in `localStorage`, and a one-click "open on GitHub" link takes you to the PR flow to contribute back.

## Live

https://wiki.0xnullai.com

## Local development

```bash
npm install
npm run dev          # http://localhost:5173/
```

## Build

```bash
npm run build
npm run preview
```

`dist/` is the output. Cloudflare auto-builds and deploys on every push to `main` (wiki.0xnullai.com).

## Editing content

Pages live at `src/content/<id>.md`, imported via Vite `?raw`. Page metadata (label, accent color, GitHub edit URL) lives in `src/lib/pages.ts`.

To add a page:

1. Write `src/content/<id>.md`
2. Append a record to the `PAGES` array in `pages.ts`
3. Restart the dev server

## Visual identity

Same palette as DG-Agent / DG-Chat:

- Light: white + sky cyan `#58c8f2 / #3ab5e6`
- Dark: near-black + warm amber `#ffe99d / #ffb800`

Fonts: Big Shoulders Display (display) / PingFang SC + system Chinese stack (body) / JetBrains Mono (code).

## Sister projects

| Project                                          | Purpose                       |
| ------------------------------------------------ | ----------------------------- |
| [DG-Kit](https://github.com/0xNullAI/DG-Kit)     | Shared TypeScript runtime     |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller         |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat)   | Multi-user P2P room           |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP)     | MCP server for Claude Desktop |

## License

[MIT](../../LICENSE)
