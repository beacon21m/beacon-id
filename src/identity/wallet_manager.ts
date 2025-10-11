// src/identity/wallet_manager.ts
// This module handles the actual Nostr Wallet Connect logic.

import type { PendingPayment } from './pending_store';
import { getEnv } from '../types';
import { WalletConnect } from 'applesauce-wallet-connect';
import { parseWalletConnectURI } from 'applesauce-wallet-connect/helpers';
import { RelayPool } from 'applesauce-relay';
import { hexToBytes } from '@noble/hashes/utils';
import { getDB } from '../db';
import { decrypt } from './encryption';
import {
  fetchBalance as nwcliFetchBalance,
  createInvoice as nwcliCreateInvoice,
  payInvoice as nwcliPayInvoice,
  payLnAddress as nwcliPayLnAddress,
  refreshLedger as nwcliRefreshLedger,
} from './nwcli_client';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';

export interface PaymentResult {
  success: boolean;
  receipt?: string;
  error?: string;
}

const pool = new RelayPool();

function logWalletError(context: string, error: unknown, extra?: Record<string, unknown>) {
  if (error instanceof Error) {
    console.error(context, { message: error.message, stack: error.stack, ...extra });
  } else {
    console.error(context, { error, ...extra });
  }
}

type WalletType = 'nwc' | 'api';

interface WalletDetails {
  type: WalletType;
  npub: string;
  nwcUri?: string | null;
  lnAddress?: string | null;
  apiIdentifier?: string | null;
  apiSubAccountId?: string | null;
  apiLabel?: string | null;
}

function loadWallet(npub: string): WalletDetails | null {
  const db = getDB();
  const row = db
    .query(
      `SELECT wallet_type, encrypted_nwc_string, ln_address, api_identifier, api_subaccount_id, api_label
       FROM user_wallets WHERE user_npub = ?`
    )
    .get(npub) as { [key: string]: unknown } | undefined;

  if (!row) {
    const shared = getEnv('SHARED_NWC_STRING', '').trim();
    if (shared) {
      return { type: 'nwc', npub, nwcUri: shared, lnAddress: null };
    }
    return null;
  }

  const walletType = String(row.wallet_type || '').toLowerCase();
  if (walletType === 'nwc') {
    const encrypted = row.encrypted_nwc_string ? String(row.encrypted_nwc_string) : '';
    if (!encrypted) return null;
    return {
      type: 'nwc',
      npub,
      nwcUri: decrypt(encrypted),
      lnAddress: row.ln_address ? String(row.ln_address) : null,
    };
  }
  if (walletType === 'api') {
    const identifier = row.api_identifier ? String(row.api_identifier) : null;
    if (!identifier) return null;
    return {
      type: 'api',
      npub,
      lnAddress: row.ln_address ? String(row.ln_address) : null,
      apiIdentifier: identifier,
      apiSubAccountId: row.api_subaccount_id ? String(row.api_subaccount_id) : null,
      apiLabel: row.api_label ? String(row.api_label) : null,
    };
  }

  return null;
}

function interpretNwcliPaymentResponse(response: Record<string, unknown>): { success: boolean; preimage?: string } {
  function findPreimage(value: unknown): string | undefined {
    if (!value) return undefined;
    if (typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/i.test(value)) {
      return value;
    }
    if (typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const keys = ['preimage', 'paymentPreimage', 'preImage'];
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string') {
        return candidate;
      }
    }
    for (const nested of Object.values(record)) {
      const found = findPreimage(nested);
      if (found) return found;
    }
    return undefined;
  }

  function findSuccessFlag(value: unknown): boolean | undefined {
    if (!value) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (['ok', 'success', 'paid', 'settled', 'completed'].includes(normalized)) return true;
      if (['error', 'failed', 'rejected'].includes(normalized)) return false;
    }
    if (typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.success === 'boolean') return record.success;
    if (typeof record.status === 'string') return findSuccessFlag(record.status);
    if (typeof record.state === 'string') return findSuccessFlag(record.state);
    for (const nested of Object.values(record)) {
      const found = findSuccessFlag(nested);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function hasPayResult(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (record.payResult) return true;
    if (record.result && typeof record.result === 'object' && (record.result as Record<string, unknown>).payResult) {
      return true;
    }
    return Object.values(record).some(hasPayResult);
  }

  const preimage = findPreimage(response);
  let success = findSuccessFlag(response);
  if (success === undefined && hasPayResult(response)) success = true;
  if (success === undefined) {
    const msats = extractMsats(response);
    if (msats !== null && msats >= 0) success = true;
  }
  return { success: success ?? Boolean(preimage), preimage };
}

function looksLikeInvoice(value: unknown): value is string {
  return typeof value === 'string' && value.toLowerCase().startsWith('ln') && value.length > 10;
}

function extractInvoiceFromResponse(response: unknown): string | null {
  if (looksLikeInvoice(response)) return response;
  if (!response || typeof response !== 'object') return null;
  const candidateKeys = ['invoice', 'pr', 'paymentRequest', 'bolt11'];
  for (const key of candidateKeys) {
    const value = (response as Record<string, unknown>)[key];
    if (looksLikeInvoice(value)) return value;
  }
  for (const value of Object.values(response as Record<string, unknown>)) {
    if (looksLikeInvoice(value)) return value;
    if (value && typeof value === 'object') {
      const nested = extractInvoiceFromResponse(value);
      if (nested) return nested;
    }
  }
  return null;
}

function extractErrorMessage(response: unknown): string | null {
  if (!response) return null;
  if (typeof response === 'string') {
    const trimmed = response.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const keys = ['error', 'message', 'reason', 'detail', 'description'];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  if (typeof record.status === 'string' && record.status.toLowerCase() === 'error') {
    return 'Remote wallet API reported an error status.';
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'object') {
      const nested = extractErrorMessage(value);
      if (nested) return nested;
    }
  }
  return null;
}

function extractMsats(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const directKeys = ['balanceMsats', 'balance_msats', 'msats', 'amountMsats', 'balance'];
  for (const key of directKeys) {
    if (key in record) {
      const msats = extractMsats(record[key]);
      if (msats !== null) return msats;
    }
  }
  const nestedKeys = ['data', 'context', 'result'];
  for (const key of nestedKeys) {
    if (key in record) {
      const msats = extractMsats(record[key]);
      if (msats !== null) return msats;
    }
  }
  if (Array.isArray(record.balances)) {
    for (const entry of record.balances as unknown[]) {
      const msats = extractMsats(entry);
      if (msats !== null) return msats;
    }
  }
  return null;
}

function extractPendingMsats(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const directKeys = ['pendingMsats', 'pending_msats', 'pendingAmountMsats', 'pending'];
  for (const key of directKeys) {
    if (key in record) {
      const msats = extractPendingMsats(record[key]);
      if (msats !== null) return msats;
    }
  }
  const nestedKeys = ['data', 'context', 'result'];
  for (const key of nestedKeys) {
    if (key in record) {
      const msats = extractPendingMsats(record[key]);
      if (msats !== null) return msats;
    }
  }
  if (Array.isArray(record.pending)) {
    for (const entry of record.pending as unknown[]) {
      const msats = extractPendingMsats(entry);
      if (msats !== null) return msats;
    }
  }
  return null;
}

function extractMessageFromError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const withData = error as Error & { data?: unknown };
    const dataMessage = extractErrorMessage(withData.data);
    return dataMessage || error.message;
  }
  const record = error as Record<string, unknown>;
  if (record.data) {
    const dataMessage = extractErrorMessage(record.data);
    if (dataMessage) return dataMessage;
  }
  if (typeof record.message === 'string') return record.message;
  return undefined;
}

function msatsToSats(msats: number | null | undefined): number | null {
  if (msats === null || msats === undefined) return null;
  return Math.floor(msats / 1000);
}

function buildBalanceInsight(
  balanceMsats: number | null,
  pendingMsats: number | null,
  requestMsats?: number | null
): string | null {
  const availableMsats = balanceMsats !== null
    ? Math.max(balanceMsats - (pendingMsats ?? 0), 0)
    : null;
  const parts: string[] = [];
  if (availableMsats !== null) parts.push(`available ${msatsToSats(availableMsats)} sats`);
  if (balanceMsats !== null) parts.push(`balance ${msatsToSats(balanceMsats)} sats`);
  if (pendingMsats !== null) parts.push(`pending ${msatsToSats(pendingMsats)} sats`);
  if (requestMsats !== null && requestMsats !== undefined) {
    parts.push(`request ${msatsToSats(requestMsats)} sats`);
  }
  if (!parts.length) return null;
  return `(${parts.join(', ')})`;
}

function decodeInvoiceMsats(invoice: string): number | null {
  try {
    const decoded = decodeBolt11(invoice);
    const amountSection = decoded.sections.find((s) => s.name === 'amount');
    if (!amountSection?.value) return null;
    const value = Number(amountSection.value);
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    logWalletError('[WalletManager] Failed to decode invoice amount', error, { invoice });
    return null;
  }
}

async function refreshLedgerIfSupported(identifier: string | null | undefined) {
  if (!identifier) return;
  try {
    await nwcliRefreshLedger(identifier);
  } catch (error) {
    logWalletError('[WalletManager] refreshLedger failed (non-fatal)', error, { identifier });
  }
}

// --- LNURL Helper Functions (modeled on nwcli) ---

async function getInvoiceFromLnAddress(lnAddress: string, amountSats: number): Promise<string> {
  console.log(`[LNURL] Getting invoice for ${lnAddress}`);
  
  const [name, domain] = lnAddress.split('@');
  if (!name || !domain) throw new Error('Invalid Lightning Address format.');
  const lnurlpUrl = new URL(`https://${domain}/.well-known/lnurlp/${name}`);
  
  console.log(`[LNURL] Fetching params from ${lnurlpUrl.toString()}`);
  const paramsRes = await fetch(lnurlpUrl.toString());
  const params = await paramsRes.json();
  if (params.status === 'ERROR' || params.tag !== 'payRequest') {
    throw new Error(`LNURL-pay failed: ${params.reason || 'Invalid response'}`);
  }

  const amountMsats = amountSats * 1000;
  const callbackUrl = new URL(params.callback);
  callbackUrl.searchParams.set('amount', String(amountMsats));
  
  console.log(`[LNURL] Requesting invoice from ${callbackUrl.toString()}`);
  const invoiceRes = await fetch(callbackUrl.toString());
  const invoiceData = await invoiceRes.json();
  if (invoiceData.status === 'ERROR' || !invoiceData.pr) {
    throw new Error(`Failed to get invoice: ${invoiceData.reason || 'Invalid response'}`);
  }
  
  const invoice = invoiceData.pr;
  const decoded = decodeBolt11(invoice);
  const invoiceAmountMsats = decoded.sections.find(s => s.name === 'amount')?.value;
  if (String(invoiceAmountMsats) !== String(amountMsats)) {
    throw new Error(`Invoice amount mismatch. Expected ${amountMsats}, got ${invoiceAmountMsats}`);
  }
  
  console.log(`[LNURL] Successfully fetched and verified invoice.`);
  return invoice;
}


/**
 * Makes a Lightning payment using Nostr Wallet Connect.
 */
export async function makePayment(details: PendingPayment): Promise<PaymentResult> {
  console.log(`[WalletManager] Processing payment for npub ${details.npub}:`, details);

  const wallet = loadWallet(details.npub);
  if (!wallet) return { success: false, error: `No wallet found for user ${details.npub}.` };

  if (wallet.type === 'nwc') {
    const nwcUri = wallet.nwcUri;
    if (!nwcUri) return { success: false, error: `Wallet for ${details.npub} is missing NWC credentials.` };
    try {
      const parsedUri = parseWalletConnectURI(nwcUri);
      const secret = hexToBytes(parsedUri.secret);
      const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });

      let invoice: string;
      if (details.type === 'ln_address') {
        if (!details.lnAddress || !details.amount) return { success: false, error: 'Missing lnAddress or amount' };
        invoice = await getInvoiceFromLnAddress(details.lnAddress, details.amount);
      } else {
        invoice = details.lnInvoice!;
      }

      const result = await client.payInvoice(invoice);
      if (result?.preimage) {
        return { success: true, receipt: result.preimage };
      } else {
        return { success: false, error: 'Payment was rejected or failed.' };
      }
    } catch (error: any) {
      logWalletError('[WalletManager] makePayment failed', error, { npub: details.npub, type: details.type, walletType: wallet.type });
      return { success: false, error: error?.message || 'An unknown error occurred.' };
    }
  }

  if (!wallet.apiIdentifier) {
    return { success: false, error: `Wallet for ${details.npub} is missing API identifier.` };
  }

  try {
    await refreshLedgerIfSupported(wallet.apiIdentifier);
  } catch (error) {
    logWalletError('[WalletManager] refreshLedger before payment failed', error, { npub: details.npub, walletType: wallet.type });
  }

  let balanceSnapshot: { balanceMsats: number | null; pendingMsats: number | null } | null = null;
  try {
    const balanceResponse = await nwcliFetchBalance(wallet.apiIdentifier);
    balanceSnapshot = {
      balanceMsats: extractMsats(balanceResponse),
      pendingMsats: extractPendingMsats(balanceResponse),
    };
    console.log('[WalletManager] API wallet snapshot before payment', {
      identifier: wallet.apiIdentifier,
      balanceMsats: balanceSnapshot.balanceMsats,
      pendingMsats: balanceSnapshot.pendingMsats,
    });
  } catch (balanceError) {
    logWalletError('[WalletManager] Failed to fetch balance before payment', balanceError, { npub: details.npub, walletType: wallet.type });
  }

  const appendBalanceContext = (message: string, requestMsats?: number | null) => {
    const insight = buildBalanceInsight(balanceSnapshot?.balanceMsats ?? null, balanceSnapshot?.pendingMsats ?? null, requestMsats);
    return insight ? `${message} ${insight}` : message;
  };

  const lnAddressRequestMsats = details.type === 'ln_address' && details.amount ? details.amount * 1000 : null;
  const lnInvoiceRequestMsats = details.type === 'ln_invoice' && details.lnInvoice ? decodeInvoiceMsats(details.lnInvoice) : null;

  try {
    if (details.type === 'ln_address') {
      if (!details.lnAddress || !details.amount) return { success: false, error: 'Missing lnAddress or amount' };
      const response = await nwcliPayLnAddress(wallet.apiIdentifier, details.lnAddress, details.amount);
      const interpreted = interpretNwcliPaymentResponse(response as Record<string, unknown>);
      if (interpreted.success) {
        return { success: true, receipt: interpreted.preimage };
      }
      const failureMessage = appendBalanceContext(
        extractErrorMessage(response) || 'Payment was rejected or failed.',
        lnAddressRequestMsats
      );
      return { success: false, error: failureMessage };
    }

    const invoice = details.lnInvoice;
    if (!invoice) return { success: false, error: 'Missing invoice for payment.' };
    const response = await nwcliPayInvoice(wallet.apiIdentifier, invoice);
    const interpreted = interpretNwcliPaymentResponse(response as Record<string, unknown>);
    if (interpreted.success) {
      return { success: true, receipt: interpreted.preimage };
    }
    const failureMessage = appendBalanceContext(
      extractErrorMessage(response) || 'Payment was rejected or failed.',
      lnInvoiceRequestMsats
    );
    return { success: false, error: failureMessage };
  } catch (error: any) {
    logWalletError('[WalletManager] makePayment failed', error, { npub: details.npub, type: details.type, walletType: wallet.type });
    const requestMsats = details.type === 'ln_address'
      ? lnAddressRequestMsats
      : lnInvoiceRequestMsats;
    const reason = extractMessageFromError(error) || 'An unknown error occurred.';
    return { success: false, error: appendBalanceContext(reason, requestMsats) };
  }
}

export interface BalanceResult {
  success: boolean;
  balance?: number;
  error?: string;
}
export async function getBalance(npub: string): Promise<BalanceResult> {
  const wallet = loadWallet(npub);
  if (!wallet) return { success: false, error: `No wallet found for user ${npub}.` };

  if (wallet.type === 'nwc') {
    const nwcUri = wallet.nwcUri;
    if (!nwcUri) return { success: false, error: `Wallet for ${npub} is missing NWC credentials.` };
    try {
      const parsedUri = parseWalletConnectURI(nwcUri);
      const secret = hexToBytes(parsedUri.secret);
      const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });
      const result = await client.getBalance();
      const balanceSats = Math.floor(result.balance / 1000);
      return { success: true, balance: balanceSats };
    } catch (error: any) {
      logWalletError('[WalletManager] getBalance failed', error, { npub, walletType: wallet.type });
      return { success: false, error: error?.message || 'An unknown error occurred.' };
    }
  }

  if (!wallet.apiIdentifier) {
    return { success: false, error: `Wallet for ${npub} is missing API identifier.` };
  }

  try {
    const result = await nwcliFetchBalance(wallet.apiIdentifier);
    const msats = extractMsats(result);
    if (msats === null) {
      logWalletError('[WalletManager] getBalance api response missing balance', new Error('Missing balanceMsats'), {
        npub,
        walletType: wallet.type,
        response: result,
      });
      return { success: false, error: 'Failed to read balance from wallet response.' };
    }
    const balanceSats = Math.floor(msats / 1000);
    return { success: true, balance: balanceSats };
  } catch (error: any) {
    logWalletError('[WalletManager] getBalance failed', error, { npub, walletType: wallet.type });
    return { success: false, error: error?.message || 'An unknown error occurred.' };
  }
}
export interface InvoiceResult {
  success: boolean;
  invoice?: string;
  error?: string;
}
export async function createInvoice(npub: string, amountSats: number): Promise<InvoiceResult> {
  const wallet = loadWallet(npub);
  if (!wallet) return { success: false, error: `No wallet found for user ${npub}.` };

  if (wallet.type === 'nwc') {
    const nwcUri = wallet.nwcUri;
    if (!nwcUri) return { success: false, error: `Wallet for ${npub} is missing NWC credentials.` };
    try {
      const parsedUri = parseWalletConnectURI(nwcUri);
      const secret = hexToBytes(parsedUri.secret);
      const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });
      const result = await client.makeInvoice(amountSats * 1000, { description: 'Beacon Invoice' });
      if (result.invoice) {
        return { success: true, invoice: result.invoice };
      } else {
        return { success: false, error: 'Failed to create invoice.' };
      }
    } catch (error: any) {
      logWalletError('[WalletManager] createInvoice failed', error, { npub, amountSats, walletType: wallet.type });
      return { success: false, error: error?.message || 'An unknown error occurred.' };
    }
  }

  if (!wallet.apiIdentifier) {
    return { success: false, error: `Wallet for ${npub} is missing API identifier.` };
  }

  try {
    const result = await nwcliCreateInvoice(wallet.apiIdentifier, amountSats, 'Beacon Invoice');
    const invoice = extractInvoiceFromResponse(result);
    if (invoice) {
      return { success: true, invoice };
    }
    const reason = extractErrorMessage(result) || 'Failed to create invoice.';
    logWalletError('[WalletManager] createInvoice API missing invoice', new Error(reason), {
      npub,
      amountSats,
      walletType: wallet.type,
      response: result,
    });
    return { success: false, error: reason };
  } catch (error: any) {
    logWalletError('[WalletManager] createInvoice failed', error, { npub, amountSats, walletType: wallet.type });
    const reason = extractMessageFromError(error) || 'An unknown error occurred.';
    return { success: false, error: reason };
  }
}
export interface LNAddressResult {
  success: boolean;
  lnAddress?: string;
  error?: string;
}
export async function getLNAddress(npub: string): Promise<LNAddressResult> {
  const wallet = loadWallet(npub);
  if (!wallet) return { success: false, error: `No wallet found for user ${npub}.` };

  if (wallet.type === 'nwc') {
    const nwcUri = wallet.nwcUri;
    if (!nwcUri) return { success: false, error: `Wallet for ${npub} is missing NWC credentials.` };
    try {
      const url = new URL(nwcUri.replace('nostr+walletconnect://', 'http://'));
      const lud16 = url.searchParams.get('lud16');
      if (lud16) {
        return { success: true, lnAddress: lud16 };
      }
    } catch (error: any) {
      logWalletError('[WalletManager] getLNAddress failed', error, { npub, walletType: wallet.type });
      // fall back to stored LN address if parsing fails
    }

    if (wallet.lnAddress) {
      return { success: true, lnAddress: wallet.lnAddress };
    }
    const db = getDB();
    const row = db.query(`SELECT ln_address FROM user_wallets WHERE user_npub = ?`).get(npub) as any;
    if (row?.ln_address) {
      return { success: true, lnAddress: row.ln_address };
    }
    return { success: false, error: 'Lightning Address not found.' };
  }

  if (wallet.lnAddress) {
    return { success: true, lnAddress: wallet.lnAddress };
  }
  return { success: false, error: 'Lightning Address not available for generated wallets.' };
}
export async function validateNwcString(nwcUri: string): Promise<boolean> {
  console.log(`[WalletManager] Validating NWC URI...`);
  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);
    const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });
    await client.getBalance();
    console.log(`[WalletManager] NWC URI is valid.`);
    return true;
  } catch (error) {
    logWalletError('[WalletManager] NWC URI validation failed', error, { nwcUri });
    return false;
  }
}
