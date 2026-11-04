/** Empty means same origin (development, through the Vite proxy). */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL ?? '').replace(/\/$/, '') || undefined;
