/**
 * Dynamic API and WebSocket URL resolver.
 * Works seamlessly across:
 *  1. Local Vite dev server (via Vite proxy configured in vite.config.js)
 *  2. Cloudflare Tunnel (https://*.trycloudflare.com -> port 5173 or port 80)
 *  3. Docker Nginx production container
 */

export const getApiBase = () => {
  if (import.meta.env.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL;
  }
  return '';
};

export const getWebSocketUrl = (roomCode) => {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (import.meta.env.VITE_WS_URL) {
    return `${import.meta.env.VITE_WS_URL}/ws/meeting/${roomCode}/`;
  }

  return `${protocol}//${window.location.host}/ws/meeting/${roomCode}/`;
};
