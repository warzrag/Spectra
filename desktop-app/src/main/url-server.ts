import * as http from 'http';
import * as crypto from 'crypto';
import { ipcMain } from 'electron';
import { normalizeTweetUrl } from '../shared/twitter-url';

export class UrlTrackingServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly sessionImportCredentials = new Map<
    string,
    { profileId: string; username: string; password: string; totpSecret: string; expiresAt: number }
  >();

  stageSessionImport(
    attemptId: string,
    profileId: string,
    credentials: { username: string; password: string; totpSecret: string }
  ): void {
    this.sessionImportCredentials.set(attemptId, {
      profileId,
      ...credentials,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
  }

  clearSessionImport(attemptId: string): void {
    this.sessionImportCredentials.delete(attemptId);
  }

  start(): Promise<{ port: number; token: string }> {
    if (this.server) return Promise.resolve({ port: this.port, token: this.token });

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

        // Le robot appelle ce serveur depuis une page x.com. Un navigateur
        // n'autorise cet appel que si le serveur le declare, et il envoie
        // d'abord une requete OPTIONS pour demander la permission -- sans
        // en-tete d'autorisation, puisqu'il ne connait pas encore la reponse.
        //
        // Sans ca, le message se perd : mesure du 12 aout 2026, un post partait
        // bien mais Spectra n'en etait jamais informe.
        //   POST http://127.0.0.1:15200/api/auto-post-event
        //   blocked by CORS policy: No 'Access-Control-Allow-Origin' header
        //
        // L'extension de synchronisation des cookies appelle elle aussi ce
        // serveur, depuis son service worker, donc avec une origine
        // chrome-extension://. Elle etait refusee, et la sauvegarde des
        // sessions ne partait plus : mesure du 12 aout 2026, toutes les
        // sauvegardes reussies dataient d'avant la mise en service de cette
        // verification. Le serveur repondait pourtant 200 a une requete sans
        // en-tete Origin -- c'est bien le navigateur qui bloquait.
        //
        // Une adresse locale ajoute une seconde barriere : le navigateur
        // demande la permission d'atteindre le reseau prive, par un en-tete
        // dedie dans la requete OPTIONS. Sans reponse a cette demande, l'appel
        // est bloque avant d'etre emis.
        //
        // Autoriser ces origines ne donne aucun acces : chaque point d'entree
        // reste protege par le jeton, verifie plus bas.
        const originesAutorisees = [
          'https://x.com', 'https://www.x.com',
          'https://twitter.com', 'https://www.twitter.com',
        ];
        const origine = String(req.headers.origin || '');
        const origineAutorisee =
          originesAutorisees.includes(origine) ||
          /^chrome-extension:\/\/[a-z]{32}$/.test(origine);
        if (origineAutorisee) {
          res.setHeader('Access-Control-Allow-Origin', origine);
          res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
          if (origineAutorisee) {
            const entetes: Record<string, string> = {
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
              'Access-Control-Max-Age': '600',
            };
            if (req.headers['access-control-request-private-network'] === 'true') {
              entetes['Access-Control-Allow-Private-Network'] = 'true';
            }
            res.writeHead(204, entetes);
          } else {
            res.writeHead(403);
          }
          res.end();
          return;
        }

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
          req.method === 'GET' &&
          requestUrl.pathname === '/api/session-import-credentials'
        ) {
          const attemptId = requestUrl.searchParams.get('attemptId') || '';
          const profileId = requestUrl.searchParams.get('profileId') || '';
          const staged = this.sessionImportCredentials.get(attemptId);
          if (!staged || staged.profileId !== profileId || staged.expiresAt < Date.now()) {
            this.sessionImportCredentials.delete(attemptId);
            res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Session import attempt not found' }));
            return;
          }
          // On ne consomme pas a la premiere lecture. Le service worker d'une
          // extension peut etre arrete par Chrome a tout moment ; en repartant
          // il redemande les identifiants, et une lecture unique lui repondait
          // alors « attempt not found ». La fenetre reste ouverte sur la page
          // de connexion sans que rien ne soit saisi.
          //
          // La protection tient toujours : le jeton est exige, l'identifiant de
          // tentative est un UUID, l'entree expire au bout de cinq minutes et
          // main.ts l'efface des que la tentative se termine.
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({
            username: staged.username,
            password: staged.password,
            totpSecret: staged.totpSecret,
          }));
          return;
        }

        if (
          req.method === 'POST' &&
          (
            req.url === '/api/save-url' ||
            req.url === '/api/save-cookies' ||
            req.url === '/api/launch-status' ||
            req.url === '/api/lifecycle-event' ||
            req.url === '/api/auto-post-event' ||
            req.url === '/api/close-profile' ||
            req.url === '/api/session-import-status' ||
            req.url === '/api/bot-template' ||
            req.url === '/api/bot-template-applied' ||
            req.url === '/api/branding-status' ||
            req.url === '/api/mass-post-status'
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

              // Les reglages du robot ne sont lisibles que depuis l'extension
              // du robot : c'est elle qui les publie ici, et Spectra les range.
              if (req.url === '/api/bot-template') {
                const { dossierId, profileId, reglages } = data;
                if (dossierId && profileId && reglages && typeof reglages === 'object') {
                  ipcMain.emit('internal:bot-template', null, dossierId, profileId, reglages);
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end();
                }
                return;
              }

              // Le branding et la publication rendent compte de la meme
              // maniere -- une action automatique sur un profil qui dit ou elle
              // en est -- et empruntent donc le meme canal vers l'interface.
              if (req.url === '/api/branding-status' || req.url === '/api/mass-post-status') {
                const { attemptId, profileId, status, message } = data;
                if (attemptId && profileId) {
                  ipcMain.emit('internal:branding-status', null, {
                    attemptId: String(attemptId),
                    profileId: String(profileId),
                    status: String(status || ''),
                    message: String(message || ''),
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end();
                }
                return;
              }

              if (req.url === '/api/bot-template-applied') {
                const { profileId, empreinte } = data;
                if (profileId) {
                  ipcMain.emit('internal:bot-template-applied', null, profileId, String(empreinte || ''));
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end();
                }
                return;
              }

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
                  let saveResult: {
                    success: boolean;
                    count?: number;
                    authenticated?: boolean;
                    error?: string;
                  } | null = null;
                  ipcMain.emit(
                    'internal:save-cookies',
                    null,
                    profileId,
                    cookies,
                    (result: typeof saveResult) => { saveResult = result; }
                  );
                  if (!saveResult?.success) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                      success: false,
                      error: saveResult?.error || 'Cookie snapshot was not acknowledged',
                    }));
                    return;
                  }
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(saveResult));
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
              } else if (req.url === '/api/lifecycle-event') {
                const { profileId, launchId, event, details } = data;
                if (
                  typeof profileId === 'string' &&
                  /^[A-Za-z0-9_-]{1,160}$/.test(profileId) &&
                  typeof event === 'string' &&
                  /^[A-Za-z0-9_-]{1,96}$/.test(event)
                ) {
                  ipcMain.emit('internal:lifecycle-event', null, {
                    profileId,
                    launchId: typeof launchId === 'string' ? launchId.slice(0, 96) : '',
                    event,
                    details: details && typeof details === 'object' ? details : {},
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Invalid lifecycle event' }));
                }
              } else if (req.url === '/api/auto-post-event') {
                const postUrl = normalizeTweetUrl(data?.postUrl);
                const sourceProfileId = String(data?.sourceProfileId || '');
                const account = String(data?.account || '').replace(/^@+/, '').slice(0, 64);
                if (
                  postUrl &&
                  /^[A-Za-z0-9_-]{1,160}$/.test(sourceProfileId) &&
                  (!account || /^[A-Za-z0-9_]{1,64}$/.test(account))
                ) {
                  ipcMain.emit('internal:auto-post-event', null, {
                    id: crypto
                      .createHash('sha256')
                      .update(`${postUrl}|${sourceProfileId}`)
                      .digest('hex')
                      .slice(0, 32),
                    postUrl,
                    sourceProfileId,
                    account,
                    receivedAt: Date.now(),
                  });
                  res.writeHead(202, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                  });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Invalid Auto Post event' }));
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
              } else if (req.url === '/api/session-import-status') {
                const { profileId, attemptId, status, message } = data;
                if (
                  typeof profileId === 'string' &&
                  /^[A-Za-z0-9_-]{1,160}$/.test(profileId) &&
                  typeof attemptId === 'string' &&
                  /^[A-Fa-f0-9-]{16,64}$/.test(attemptId) &&
                  typeof status === 'string'
                ) {
                  ipcMain.emit('internal:session-import-status', null, {
                    profileId,
                    attemptId,
                    status: status.slice(0, 64),
                    message: typeof message === 'string' ? message.slice(0, 240) : '',
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                } else {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Invalid session import status' }));
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
    this.sessionImportCredentials.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
