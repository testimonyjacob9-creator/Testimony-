'use strict';
const http = require('node:http');

/**
 * Minimal HTTP listener for hosts that require a web port (Render Web Service) and for uptime monitors.
 * It serves exactly one route, GET/HEAD /health, whose body is a constant: no phone numbers, no WhatsApp state,
 * no business data, no configuration. Everything else is 404/405. It reads no request bodies.
 * A 200 only means "the Node process is running and answering"; it does NOT mean WhatsApp is connected.
 */
function createHealthServer({ port, host = '0.0.0.0' }) {
  const body = '{"status":"ok"}';
  const server = http.createServer((req, res) => {
    const pathOnly = String(req.url || '').split('?')[0];
    if (pathOnly !== '/health') { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
  return {
    server,
    start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); }); }),
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

module.exports = { createHealthServer };
