import { WebSocket, WebSocketServer } from 'ws';
import { getServiceAccountConfig } from './serviceAccount.js';

const CLIENT_PATH = '/api/websocket';
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const buildHomeAssistantWebSocketUrl = (haUrl) => {
  const upstreamUrl = new URL('/api/websocket', `${haUrl}/`);
  upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return upstreamUrl.toString();
};

const getHeaderValue = (request, name) => {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0]?.trim() || '';
  }

  return typeof value === 'string' ? value.trim() : '';
};

const closeSocket = (socket, code, reason) => {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  }
};

const forwardMessage = (target, data, isBinary) => {
  if (target.readyState !== WebSocket.OPEN) {
    return;
  }

  target.send(data, { binary: isBinary });
};

const parseJsonMessage = (data, isBinary) => {
  if (isBinary) {
    return null;
  }

  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
};

export const attachServiceAccountWebSocketProxy = ({ server }) => {
  const config = getServiceAccountConfig();

  if (!config.enabled) {
    console.log('[service-account] WebSocket proxy disabled');
    return;
  }

  const upstreamUrl = buildHomeAssistantWebSocketUrl(config.haUrl);

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  server.on('upgrade', (request, socket, head) => {
    let pathname;

    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== CLIENT_PATH) {
      socket.destroy();
      return;
    }

    const remoteUser = getHeaderValue(request, 'remote-user');

    if (config.requireProxyUser && !remoteUser) {
      console.warn(
        '[service-account] Rejected WebSocket upgrade without authenticated proxy user'
      );
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (clientSocket) => {
      webSocketServer.emit('connection', clientSocket, request, remoteUser);
    });
  });

  webSocketServer.on('connection', (clientSocket, _request, remoteUser) => {
    const upstreamSocket = new WebSocket(upstreamUrl, {
      handshakeTimeout: 15_000,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });

    let upstreamAuthenticated = false;
    let clientAuthReceived = false;

    upstreamSocket.on('open', () => {
      console.log(
        `[service-account] Home Assistant WebSocket opened for proxy user "${remoteUser || 'unknown'}"`
      );
    });

    upstreamSocket.on('message', (data, isBinary) => {
      const message = parseJsonMessage(data, isBinary);

      if (message?.type === 'auth_ok') {
        upstreamAuthenticated = true;
      }

      if (message?.type === 'auth_invalid') {
        console.warn(
          '[service-account] Home Assistant rejected the service-account token'
        );
      }

      forwardMessage(clientSocket, data, isBinary);
    });

    clientSocket.on('message', (data, isBinary) => {
      const message = parseJsonMessage(data, isBinary);

      if (message?.type === 'auth') {
        if (clientAuthReceived) {
          closeSocket(clientSocket, 1008, 'Duplicate authentication message');
          closeSocket(upstreamSocket, 1008, 'Duplicate authentication message');
          return;
        }

        clientAuthReceived = true;

        if (upstreamSocket.readyState !== WebSocket.OPEN) {
          closeSocket(
            clientSocket,
            1011,
            'Home Assistant connection unavailable'
          );
          return;
        }

        upstreamSocket.send(
          JSON.stringify({
            type: 'auth',
            access_token: config.token,
          })
        );

        return;
      }

      if (!upstreamAuthenticated) {
        closeSocket(clientSocket, 1008, 'Authentication required');
        closeSocket(upstreamSocket, 1008, 'Authentication required');
        return;
      }

      forwardMessage(upstreamSocket, data, isBinary);
    });

    upstreamSocket.on('close', (code, reason) => {
      closeSocket(
        clientSocket,
        code === 1000 ? 1000 : 1011,
        reason?.toString() || 'Home Assistant connection closed'
      );
    });

    clientSocket.on('close', () => {
      closeSocket(upstreamSocket, 1000, 'Client disconnected');
    });

    upstreamSocket.on('error', (error) => {
      console.error(
        `[service-account] Home Assistant WebSocket error: ${error.message}`
      );
      closeSocket(clientSocket, 1011, 'Home Assistant connection failed');
    });

    clientSocket.on('error', (error) => {
      console.warn(
        `[service-account] Client WebSocket error: ${error.message}`
      );
      closeSocket(upstreamSocket, 1000, 'Client connection failed');
    });
  });

  console.log(
    `[service-account] WebSocket proxy enabled on ${CLIENT_PATH} toward ${upstreamUrl}`
  );
};
