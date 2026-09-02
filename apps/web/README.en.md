# 0xNuller Web

[中文](README.md) | English

The unified SPA for Control, Chat, Agent, Voice, Video, Market, and Playground. Modules share
navigation, account state, the device bar, settings, themes, and overlays.

## Routes

| Path          | Module                         |
| ------------- | ------------------------------ |
| `/control`    | manual control                 |
| `/chat`       | rooms and direct messages      |
| `/agent`      | text Agent                     |
| `/voice`      | realtime voice                 |
| `/video`      | visual control                 |
| `/market`     | community scenes and waveforms |
| `/playground` | games                          |

The product runs on <https://0xnullai.com>. Legacy subdomains permanently redirect to their matching
modules on the unified site.

## Develop

```bash
npm install
npm run build:kit
npm run dev -w @0xnullai/web
npm run test -w @0xnullai/web
npm run typecheck -w @0xnullai/web
npm run build -w @0xnullai/web
```

## Built-in documentation

DG-Wiki user documentation now lives in the unified app:

```text
apps/web/src/docs/*.md       content
apps/web/src/docs/index.ts   catalog
apps/web/src/DocsDialog.tsx  reader
```

The legacy documentation address at <https://wiki.0xnullai.com> permanently redirects to the
documentation module on the unified site.

## Deploy

Production assets are hosted with Cloudflare Workers Static Assets. More specific Worker routes
handle backend APIs. See the [deployment guide](../../docs/deploy.md) for migration, preview,
cutover, and rollback steps.

## License

[MIT](../../LICENSE)
