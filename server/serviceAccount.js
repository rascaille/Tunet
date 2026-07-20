import { readFileSync } from 'node:fs';

const DEFAULT_TOKEN_FILE = '/run/secrets/ha_service_token';

let cachedConfig;

const normalizeHomeAssistantUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('TUNET_INTERNAL_HA_URL is required in service-account mode');
  }

  const parsed = new URL(rawUrl.trim());

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('TUNET_INTERNAL_HA_URL must use http:// or https://');
  }

  if (parsed.username || parsed.password) {
    throw new Error('TUNET_INTERNAL_HA_URL must not contain credentials');
  }

  parsed.hash = '';
  parsed.search = '';

  return parsed.toString().replace(/\/$/, '');
};

export const getServiceAccountConfig = () => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const enabled = process.env.TUNET_SERVICE_ACCOUNT_MODE === '1';

  if (!enabled) {
    cachedConfig = Object.freeze({
      enabled: false,
    });

    return cachedConfig;
  }

  const haUrl = normalizeHomeAssistantUrl(process.env.TUNET_INTERNAL_HA_URL);
  const tokenFile =
    process.env.TUNET_HA_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE;

  let token;

  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `Unable to read the Home Assistant service-account token file: ${error.message}`
    );
  }

  if (!token) {
    throw new Error('The Home Assistant service-account token file is empty');
  }

  cachedConfig = Object.freeze({
    enabled: true,
    haUrl,
    token,
    tokenFile,
    requireProxyUser: process.env.TUNET_REQUIRE_PROXY_USER !== '0',
  });

  return cachedConfig;
};

export const resetServiceAccountConfigForTests = () => {
  cachedConfig = undefined;
};
