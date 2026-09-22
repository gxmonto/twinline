'use strict';
/**
 * Serve a dist/<version>/ folder over plain HTTP so an installed TwinLine can
 * be pointed at it (Settings → General → Update server) to rehearse an update
 * before publishing for real.
 *
 *   node tools/serve-updates.js dist/1.0.5 [port]
 *
 * Then, in the older installed copy, set the update server to
 * http://<this machine>:<port>/ and press "Check for updates now".
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
const port = parseInt(process.argv[3], 10) || 8123;

const TYPES = { '.yml': 'text/yaml', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream', '.AppImage': 'application/octet-stream', '.deb': 'application/octet-stream', '.rpm': 'application/octet-stream' };

http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(dir, name);
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes' };

  // electron-updater fetches blockmap deltas with Range requests.
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? parseInt(range[2], 10) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    fs.createReadStream(file).pipe(res);
  }
  console.log(`${req.method} ${req.url} ${range ? '(range)' : ''}`);
}).listen(port, () => console.log(`serving ${dir} at http://127.0.0.1:${port}/`));
