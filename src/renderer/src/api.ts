/**
 * Fronteira de dados da interface. No Electron aponta para o preload; no
 * build web este módulo é substituído pelo cliente HTTP do Worker.
 */
export const api = window.api
