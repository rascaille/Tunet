import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getServiceAccountConfig } from './serviceAccount.js';

const ALLOWED_PATH_PREFIXES = Object.freeze([
  '/api/camera_proxy/',
  '/api/camera_proxy_stream/',
  '/api/media_player_proxy/',
  '/api/image_proxy/',
]);

const FORWARDED_REQUEST_HEADERS = Object.freeze([
  'accept',
  'accept-language',
  'range',
  'if-none-match',
  'if-modified-since',
  'if-range',
]);

const FORWARDED_RESPONSE_HEADERS = Object.freeze([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
]);

const isAllowedMediaPath = (pathname) =>
  ALLOWED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));

const getProxyUser = (request) =>
  String(request.get('Remote-User') || '').trim();

export const createHomeAssistantMediaProxy = ({
  serviceAccountConfigProvider = getServiceAccountConfig,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Home Assistant media proxy requires fetch');
  }

  return async (request, response, next) => {
    let requestUrl;

    try {
      requestUrl = new URL(
        request.originalUrl || request.url || '/',
        'http://tunet.local'
      );
    } catch {
      return next();
    }

    if (!isAllowedMediaPath(requestUrl.pathname)) {
      return next();
    }

    let config;

    try {
      config = serviceAccountConfigProvider();
    } catch (error) {
      console.error(
        '[media-proxy] Service-account configuration unavailable:',
        error instanceof Error ? error.message : 'unknown error'
      );

      return response.status(503).json({
        error: 'Home Assistant media proxy unavailable',
      });
    }

    if (!config.enabled) {
      return next();
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');

      return response.status(405).json({
        error: 'Method not allowed',
      });
    }

    if (config.requireProxyUser && !getProxyUser(request)) {
      return response.status(401).json({
        error: 'Authenticated proxy user required',
      });
    }

    // Ces paramètres ne doivent jamais être transmis ni journalisés.
    // L'authentification réelle utilise exclusivement le jeton serveur.
    requestUrl.searchParams.delete('token');
    requestUrl.searchParams.delete('access_token');

    const upstreamUrl = new URL(
      requestUrl.pathname,
      `${config.haUrl}/`
    );

    upstreamUrl.search = requestUrl.searchParams.toString();

    const upstreamHeaders = new Headers({
      Authorization: `Bearer ${config.token}`,
      'Accept-Encoding': 'identity',
    });

    for (const headerName of FORWARDED_REQUEST_HEADERS) {
      const value = request.get(headerName);

      if (value) {
        upstreamHeaders.set(headerName, value);
      }
    }

    const abortController = new AbortController();

    const abortUpstream = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };

    const handleResponseClose = () => {
      if (!response.writableEnded) {
        abortUpstream();
      }
    };

    request.once('aborted', abortUpstream);
    response.once('close', handleResponseClose);

    try {
      const upstreamResponse = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: 'follow',
        signal: abortController.signal,
      });

      response.status(upstreamResponse.status);

      for (const headerName of FORWARDED_RESPONSE_HEADERS) {
        const value = upstreamResponse.headers.get(headerName);

        if (value !== null) {
          response.setHeader(headerName, value);
        }
      }

      response.setHeader('X-Content-Type-Options', 'nosniff');

      // Demande notamment à Nginx de ne pas mettre en tampon le flux MJPEG.
      response.setHeader('X-Accel-Buffering', 'no');

      if (
        request.method === 'HEAD' ||
        upstreamResponse.status === 204 ||
        upstreamResponse.status === 304 ||
        !upstreamResponse.body
      ) {
        return response.end();
      }

      response.flushHeaders?.();

      await pipeline(
        Readable.fromWeb(upstreamResponse.body),
        response
      );

      return undefined;
    } catch (error) {
      if (
        abortController.signal.aborted ||
        error?.name === 'AbortError'
      ) {
        return undefined;
      }

      console.error(
        '[media-proxy] Home Assistant media request failed:',
        error instanceof Error ? error.message : 'unknown error'
      );

      if (response.headersSent) {
        response.destroy();
        return undefined;
      }

      return response.status(502).json({
        error: 'Home Assistant media unavailable',
      });
    } finally {
      request.off('aborted', abortUpstream);
      response.off('close', handleResponseClose);
    }
  };
};
