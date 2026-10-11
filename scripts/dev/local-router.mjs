// Local-only path router: one origin for the shell and every Worker, like production.
import http from 'node:http';
import net from 'node:net';
const targets = { auth: 8787, market: 8788, chat: 8789, web: 5173 };
const pick = (url) => {
  if (url.startsWith('/api/items')) return targets.market;
  if (/^\/(ws\/|api\/(lobby|upload|media|groups|dm)\/)/.test(url)) return targets.chat;
  if (url.startsWith('/api/')) return targets.auth;
  return targets.web;
};
const server = http.createServer((req, res) => {
  const port = pick(req.url);
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${port}` },
    },
    (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    res.writeHead(502);
    res.end(`upstream ${port}: ${e.message}`);
  });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const port = pick(req.url);
  const upstream = net.connect(port, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `localhost:${port}` };
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.listen(8790, '127.0.0.1', () => console.log('router ready on 8790'));
