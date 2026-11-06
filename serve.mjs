// Runs the rule check, then serves the viewer at http://localhost:8080
// Usage: node serve.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { runCheck } from './check.mjs';

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript' };

http
  .createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/recheck') {
      const out = runCheck();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out.summary));
    }
    const file = path.join(process.cwd(), path.normalize(p).replace(/^([.][.][/\\])+/, ''));
    if (!file.startsWith(process.cwd()) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(8080, () => {
    const out = runCheck();
    console.log(`Check done: ${JSON.stringify(out.summary)}`);
    console.log('Open http://localhost:8080');
  });
