import { clearOAuthTokens } from './oauthStorage';

export const SERVICE_ACCOUNT_AUTH_METHOD = 'service_account';

// Valeur factice uniquement destinée au protocole HA WebSocket.
// Le backend la remplace par le véritable jeton serveur.
export const SERVICE_ACCOUNT_PLACEHOLDER_TOKEN = 'tunet-service-account-proxy';

let cachedRuntimeConfig = Object.freeze({
  serviceAccountMode: false,
  defaultProfileEnabled: false,
  authLogoutUrl: '',
});

const normalizePublicHttpsUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
};

export async function loadRuntimeConfig({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Runtime configuration fetch is unavailable');
  }

  const response = await fetchImpl('./api/runtime-config', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `Runtime configuration request failed with status ${response.status}`
    );
  }

  const body = await response.json();
  cachedRuntimeConfig = Object.freeze({
    serviceAccountMode: body?.serviceAccountMode === true,
    defaultProfileEnabled: body?.defaultProfileEnabled === true,
    authLogoutUrl: normalizePublicHttpsUrl(body?.authLogoutUrl),
  });

  // Keep the historical public return shape for existing consumers/tests.
  return { serviceAccountMode: cachedRuntimeConfig.serviceAccountMode };
}

export function getRuntimeConfig() {
  return cachedRuntimeConfig;
}

export function clearBrowserHomeAssistantCredentials() {
  clearOAuthTokens();
  try {
    globalThis.localStorage?.removeItem('ha_token');
    globalThis.localStorage?.removeItem('ha_url');
    globalThis.localStorage?.removeItem('ha_fallback_url');
    globalThis.localStorage?.setItem(
      'ha_auth_method',
      SERVICE_ACCOUNT_AUTH_METHOD
    );
    globalThis.sessionStorage?.removeItem('ha_token');
    globalThis.sessionStorage?.removeItem('ha_oauth_tokens');
  } catch {
    // Le stockage navigateur peut être indisponible en navigation privée.
  }
}

export function createServiceAccountClientConfig(
  origin = globalThis.window?.location?.origin || ''
) {
  return {
    url: origin,
    fallbackUrl: '',
    token: SERVICE_ACCOUNT_PLACEHOLDER_TOKEN,
    authMethod: SERVICE_ACCOUNT_AUTH_METHOD,
    isIngress: false,
  };
}
