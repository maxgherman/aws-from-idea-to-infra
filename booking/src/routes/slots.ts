import type { IncomingMessage, ServerResponse } from 'node:http';

export function slots(_req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify([]);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
