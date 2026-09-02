const TARGETS: Record<string, string> = {
  'agent.0xnullai.com': '/agent',
  'chat.0xnullai.com': '/chat',
  'voice.0xnullai.com': '/voice',
  'market.0xnullai.com': '/market',
  'wiki.0xnullai.com': '/wiki',
};

function isNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return false;
  const mode = request.headers.get('Sec-Fetch-Mode');
  const destination = request.headers.get('Sec-Fetch-Dest');
  const accept = request.headers.get('Accept') ?? '';
  return mode === 'navigate' || destination === 'document' || accept.includes('text/html');
}

function redirectToMain(url: URL, targetPath: string): Response {
  const target = new URL(targetPath, 'https://0xnullai.com');
  target.search = url.search;
  return new Response(null, {
    status: 308,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'public, max-age=3600',
      Vary: 'Accept, Sec-Fetch-Mode, Sec-Fetch-Dest',
    },
  });
}

function retired(request: Request): Response {
  const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  return new Response(
    JSON.stringify({
      error: 'legacy endpoint retired',
      canonical: 'https://0xnullai.com',
    }),
    {
      status: websocket ? 426 : 410,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const targetPath = TARGETS[url.hostname];
    if (!targetPath) return new Response('Not found', { status: 404 });
    if (isNavigation(request)) return redirectToMain(url, targetPath);
    return retired(request);
  },
} satisfies ExportedHandler;
