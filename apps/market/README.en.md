# 0xNuller Market

[中文](README.md) | English

The community catalog for scenes and waveforms.

- Unified site: <https://0xnullai.com/market>
- Legacy standalone site: <https://market.0xnullai.com>

Browsing is public. Uploading requires an account; new content is automatically owned by that
account. Owners can edit or delete their entries, while administrator accounts can moderate legacy
or unclaimed content. There is no shared Market admin password or per-item edit password.

## Develop

```bash
npm install
npm run db:migrate:local -w 0xnullai-market
npm run dev -w 0xnullai-market
npm run test -w 0xnullai-market
npm run typecheck -w 0xnullai-market
npm run build -w 0xnullai-market
```

The API Worker uses an independent `MARKET_IP_PEPPER` for upload rate limiting. Do not store it in
the repository. The standalone Vite build is for local module development; the production UI is
served by the unified web shell.

## API

- `GET /api/items` — browse and search.
- `POST /api/items` and `/api/items/batch` — authenticated upload.
- `PATCH /api/items/:id` — owner/admin metadata update.
- `DELETE /api/items/:id` — owner/admin deletion.
- `POST /api/items/:id/report` — report content.
- `GET /api/items/admin` — administrator moderation queue.
- `PATCH /api/items/:id/moderation` — administrator hide/restore action.

Production migration and preview steps are documented in the [deployment guide](../../docs/deploy.md).

## License

[MIT](../../LICENSE)
