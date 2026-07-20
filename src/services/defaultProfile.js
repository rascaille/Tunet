import { applySnapshot, isValidSnapshot } from './snapshot';

export const DEFAULT_PROFILE_LAYOUT_KEY = 'tunet_pages_config';
export const DEFAULT_PROFILE_ID_KEY = 'tunet_default_profile_id';
export const DEFAULT_PROFILE_VERSION_KEY = 'tunet_default_profile_version';

export function hasLocalDashboard(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(DEFAULT_PROFILE_LAYOUT_KEY) !== null;
  } catch {
    // Fail closed: if browser storage cannot be inspected, never overwrite it.
    return true;
  }
}

export async function bootstrapDefaultProfile({
  enabled,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  if (!enabled) return { applied: false, reason: 'disabled' };
  if (hasLocalDashboard(storage)) {
    return { applied: false, reason: 'existing-dashboard' };
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Default profile fetch is unavailable');
  }

  const response = await fetchImpl('./api/default-profile', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (response.status === 404) {
    return { applied: false, reason: 'not-configured' };
  }
  if (!response.ok) {
    throw new Error(`Default profile request failed with status ${response.status}`);
  }

  const profile = await response.json();
  if (!isValidSnapshot(profile?.data)) {
    throw new Error('Default profile snapshot is invalid');
  }

  // This runs before React mounts, so all contexts initialise from the seeded values.
  applySnapshot(profile.data);

  try {
    storage?.setItem(DEFAULT_PROFILE_ID_KEY, String(profile.id || 'maison'));
    storage?.setItem(
      DEFAULT_PROFILE_VERSION_KEY,
      String(Number(profile.templateVersion) || 1)
    );
  } catch {
    // The dashboard itself was already written by applySnapshot.
  }

  return {
    applied: true,
    id: String(profile.id || 'maison'),
    templateVersion: Number(profile.templateVersion) || 1,
  };
}
