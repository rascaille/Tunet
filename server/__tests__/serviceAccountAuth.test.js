import { describe, expect, it, vi } from 'vitest';
import { createHomeAssistantAuthMiddleware } from '../haAuth.js';

const createRequest = (headers = {}) => ({
  get: vi.fn((name) => {
    const key = String(name).toLowerCase();
    return headers[key];
  }),
  ip: '172.30.0.10',
  socket: {
    remoteAddress: '172.30.0.10',
  },
});

const createResponse = () => {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };

  response.status.mockReturnValue(response);
  return response;
};

describe('Home Assistant service-account API authentication', () => {
  it('uses only the server-side token when the proxy user is authenticated', async () => {
    const validateHomeAssistantUser = vi.fn().mockResolvedValue({
      id: 'ha-service-user',
      name: 'tunet',
      is_admin: false,
      is_owner: false,
    });

    const middleware = createHomeAssistantAuthMiddleware({
      validateHomeAssistantUser,
      serviceAccountConfigProvider: () => ({
        enabled: true,
        haUrl: 'https://ha.internal.example',
        token: 'server-side-token',
        requireProxyUser: true,
      }),
    });

    const request = createRequest({
      'remote-user': 'pascal',
      authorization: 'Bearer browser-token-that-must-be-ignored',
      'x-ha-url': 'https://attacker.example',
    });
    const response = createResponse();
    const next = vi.fn();

    await middleware(request, response, next);

    expect(validateHomeAssistantUser).toHaveBeenCalledTimes(1);
    expect(validateHomeAssistantUser).toHaveBeenCalledWith({
      haUrl: 'https://ha.internal.example',
      accessToken: 'server-side-token',
    });

    expect(request.authenticatedHaUser).toMatchObject({
      id: 'ha-service-user',
      name: 'tunet',
    });
    expect(request.authenticatedHaUrl).toBe('https://ha.internal.example');
    expect(request.authenticatedProxyUser).toBe('pascal');

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('rejects requests without an authenticated reverse-proxy user', async () => {
    const validateHomeAssistantUser = vi.fn();

    const middleware = createHomeAssistantAuthMiddleware({
      validateHomeAssistantUser,
      serviceAccountConfigProvider: () => ({
        enabled: true,
        haUrl: 'https://ha.internal.example',
        token: 'server-side-token',
        requireProxyUser: true,
      }),
    });

    const request = createRequest();
    const response = createResponse();
    const next = vi.fn();

    await middleware(request, response, next);

    expect(validateHomeAssistantUser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Missing authenticated reverse-proxy user',
      code: 'PROXY_USER_REQUIRED',
    });
  });
});
