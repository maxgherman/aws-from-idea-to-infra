import type { IncomingMessage, ServerResponse } from 'node:http';

export function health(_req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify({ status: 'ok' });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
