// @vitest-environment node

import express from 'express';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHomeAssistantMediaProxy } from '../haMediaProxy.js';

const openServers = [];

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      openServers.push(server);
      resolve(server.address().port);
    });
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

const startProxy = async (config) => {
  const app = express();

  app.use(
    createHomeAssistantMediaProxy({
      serviceAccountConfigProvider: () => config,
    })
  );

  app.use((_request, response) => {
    response.sendStatus(404);
  });

  const server = createServer(app);
  const port = await listen(server);

  return `http://127.0.0.1:${port}`;
};

afterEach(async () => {
  while (openServers.length > 0) {
    await closeServer(openServers.pop());
  }
});

describe('Home Assistant media proxy', () => {
  it('proxies media using the server token and removes URL tokens', async () => {
    let receivedRequest = null;

    const upstreamServer = createServer((request, response) => {
      receivedRequest = {
        url: request.url,
        authorization: request.headers.authorization,
        range: request.headers.range,
      };

      response.writeHead(206, {
        'Content-Type': 'image/jpeg',
        'Content-Length': '3',
        'Content-Range': 'bytes 0-2/3',
        'Cache-Control': 'private, max-age=30',
      });

      response.end(Buffer.from([1, 2, 3]));
    });

    const upstreamPort = await listen(upstreamServer);

    const proxyBase = await startProxy({
      enabled: true,
      haUrl: `http://127.0.0.1:${upstreamPort}`,
      token: 'server-side-token',
      requireProxyUser: true,
    });

    const response = await fetch(
      `${proxyBase}/api/media_player_proxy/media_player.salon` +
        '?token=browser-token&access_token=other-token&cache=abc',
      {
        headers: {
          'Remote-User': 'pascal',
          Range: 'bytes=0-2',
        },
      }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from([1, 2, 3])
    );

    expect(receivedRequest).toEqual({
      url: '/api/media_player_proxy/media_player.salon?cache=abc',
      authorization: 'Bearer server-side-token',
      range: 'bytes=0-2',
    });
  });

  it('rejects requests without an authenticated proxy user', async () => {
    let upstreamRequests = 0;

    const upstreamServer = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('unexpected');
    });

    const upstreamPort = await listen(upstreamServer);

    const proxyBase = await startProxy({
      enabled: true,
      haUrl: `http://127.0.0.1:${upstreamPort}`,
      token: 'server-side-token',
      requireProxyUser: true,
    });

    const response = await fetch(
      `${proxyBase}/api/camera_proxy/camera.salon`
    );

    expect(response.status).toBe(401);
    expect(upstreamRequests).toBe(0);
  });

  it('does not proxy arbitrary Home Assistant API routes', async () => {
    let upstreamRequests = 0;

    const upstreamServer = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('unexpected');
    });

    const upstreamPort = await listen(upstreamServer);

    const proxyBase = await startProxy({
      enabled: true,
      haUrl: `http://127.0.0.1:${upstreamPort}`,
      token: 'server-side-token',
      requireProxyUser: true,
    });

    const response = await fetch(`${proxyBase}/api/config`, {
      headers: {
        'Remote-User': 'pascal',
      },
    });

    expect(response.status).toBe(404);
    expect(upstreamRequests).toBe(0);
  });
});
