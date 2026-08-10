# 0xNuller Playground

[中文](README.md) | English

Games that map registered game events to device feedback under the shared safety policy. Version
6.0.0 includes Snake and also works without a connected device.

## Develop

```bash
npm install
npm run dev -w @0xnullai/web
npm test
npm run typecheck
npm run build -w @0xnullai/web
```

## Layout

```text
src/App.tsx                 game list and entry
src/games.ts                game registry
src/games/snake/            Snake implementation and tests
src/use-game-device.ts      registered game actions to device capability
```

The bridge accepts registered actions only; it does not execute arbitrary scripts or arbitrary
device commands from a game.

## Legacy DG-Playground

The legacy repository experimented with generated games, scanning, moderation, and a public
catalog. That server-side pipeline is not part of the 6.0.0 production surface. The legacy
repository and deployment remain available during the compatibility period.

## License

[MIT](../../LICENSE)
