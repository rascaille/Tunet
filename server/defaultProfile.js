import { existsSync, readFileSync, statSync } from 'node:fs';

const MAX_PROFILE_SIZE_BYTES = 2 * 1024 * 1024;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const cleanText = (value, fallback) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
};

export function getDefaultProfileFilePath(env = process.env) {
  return cleanText(env.TUNET_DEFAULT_PROFILE_FILE, '');
}

export function isDefaultProfileEnabled(env = process.env) {
  const filePath = getDefaultProfileFilePath(env);
  return Boolean(filePath && existsSync(filePath));
}

export function readDefaultProfile({
  env = process.env,
  readFile = readFileSync,
  statFile = statSync,
} = {}) {
  const filePath = getDefaultProfileFilePath(env);
  if (!filePath) return null;

  const stats = statFile(filePath);
  if (!stats.isFile()) {
    throw new Error('Default profile path is not a regular file');
  }
  if (stats.size <= 0 || stats.size > MAX_PROFILE_SIZE_BYTES) {
    throw new Error('Default profile file size is invalid');
  }

  const parsed = JSON.parse(readFile(filePath, 'utf8'));
  const data = isObject(parsed?.data) ? parsed.data : parsed;

  if (
    !isObject(data) ||
    typeof data.version !== 'number' ||
    !isObject(data.layout) ||
    !isObject(data.appearance)
  ) {
    throw new Error('Default profile does not contain a valid Tunet snapshot');
  }

  const versionCandidate = Number(
    parsed?.templateVersion ?? parsed?.template_version ?? 1
  );

  return {
    id: cleanText(parsed?.templateId ?? parsed?.template_id, 'maison'),
    name: cleanText(parsed?.name, 'Maison'),
    templateVersion: Number.isFinite(versionCandidate) && versionCandidate > 0
      ? Math.trunc(versionCandidate)
      : 1,
    data,
  };
}
