import * as http from 'http';
import * as crypto from 'crypto';
import { ipcMain } from 'electron';

export class UrlTrackingServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly token = crypto.randomBytes(32).toString('hex');

  start(): Promise<{ port: number; token: string }> {
    if (this.server) return Promise.resolve({ port: this.port, token: this.token });

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (
          req.method === 'GET' &&
          requestUrl.pathname === '/api/close-profile' &&
          requestUrl.searchParams.get('token') === this.token
        ) {
          const profileId = requestUrl.searchParams.get('profileId');
          if (profileId && /^[A-Za-z0-9_-]{1,160}$/.test(profileId)) {
            console.log(`[Spectra OpenPost] Navigation fallback received for ${profileId}`);
            ipcMain.emit('internal:close-profile', null, profileId);
            res.writeHead(202, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end('<!doctype html><title>Spectra</title><p>Closing instance…</p>');
          } else {
            res.writeHead(400);
            res.end('Invalid profile ID');
          }
          return;
        }

        if (req.headers.authorization !== `Bearer ${this.token}`) {
          res.writeHead(401);
          res.end();
          return;
        }

        if (
          req.method === 'POST' &&
          (
            req.url === '/api/save-url' ||
            req.url === '/api/save-cookies' ||
            req.url === '/api/launch-status' ||
            req.url === '/api/close-profile'
          )
        ) {
          let body = '';
          let bodyBytes = 0;

          req.on('data', chunk => {
            bodyBytes += chunk.length;
            if (bodyBytes > 20 * 1024 * 1024) {
              res.writeHead(413);
              res.end();
              req.destroy();
              return;
            }
            body += chunk.toString();
          });

          req.on('end', () => {
            if (res.writableEnded) return;
            try {
              const data = JSON.parse(body);

              if (req.url === '/api/save-url') {
                const { profileId, url } = data;
                if (profileId && url) {
                  ipcMain.emit('internal:save-url', null, profileId, url);
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Missing profileId or url' }));
                }
              } else if (req.url === '/api/save-cookies') {
                const { profileId, cookies } = data;
                if (profileId && Array.isArray(cookies)) {
                  ipcMain.emit('internal:save-cookies', null, profileId, cookies);
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true, count: cookies.length }));
                } else {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Missing profileId or cookies' }));
                }
              } else if (req.url === '/api/launch-status') {
                const { profileId, launchId, status, details } = data;
                if (profileId && launchId && status) {
                  ipcMain.emit('internal:launch-status', null, {
                    profileId,
                    launchId,
                    status,
                    details: details || {},
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Missing launch status fields' }));
                }
              } else if (req.url === '/api/close-profile') {
                const { profileId } = data;
                if (typeof profileId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(profileId)) {
                  console.log(`[Spectra OpenPost] Close request received for ${profileId}`);
                  ipcMain.emit('internal:close-profile', null, profileId);
                  res.writeHead(202, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Invalid profile ID' }));
                }
              }
            } catch {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        console.error('URL tracking server failed:', error);
        this.server = null;
        reject(error);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server?.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        console.log(`URL tracking server listening on port ${this.port}`);
        resolve({ port: this.port, token: this.token });
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
