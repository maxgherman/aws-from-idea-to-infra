import { createServer } from 'node:http';
import { health } from './routes/health';
import { slots } from './routes/slots';

const PORT = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/health') {
    return health(req, res);
  }

  if (method === 'GET' && url === '/slots') {
    return slots(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`booking service listening on port ${PORT}`);
});
