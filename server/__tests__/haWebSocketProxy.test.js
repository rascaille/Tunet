import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { attachServiceAccountWebSocketProxy } from '../haWebSocketProxy.js';
import { resetServiceAccountConfigForTests } from '../serviceAccount.js';

const ENV_KEYS = [
  'TUNET_SERVICE_ACCOUNT_MODE',
  'TUNET_INTERNAL_HA_URL',
  'TUNET_HA_TOKEN_FILE',
  'TUNET_REQUIRE_PROXY_USER',
];

const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

const listenHttpServer = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });
  });

const waitForWebSocketServer = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      resolve(address.port);
    });
  });

const waitForOpen = (socket) =>
  new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

const waitForJsonMessage = (socket) =>
  new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });

const closeWebSocket = (socket) =>
  new Promise((resolve) => {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      try {
        socket.terminate();
      } catch {}
      resolve();
    }, 1_000);

    timeout.unref();

    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      socket.close();
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });

const closeHttpServer = (server) =>
  new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });

const closeWebSocketServer = (server) =>
  new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    for (const client of server.clients) {
      try {
        client.terminate();
      } catch {}
    }

    server.close(() => resolve());
  });

const configureServiceAccount = ({ haUrl, tokenFile, requireProxyUser = true }) => {
  process.env.TUNET_SERVICE_ACCOUNT_MODE = '1';
  process.env.TUNET_INTERNAL_HA_URL = haUrl;
  process.env.TUNET_HA_TOKEN_FILE = tokenFile;
  process.env.TUNET_REQUIRE_PROXY_USER = requireProxyUser ? '1' : '0';
  resetServiceAccountConfigForTests();
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnvironment[key];

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }

  resetServiceAccountConfigForTests();
});

describe('service-account Home Assistant WebSocket proxy', () => {
  it('replaces the browser token with the server-side token and relays messages', async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'tunet-ws-proxy-'));
    const tokenFile = join(tempDirectory, 'ha-token');
    writeFileSync(tokenFile, 'server-side-secret-token\n', { mode: 0o600 });

    let clientSocket;
    let proxyHttpServer;
    let upstreamWebSocketServer;
    let receivedUpstreamToken = null;

    try {
      upstreamWebSocketServer = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: '/api/websocket',
        perMessageDeflate: false,
      });

      const upstreamPort = await waitForWebSocketServer(upstreamWebSocketServer);

      upstreamWebSocketServer.on('connection', (socket) => {
        socket.send(
          JSON.stringify({
            type: 'auth_required',
            ha_version: '2026.7.1',
          })
        );

        socket.on('message', (data) => {
          const message = JSON.parse(data.toString('utf8'));

          if (message.type === 'auth') {
            receivedUpstreamToken = message.access_token;

            socket.send(
              JSON.stringify({
                type: 'auth_ok',
                ha_version: '2026.7.1',
              })
            );

            return;
          }

          socket.send(
            JSON.stringify({
              id: message.id,
              type: 'result',
              success: true,
              result: {
                relayedType: message.type,
              },
            })
          );
        });
      });

      configureServiceAccount({
        haUrl: `http://127.0.0.1:${upstreamPort}`,
        tokenFile,
      });

      proxyHttpServer = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
      });

      attachServiceAccountWebSocketProxy({
        server: proxyHttpServer,
      });

      const proxyPort = await listenHttpServer(proxyHttpServer);

      clientSocket = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/api/websocket`,
        {
          headers: {
            'Remote-User': 'pascal',
          },
          perMessageDeflate: false,
        }
      );

      const authRequiredPromise = waitForJsonMessage(clientSocket);
      await waitForOpen(clientSocket);

      await expect(authRequiredPromise).resolves.toMatchObject({
        type: 'auth_required',
      });

      const authOkPromise = waitForJsonMessage(clientSocket);

      clientSocket.send(
        JSON.stringify({
          type: 'auth',
          access_token: 'browser-placeholder-token',
        })
      );

      await expect(authOkPromise).resolves.toMatchObject({
        type: 'auth_ok',
      });

      expect(receivedUpstreamToken).toBe('server-side-secret-token');
      expect(receivedUpstreamToken).not.toBe('browser-placeholder-token');

      const resultPromise = waitForJsonMessage(clientSocket);

      clientSocket.send(
        JSON.stringify({
          id: 1,
          type: 'get_states',
        })
      );

      await expect(resultPromise).resolves.toEqual({
        id: 1,
        type: 'result',
        success: true,
        result: {
          relayedType: 'get_states',
        },
      });
    } finally {
      await closeWebSocket(clientSocket);
      await closeHttpServer(proxyHttpServer);
      await closeWebSocketServer(upstreamWebSocketServer);
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('rejects direct clients that do not carry an authenticated proxy user', async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'tunet-ws-proxy-'));
    const tokenFile = join(tempDirectory, 'ha-token');
    writeFileSync(tokenFile, 'server-side-secret-token\n', { mode: 0o600 });

    let clientSocket;
    let proxyHttpServer;

    try {
      configureServiceAccount({
        haUrl: 'http://127.0.0.1:65534',
        tokenFile,
      });

      proxyHttpServer = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
      });

      attachServiceAccountWebSocketProxy({
        server: proxyHttpServer,
      });

      const proxyPort = await listenHttpServer(proxyHttpServer);

      clientSocket = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/api/websocket`
      );

      const outcome = await new Promise((resolve) => {
        let opened = false;

        const timeout = setTimeout(() => {
          resolve('timeout');
        }, 2_000);

        clientSocket.once('open', () => {
          opened = true;
          clearTimeout(timeout);
          resolve('opened');
        });

        clientSocket.once('error', () => {
          clearTimeout(timeout);
          resolve('rejected');
        });

        clientSocket.once('close', () => {
          if (!opened) {
            clearTimeout(timeout);
            resolve('rejected');
          }
        });
      });

      expect(outcome).toBe('rejected');
    } finally {
      await closeWebSocket(clientSocket);
      await closeHttpServer(proxyHttpServer);
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

const waitForMessageType = (socket, expectedType) =>
  new Promise((resolve, reject) => {
    const handleMessage = (data) => {
      try {
        const message = JSON.parse(data.toString('utf8'));

        if (message.type !== expectedType) {
          return;
        }

        socket.off('message', handleMessage);
        socket.off('error', handleError);
        resolve(message);
      } catch (error) {
        socket.off('message', handleMessage);
        socket.off('error', handleError);
        reject(error);
      }
    };

    const handleError = (error) => {
      socket.off('message', handleMessage);
      reject(error);
    };

    socket.on('message', handleMessage);
    socket.once('error', handleError);
  });

describe('early WebSocket authentication', () => {
  it('buffers authentication sent before the Home Assistant socket opens', async () => {
    const tempDirectory = mkdtempSync(
      join(tmpdir(), 'tunet-ws-early-auth-')
    );
    const tokenFile = join(tempDirectory, 'ha-token');

    writeFileSync(
      tokenFile,
      'server-side-secret-token\n',
      { mode: 0o600 }
    );

    let clientSocket;
    let proxyHttpServer;
    let upstreamWebSocketServer;
    let receivedUpstreamToken = null;
    let upstreamConnectedAt = 0;
    let clientAuthSentAt = 0;

    try {
      upstreamWebSocketServer = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: '/api/websocket',
        perMessageDeflate: false,

        // Retarde volontairement l'ouverture de la connexion HA.
        verifyClient: (_info, callback) => {
          setTimeout(() => callback(true), 250);
        },
      });

      const upstreamPort = await waitForWebSocketServer(
        upstreamWebSocketServer
      );

      upstreamWebSocketServer.on('connection', (socket) => {
        upstreamConnectedAt = Date.now();

        socket.send(
          JSON.stringify({
            type: 'auth_required',
            ha_version: '2026.7.1',
          })
        );

        socket.on('message', (data) => {
          const message = JSON.parse(data.toString('utf8'));

          if (message.type !== 'auth') {
            return;
          }

          receivedUpstreamToken = message.access_token;

          socket.send(
            JSON.stringify({
              type: 'auth_ok',
              ha_version: '2026.7.1',
            })
          );
        });
      });

      configureServiceAccount({
        haUrl: `http://127.0.0.1:${upstreamPort}`,
        tokenFile,
      });

      proxyHttpServer = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
      });

      attachServiceAccountWebSocketProxy({
        server: proxyHttpServer,
      });

      const proxyPort = await listenHttpServer(proxyHttpServer);

      clientSocket = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/api/websocket`,
        {
          headers: {
            'Remote-User': 'early-auth-user',
          },
          perMessageDeflate: false,
        }
      );

      await waitForOpen(clientSocket);

      const authOkPromise = waitForMessageType(
        clientSocket,
        'auth_ok'
      );

      clientAuthSentAt = Date.now();

      // Comportement réel de home-assistant-js-websocket :
      // authentification envoyée immédiatement après l'ouverture.
      clientSocket.send(
        JSON.stringify({
          type: 'auth',
          access_token: 'browser-placeholder-token',
        })
      );

      await expect(authOkPromise).resolves.toMatchObject({
        type: 'auth_ok',
      });

      expect(upstreamConnectedAt).toBeGreaterThan(
        clientAuthSentAt
      );
      expect(receivedUpstreamToken).toBe(
        'server-side-secret-token'
      );
      expect(receivedUpstreamToken).not.toBe(
        'browser-placeholder-token'
      );
    } finally {
      await closeWebSocket(clientSocket);
      await closeHttpServer(proxyHttpServer);
      await closeWebSocketServer(upstreamWebSocketServer);

      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
