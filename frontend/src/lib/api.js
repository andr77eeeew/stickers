export const apiFetch = (path, options = {}) => fetch(path, {
  ...options,
  credentials: 'same-origin'
});

export const getWebSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};
