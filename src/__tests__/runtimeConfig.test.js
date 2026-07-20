import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearOAuthTokensMock = vi.fn();

vi.mock('../services/oauthStorage', () => ({
  clearOAuthTokens: () => clearOAuthTokensMock(),
}));

describe('runtimeConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearOAuthTokensMock.mockClear();
  });

  it('loads the service-account mode from the backend', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        serviceAccountMode: true,
      }),
    });

    const { loadRuntimeConfig } = await import(
      '../services/runtimeConfig'
    );

    await expect(
      loadRuntimeConfig({ fetchImpl })
    ).resolves.toEqual({
      serviceAccountMode: true,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      './api/runtime-config',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      })
    );
  });

  it('fails closed when the runtime endpoint is unavailable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const { loadRuntimeConfig } = await import(
      '../services/runtimeConfig'
    );

    await expect(
      loadRuntimeConfig({ fetchImpl })
    ).rejects.toThrow(
      'Runtime configuration request failed with status 503'
    );
  });

  it('clears browser credentials before enabling service-account mode', async () => {
    localStorage.setItem('ha_token', 'old-secret');
    localStorage.setItem('ha_url', 'https://ha.example');
    localStorage.setItem('ha_fallback_url', 'https://fallback.example');
    sessionStorage.setItem('ha_token', 'old-session-secret');

    const {
      clearBrowserHomeAssistantCredentials,
      createServiceAccountClientConfig,
    } = await import('../services/runtimeConfig');

    clearBrowserHomeAssistantCredentials();

    expect(clearOAuthTokensMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('ha_token')).toBeNull();
    expect(localStorage.getItem('ha_url')).toBeNull();
    expect(localStorage.getItem('ha_fallback_url')).toBeNull();
    expect(sessionStorage.getItem('ha_token')).toBeNull();
    expect(localStorage.getItem('ha_auth_method')).toBe(
      'service_account'
    );

    expect(
      createServiceAccountClientConfig('https://tunet.example')
    ).toEqual({
      url: 'https://tunet.example',
      fallbackUrl: '',
      token: 'tunet-service-account-proxy',
      authMethod: 'service_account',
      isIngress: false,
    });
  });
});
