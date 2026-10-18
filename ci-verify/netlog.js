// Host-side network for the emulator (10.0.2.2 = this runner's loopback).
//  - :8000  logging reverse proxy to the real lomod on :8001 (every request -> requests.jsonl)
//  - :8, :80, :800 (optional, HANG=1): accept TCP and never answer, like the partial addresses
//    "10.0.0.219:8", ":80", ":800" did on the audit's LAN (they hung until the client gave up).
const http = require('http');
const net = require('net');
const fs = require('fs');
const OUT = process.env.OUT_DIR || '/tmp/netlog';
fs.mkdirSync(OUT, { recursive: true });
const log = (file, obj) => fs.appendFileSync(`${OUT}/${file}`, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');

http.createServer((req, res) => {
  const started = Date.now();
  const up = http.request({ host: '127.0.0.1', port: 8001, method: req.method, path: req.url, headers: req.headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
    ur.on('end', () => log('requests.jsonl', { port: 8000, method: req.method, url: req.url.split('?')[0], status: ur.statusCode, ms: Date.now() - started }));
  });
  up.on('error', (e) => { log('requests.jsonl', { port: 8000, method: req.method, url: req.url, error: e.message }); res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(8000, '0.0.0.0', () => console.log('proxy :8000 -> :8001'));

if (process.env.HANG === '1') {
  for (const port of [8, 80, 800]) {
    net.createServer((sock) => {
      let first = '';
      sock.once('data', (d) => { first = d.toString().split('\r\n')[0]; log('hang.jsonl', { port, event: 'request', line: first }); });
      log('hang.jsonl', { port, event: 'connect' });
      sock.on('close', () => log('hang.jsonl', { port, event: 'closed-by-client' }));
      sock.on('error', () => {});
    }).listen(port, '0.0.0.0', () => console.log(`hang listener :${port}`));
  }
}
