import { getEnv } from '../types';

interface NwcliSubAccountResponse {
  id: string;
  identifier: string;
  subAccount: {
    id: string;
    label: string;
    createdAt: string;
    updatedAt: string;
    balanceMsats: number;
    pendingMsats: number;
    connectUri: string | null;
  };
}

interface NwcliBalanceResponse {
  nickname: string;
  balanceMsats: number;
  pendingMsats?: number;
  [key: string]: unknown;
}

interface NwcliInvoiceResponse {
  invoice: string;
  [key: string]: unknown;
}

interface NwcliPayInvoiceResponse {
  status?: string;
  preimage?: string;
  [key: string]: unknown;
}

interface NwcliPayLnAddressResponse {
  status?: string;
  preimage?: string;
  successAction?: unknown;
  [key: string]: unknown;
}

let cachedBaseUrl: string | null = null;
let cachedAuthHeader: string | null | undefined;
let cachedMasterWallet: string | null = null;
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `req-${Date.now()}-${requestSeq}`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function logRequest(id: string, info: { method: string; url: string; body?: unknown }) {
  const payload = typeof info.body === 'string' ? safeJsonParse(info.body) : info.body;
  console.log('[nwcli] request', { id, method: info.method, url: info.url, body: payload });
}

function logResponse(id: string, info: { status: number; statusText: string; data: unknown }) {
  console.log('[nwcli] response', { id, status: info.status, statusText: info.statusText, data: info.data });
}

function logError(id: string, error: unknown) {
  console.error('[nwcli] error', { id, error });
}

function buildBaseUrl(): string {
  if (cachedBaseUrl) return cachedBaseUrl;
  const rawBase = getEnv('NWCLI_BASEURL', 'http://127.0.0.1');
  const port = getEnv('NWCLI_PORT', '');
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBase);
  } catch (error) {
    throw new Error(`[nwcli] Invalid NWCLI_BASEURL '${rawBase}': ${String(error)}`);
  }
  if (port) {
    baseUrl.port = port;
  }
  cachedBaseUrl = baseUrl.toString().replace(/\/$/, '');
  return cachedBaseUrl;
}

function getAuthHeader(): string | null {
  if (cachedAuthHeader !== undefined) return cachedAuthHeader;
  const token = getEnv('NWCLI_AUTH', '').trim();
  cachedAuthHeader = token ? `Bearer ${token}` : null;
  return cachedAuthHeader;
}

function getMasterWallet(): string {
  if (cachedMasterWallet) return cachedMasterWallet;
  const wallet = getEnv('NWCLI_MASTER_WALLET', '').trim();
  if (!wallet) {
    throw new Error('[nwcli] NWCLI_MASTER_WALLET is not configured.');
  }
  cachedMasterWallet = wallet;
  return wallet;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = buildBaseUrl();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const authHeader = getAuthHeader();
  if (authHeader && !headers.has('Authorization')) {
    headers.set('Authorization', authHeader);
  }
  const bodyIsJson = init.body && !(init.body instanceof FormData) && !headers.has('Content-Type');
  if (bodyIsJson) {
    headers.set('Content-Type', 'application/json');
  }
  const requestId = nextRequestId();
  const method = (init.method || 'GET').toUpperCase();
  logRequest(requestId, { method, url, body: init.body });

  try {
    const response = await fetch(url, { ...init, headers });
    const rawText = await response.text();
    const data = rawText ? safeJsonParse(rawText) : null;

    logResponse(requestId, { status: response.status, statusText: response.statusText, data });

    if (!response.ok) {
      const error = new Error(`[nwcli] ${response.status} ${response.statusText}`);
      (error as Error & { status?: number; data?: unknown }).status = response.status;
      (error as Error & { status?: number; data?: unknown }).data = data;
      throw error;
    }

    return data as T;
  } catch (error) {
    logError(requestId, error);
    throw error;
  }
}

export async function createSubAccount(params: {
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
  connectUri?: string;
}): Promise<NwcliSubAccountResponse> {
  const parent = getMasterWallet();
  const body = JSON.stringify({
    label: params.label,
    description: params.description,
    metadata: params.metadata,
    connectUri: params.connectUri,
  });
  return request(`/api/wallets/${encodeURIComponent(parent)}/subaccounts`, {
    method: 'POST',
    body,
  });
}

export async function fetchBalance(identifier: string): Promise<NwcliBalanceResponse> {
  const query = new URLSearchParams({ nickname: identifier });
  return request(`/api/balance?${query.toString()}`);
}

export async function createInvoice(identifier: string, amountSats: number, description?: string): Promise<NwcliInvoiceResponse> {
  return request('/api/getInvoice', {
    method: 'POST',
    body: JSON.stringify({
      nickname: identifier,
      amount: amountSats,
      description: description ?? 'Beacon Invoice',
    }),
  });
}

export async function payInvoice(identifier: string, invoice: string): Promise<NwcliPayInvoiceResponse> {
  return request('/api/payInvoice', {
    method: 'POST',
    body: JSON.stringify({
      nickname: identifier,
      invoice,
    }),
  });
}

export async function payLnAddress(identifier: string, lnAddress: string, amountSats: number, comment?: string): Promise<NwcliPayLnAddressResponse> {
  return request('/api/payLnAddress', {
    method: 'POST',
    body: JSON.stringify({
      nickname: identifier,
      lnAddress,
      amountSats,
      comment,
    }),
  });
}

export interface RefreshLedgerResponse {
  data?: {
    settled?: number;
    [key: string]: unknown;
  };
  context?: Record<string, unknown>;
}

export async function refreshLedger(identifier: string): Promise<RefreshLedgerResponse> {
  return request('/api/refreshLedger', {
    method: 'POST',
    body: JSON.stringify({ nickname: identifier }),
  });
}
