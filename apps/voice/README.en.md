# 0xNuller Voice

[中文](README.md) | English

Realtime voice AI with locally enforced device permissions and safety policy.

- Unified site: <https://0xnullai.com/voice>
- Legacy standalone site: <https://voice.0xnullai.com>

## Providers

- xAI Realtime
- OpenAI Realtime and compatible services
- Azure OpenAI Realtime
- Zhipu GLM Realtime
- Metered trial sessions through the `0xnullai-voice` Worker

Bring-your-own-key sessions connect to the selected provider. Trial mode creates a short-lived
session through `/api/realtime`. Text and voice models are configured independently.

## Features

- Full-duplex voice and transcript history.
- Shared scenes with Agent and shared device, waveform, and safety state across modules.
- Coyote and Opossum control, permission review, serialized commands, and global stop.
- Shared web and Android business logic.

## Develop

```bash
npm install
npm run dev -w 0xnullai-voice
npm run test -w 0xnullai-voice
npm run typecheck -w 0xnullai-voice
npm run build -w 0xnullai-voice
npm run cf:dev -w 0xnullai-voice
```

Trial Worker configuration is covered by [worker/README.md](worker/README.md). Before release, run
end-to-end browser and Android checks with a real provider, including a tool call and hang-up stop.

## AI device target boundaries

- Realtime sessions expose only devices that are connected and usable now. Voice updates the
  instructions and tool list together when devices connect, disconnect, or change topology;
  disconnected, faulted, and merely configured devices do not remain in model context.
- Coyote uses the same `MultiCoyoteDeviceClient` and exact-target router as Agent, so multiple
  same-kind or same-name devices can remain connected. Every connection owns an opaque `targetId`,
  protocol client, command queue, and stop path. Model tools must copy one current `targetId`
  exactly; they never select by name, merge devices, broadcast, or fan out. Web and Android use the
  same composition.
- Opossum's transport remains a single-client boundary, so Voice currently connects one Opossum at
  a time. Reconnects receive a new local opaque identity and stale identity cannot migrate to new
  hardware.
- The generic runtime supports multiple devices and vibration features. The model receives a
  separate opaque `deviceId` and `featureId` for every target and every call selects exactly one ID
  pair. Names are omitted from model state, and calls never broadcast or fan out.
- Immediately before local dispatch, output-increasing calls revalidate connection identity,
  permission, and the Voice module lease. Identity or lease changes fail closed, while stop and
  global emergency stop remain reachable outside ordinary output permission and lease gates.

## Deploy

The new Worker owns only the unified site's `/api/realtime` route. The legacy Worker and subdomain
remain online. See the [deployment guide](../../docs/deploy.md).

## License

[MIT](../../LICENSE)
