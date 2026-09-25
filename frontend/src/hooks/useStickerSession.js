import { useEffect, useRef, useState } from 'react';
import { apiFetch, getWebSocketUrl } from '../lib/api';

export function useStickerSession() {
  const [stickers, setStickers] = useState([]);
  const [bootstrapState, setBootstrapState] = useState('loading');
  const [bootstrapError, setBootstrapError] = useState('');
  const [captureStatus, setCaptureStatus] = useState({
    captureMode: 'offline',
    devtools: { state: 'closed', listening: false, lastAcceptedAt: null, lastError: null },
    storage: null
  });
  const [sessionInfo, setSessionInfo] = useState(null);
  const [outputPaths, setOutputPaths] = useState({});
  const [socketConnected, setSocketConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(false);
  const bootstrapRef = useRef(null);
  const refreshStatusRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;

    const applyStatus = (payload) => {
      if (!payload) return;
      const status = payload.status || payload;
      setCaptureStatus((previous) => ({
        ...previous,
        ...status,
        devtools: { ...previous.devtools, ...(status.devtools || {}) }
      }));
      if (status.session) setSessionInfo(status.session);
      if (status.outputPaths) setOutputPaths((previous) => ({ ...previous, ...status.outputPaths }));
      if (status.storage?.paths) setOutputPaths((previous) => ({ ...previous, ...status.storage.paths }));
    };

    const scheduleReconnect = () => {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) bootstrap();
      }, 3000);
    };

    const connectWebSocket = () => {
      if (!mountedRef.current) return;
      const socket = new WebSocket(getWebSocketUrl());
      wsRef.current = socket;

      socket.onopen = () => setSocketConnected(true);
      socket.onmessage = (event) => {
        try {
          const { type, data } = JSON.parse(event.data);
          if (type === 'init') {
            applyStatus(data);
            setStickers(data?.stickers || []);
          } else if (type === 'status' || type === 'capture_status') {
            applyStatus(data);
          } else if (type === 'new_sticker') {
            setStickers((previous) => previous.some((item) => item.id === data.id)
              ? previous
              : [data, ...previous]);
            if (data.captureSource === 'devtools') {
              setCaptureStatus((previous) => ({
                ...previous,
                devtools: {
                  ...previous.devtools,
                  state: 'last_asset_accepted',
                  listening: null,
                  lastAcceptedAt: data.capturedAt || new Date().toISOString(),
                  lastError: null
                }
              }));
            }
          } else if (type === 'sticker_update') {
            setStickers((previous) => previous.map((item) => item.id === data.id
              ? { ...item, ...data }
              : item));
          }
        } catch (error) {
          console.error('[WebSocket] Invalid message:', error);
        }
      };
      socket.onerror = () => setSocketConnected(false);
      socket.onclose = () => {
        setSocketConnected(false);
        if (mountedRef.current) scheduleReconnect();
      };
    };

    const bootstrap = async () => {
      try {
        setBootstrapState('loading');
        setBootstrapError('');
        const response = await apiFetch('/api/session');
        const result = await response.json();
        if (!response.ok || !result.authenticated) {
          throw new Error(result.error || 'Local session authentication failed');
        }

        if (!mountedRef.current) return;
        applyStatus(result.status || result);
        setOutputPaths(result.outputPaths || result.status?.outputPaths || {});
        setBootstrapState('ready');

        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.close();
        }
        connectWebSocket();
      } catch (error) {
        if (!mountedRef.current) return;
        setBootstrapState('error');
        setBootstrapError(error.message);
        setSocketConnected(false);
        scheduleReconnect();
      }
    };

    bootstrapRef.current = () => {
      window.clearTimeout(reconnectTimerRef.current);
      bootstrap();
    };
    refreshStatusRef.current = async () => {
      const response = await apiFetch('/api/status');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Status request failed');
      applyStatus(result);
      return result;
    };
    bootstrap();
    return () => {
      mountedRef.current = false;
      window.clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return {
    stickers, setStickers,
    bootstrapState, bootstrapError,
    captureStatus, setCaptureStatus,
    sessionInfo, setSessionInfo,
    outputPaths, socketConnected,
    retryConnection: () => bootstrapRef.current?.(),
    refreshStatus: () => refreshStatusRef.current?.()
  };
}
