import * as http from 'http';
import { ipcMain } from 'electron';

export class UrlTrackingServer {
  private server: http.Server | null = null;
  private port = 45678;

  start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/api/save-url') {
        let body = '';
        
        req.on('data', chunk => {
          body += chunk.toString();
        });
        
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const { profileId, url } = data;
            
            if (profileId && url) {
              // Emit event to main process to save URL
              ipcMain.emit('internal:save-url', null, profileId, url);
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing profileId or url' }));
            }
          } catch (error) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(this.port, () => {
      console.log(`URL tracking server listening on port ${this.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}