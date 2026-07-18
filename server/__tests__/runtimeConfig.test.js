import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createApp } from '../index.js';
import { resetServiceAccountConfigForTests } from '../serviceAccount.js';

const originalMode = process.env.TUNET_SERVICE_ACCOUNT_MODE;

beforeEach(() => {
  delete process.env.TUNET_SERVICE_ACCOUNT_MODE;
  resetServiceAccountConfigForTests();
});

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.TUNET_SERVICE_ACCOUNT_MODE;
  } else {
    process.env.TUNET_SERVICE_ACCOUNT_MODE = originalMode;
  }

  resetServiceAccountConfigForTests();
});

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });

const close = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe('public runtime configuration', () => {
  it('reports service-account mode without exposing secrets', async () => {
    const app = createApp({
      isProduction: false,
      appVersion: 'test',
    });
    const server = createServer(app);

    try {
      const port = await listen(server);
      const response = await fetch(
        `http://127.0.0.1:${port}/api/runtime-config`
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(body).toEqual({
        serviceAccountMode: false,
      });

      expect(JSON.stringify(body)).not.toContain('token');
      expect(JSON.stringify(body)).not.toContain('haUrl');
      expect(JSON.stringify(body)).not.toContain('/run/secrets');
    } finally {
      await close(server);
    }
  });
});
