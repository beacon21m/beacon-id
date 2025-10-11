// src/identity/worker.ts
// This contains the core logic for the Identity service,
// processing messages from its dedicated queue.

import { nip19 } from 'nostr-tools';
import { consumeIdentityBeacon, enqueueIdentityOut } from './queues';
import { retrieveAndClearConfirmation } from './pending_store';
import { makePayment, validateNwcString, getBalance } from './wallet_manager';
import { getEnv, BeaconMessage, GatewayType, GatewayInfo } from '../types';
import { sendPaymentConfirmation, notifyBrainOfNewUser } from './cvm';
import { getDB } from '../db';
import { upsertLocalNpubMap, rememberGatewayBotId, resolveUserLinks } from '../gateway/npubMap';
import { encrypt } from './encryption';
import { SimpleSigner } from 'applesauce-signers';
import { toNpub } from 'applesauce-core/helpers/keys';
import { createSubAccount } from './nwcli_client';

// In-memory state to track onboarding conversations
type OnboardingStep =
  | { step: 'awaiting_choice'; npub: string }
  | { step: 'awaiting_nwc'; npub: string }
  | { step: 'awaiting_ln_address'; npub: string };

const onboardingState = new Map<string, OnboardingStep>();

function ensureBotId(
  ctx: Record<string, unknown>,
  gatewayType: GatewayType,
  gatewayUser: string
): string | undefined {
  const existing = typeof ctx.botid === 'string' ? ctx.botid.trim() : '';
  if (existing) return existing;
  try {
    const gatewayNpub = getEnv('GATEWAY_NPUB', '').trim();
    if (!gatewayNpub) return undefined;
    const links = resolveUserLinks(gatewayType, gatewayNpub, gatewayUser);
    const stored = links?.gatewayBotId?.trim();
    if (stored) {
      ctx.botid = stored;
      return stored;
    }
  } catch (err) {
    console.error('[identity] ensureBotId error', err);
  }
  return undefined;
}

function isUserKnown(gatewayUser: string, gatewayType: string): boolean {
  try {
    const db = getDB();
    const gatewayNpub = getEnv('GATEWAY_NPUB', '');
    const row = db
      .query(`SELECT 1 FROM local_npub_map WHERE gateway_user = ? AND gateway_npub = ? AND gateway_type = ?`)
      .get(gatewayUser, gatewayNpub, gatewayType);
    return !!row;
  } catch (e) {
    console.error('[identity] isUserKnown DB error:', e);
    return false;
  }
}

async function createNewUser(gatewayType: GatewayType, gatewayUser: string, gatewayBotId?: string | null): Promise<string | null> {
  try {
    const db = getDB();
    // Correctly create a new signer and await the public key
    const signer = new SimpleSigner();
    const pubkey = await signer.getPublicKey();
    // Use the canonical nostr-tools function to encode the npub
    const npub = nip19.npubEncode(pubkey);
    
    const gatewayNpub = getEnv('GATEWAY_NPUB', '');

    upsertLocalNpubMap(gatewayType, gatewayNpub, gatewayUser, npub, {
      gatewayBotId: gatewayBotId ? String(gatewayBotId) : null,
    });

    console.log(`[identity] Created new user mapping for ${gatewayUser} -> ${npub}`);
    return npub;
  } catch (e) {
    console.error('[identity] createNewUser DB error:', e);
    return null;
  }
}

function saveNwcWallet(npub: string, nwcString: string, lnAddress?: string) {
  try {
    const db = getDB();
    const encrypted = encrypt(nwcString);
    db.query(
      `INSERT INTO user_wallets (user_npub, wallet_type, encrypted_nwc_string, ln_address, api_identifier, api_subaccount_id, api_label)
       VALUES (?, 'nwc', ?, ?, NULL, NULL, NULL)
       ON CONFLICT(user_npub) DO UPDATE SET
         wallet_type = 'nwc',
         encrypted_nwc_string = excluded.encrypted_nwc_string,
         ln_address = excluded.ln_address,
         api_identifier = NULL,
         api_subaccount_id = NULL,
         api_label = NULL`
    ).run(npub, encrypted, lnAddress || null);
    console.log(`[identity] Saved wallet info for ${npub}`);
  } catch (e) {
    console.error('[identity] saveNwcWallet DB error:', e);
  }
}

function looksLikeNwcString(input: string): boolean {
  return /^nostr\+walletconnect:\/\//i.test(input.trim());
}

function promptWalletChoice(params: { gatewayUser: string; gateway: GatewayInfo; metaCtx: Record<string, unknown> }) {
  const message = [
    'Welcome to Beacon!',
    '',
    'I am the Beacon ID. I help you manage your wallet and approvals. The Beacon Brain will answer your questions and help you work with your money and get access to any information you need.',
    '',
    'Would you like to:',
    '(1) BYO Wallet w. Nostr Wallet Connect',
    '(2) Generate a new wallet?',
  ].join('\n');

  enqueueIdentityOut({
    to: params.gatewayUser,
    body: message,
    gateway: params.gateway,
    meta: { ctx: params.metaCtx },
  });
}

function parseWalletChoice(input: string): '1' | '2' | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '1' || normalized.startsWith('1)') || normalized.includes('wallet connect') || normalized.includes('nwc')) {
    return '1';
  }
  if (normalized === '2' || normalized.startsWith('2)') || normalized.includes('generate') || normalized.includes('new wallet')) {
    return '2';
  }
  return null;
}

function generateSubAccountLabel(gatewayType: GatewayType, gatewayUser: string, npub: string): string {
  const sanitizedUser = gatewayUser.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const suffix = (sanitizedUser.slice(-6) || npub.slice(-6)).toLowerCase();
  const label = `beacon-${gatewayType}-${suffix}`;
  return label.length > 32 ? label.slice(0, 32) : label;
}

function saveApiWallet(params: { npub: string; identifier: string; subAccountId: string; label: string }) {
  try {
    const db = getDB();
    db.query(
      `INSERT INTO user_wallets (user_npub, wallet_type, encrypted_nwc_string, ln_address, api_identifier, api_subaccount_id, api_label)
       VALUES (?, 'api', NULL, NULL, ?, ?, ?)
       ON CONFLICT(user_npub) DO UPDATE SET
         wallet_type = 'api',
         encrypted_nwc_string = NULL,
         ln_address = NULL,
         api_identifier = excluded.api_identifier,
         api_subaccount_id = excluded.api_subaccount_id,
         api_label = excluded.api_label`
    ).run(params.npub, params.identifier, params.subAccountId, params.label);
    console.log(`[identity] Saved API wallet info for ${params.npub}`);
  } catch (e) {
    console.error('[identity] saveApiWallet DB error:', e);
  }
}

async function handleOnboarding(msg: BeaconMessage, messageText: string) {
  const gatewayUser = msg.source.from;
  console.log(`[identity] Starting onboarding for ${gatewayUser}`);
  const ctx = (msg.meta?.ctx || {}) as Record<string, unknown>;
  let botIdFromCtx = ctx.botid ? String(ctx.botid) : undefined;
  const metaCtx = {
    networkID: msg.source.gateway.type,
    userId: gatewayUser,
    ...(ctx.returnGatewayID ? { returnGatewayID: String(ctx.returnGatewayID) } : {}),
    ...(botIdFromCtx ? { botid: botIdFromCtx } : {}),
  };
  botIdFromCtx = botIdFromCtx || ensureBotId(metaCtx, msg.source.gateway.type, gatewayUser);

  const normalizedInput = messageText.trim();

  async function finishOnboarding(npub: string) {
    onboardingState.delete(gatewayUser);
    await notifyBrainOfNewUser({
      gatewayType: msg.source.gateway.type,
      gatewayId: gatewayUser,
      npub,
    });
    const completionMessage = [
      "We've successfully created you a Lightning wallet and onboarded you to Bitcoin.",
      '',
      'The Beacon Brain will be in touch from another number. You can use the Brain to get access to any information and to ask for payments, invoices, etc from your wallet.',
      '',
      'No money can be spent by the Brain unless you approve it here first.',
      '',
      'We hope you have a great day!',
    ].join('\n');
    enqueueIdentityOut({
      to: gatewayUser,
      body: completionMessage,
      gateway: msg.source.gateway,
      meta: { ctx: metaCtx },
    });
    console.log(`[identity] Onboarding complete for ${gatewayUser}`);
  }

  async function handleGenerateWallet(state: OnboardingStep) {
    const label = generateSubAccountLabel(msg.source.gateway.type, gatewayUser, state.npub);
    try {
      console.log(`[identity] Creating API wallet for ${gatewayUser} with label ${label}`);
      const subAccount = await createSubAccount({
        label,
        description: `Beacon sub-account for ${msg.source.gateway.type}:${gatewayUser}`,
        metadata: { gatewayType: msg.source.gateway.type, gatewayUser, npub: state.npub },
      });
      saveApiWallet({
        npub: state.npub,
        identifier: subAccount.identifier,
        subAccountId: subAccount.id,
        label: subAccount.subAccount.label,
      });
      await finishOnboarding(state.npub);
    } catch (error) {
      console.error('[identity] Failed to generate API wallet', { error, gatewayUser });
      enqueueIdentityOut({
        to: gatewayUser,
        body: "Sorry, I couldn't create a wallet right now. Let's try that again.",
        gateway: msg.source.gateway,
        meta: { ctx: metaCtx },
      });
      onboardingState.set(gatewayUser, { step: 'awaiting_choice', npub: state.npub });
      promptWalletChoice({ gatewayUser, gateway: msg.source.gateway, metaCtx });
    }
  }

  async function handleNwcProvided(state: OnboardingStep, nwc: string) {
    const isValid = await validateNwcString(nwc);
    if (isValid) {
      saveNwcWallet(state.npub, nwc);
      onboardingState.set(gatewayUser, { step: 'awaiting_ln_address', npub: state.npub });
      enqueueIdentityOut({
        to: gatewayUser,
        body: "That all worked, please can you tell me your lightning address for this wallet? Or if it's not available just say No",
        gateway: msg.source.gateway,
        meta: { ctx: metaCtx },
      });
      console.log(`[identity] Onboarding step 2: Awaiting LN Address for ${gatewayUser}`);
    } else {
      enqueueIdentityOut({
        to: gatewayUser,
        body: "Hey that didn't work, please ensure it's a valid wallet connect string or reply 2 to generate a new wallet.",
        gateway: msg.source.gateway,
        meta: { ctx: metaCtx },
      });
      console.log(`[identity] Invalid NWC string received from ${gatewayUser}`);
    }
  }

  try {
    const state = onboardingState.get(gatewayUser);

    if (!state) {
      const npub = await createNewUser(msg.source.gateway.type, gatewayUser, botIdFromCtx);
      if (!npub) {
        enqueueIdentityOut({ to: gatewayUser, body: 'Sorry, there was an error creating your account. Please try again later.', gateway: msg.source.gateway, meta: { ctx: metaCtx } });
        return;
      }
      const initialState: OnboardingStep = { step: 'awaiting_choice', npub };
      onboardingState.set(gatewayUser, initialState);
      promptWalletChoice({ gatewayUser, gateway: msg.source.gateway, metaCtx });
      console.log(`[identity] Onboarding step 0: Awaiting wallet preference for ${gatewayUser}`);
      return;
    }

    if (state.step === 'awaiting_choice') {
      if (looksLikeNwcString(normalizedInput)) {
        await handleNwcProvided(state, normalizedInput);
        return;
      }
      const choice = parseWalletChoice(normalizedInput);
      if (choice === '1') {
        onboardingState.set(gatewayUser, { step: 'awaiting_nwc', npub: state.npub });
        enqueueIdentityOut({
          to: gatewayUser,
          body: "Alright, let's set up your Bitcoin wallet. Please respond with a nostr wallet connect string and I'll do the rest.",
          gateway: msg.source.gateway,
          meta: { ctx: metaCtx },
        });
        console.log(`[identity] Onboarding step 1: Awaiting NWC for ${gatewayUser}`);
        return;
      }
      if (choice === '2') {
        await handleGenerateWallet(state);
        return;
      }
      promptWalletChoice({ gatewayUser, gateway: msg.source.gateway, metaCtx });
      return;
    }

    if (state.step === 'awaiting_nwc') {
      if (looksLikeNwcString(normalizedInput)) {
        await handleNwcProvided(state, normalizedInput);
        return;
      }
      const choice = parseWalletChoice(normalizedInput);
      if (choice === '2') {
        await handleGenerateWallet(state);
        return;
      }
      enqueueIdentityOut({
        to: gatewayUser,
        body: "I'm still waiting on a valid wallet connect string. You can also reply 2 to generate a new wallet.",
        gateway: msg.source.gateway,
        meta: { ctx: metaCtx },
      });
      return;
    }

    if (state.step === 'awaiting_ln_address') {
      const lnAddress = normalizedInput.toLowerCase() === 'no' ? null : normalizedInput;
      getDB().query(`UPDATE user_wallets SET ln_address = ? WHERE user_npub = ?`).run(lnAddress, state.npub);
      console.log(`[identity] Updated LN Address for ${state.npub}`);
      await finishOnboarding(state.npub);
      return;
    }
  } catch (e) {
    console.error('[identity] CRITICAL ERROR in handleOnboarding:', e);
    enqueueIdentityOut({ to: gatewayUser, body: 'Sorry, a critical error occurred during onboarding. Please start over.', gateway: msg.source.gateway, meta: { ctx: metaCtx } });
    onboardingState.delete(gatewayUser);
  }
}

export function startIdentityWorker() {
  consumeIdentityBeacon(async (msg) => {
    try {
      const gatewayUser = msg.source.from;
      console.log(`[identity] worker received message from: ${gatewayUser}, beaconID: ${msg.beaconID}`);

      const messageText = (msg.source.text || '').trim();
      if (!messageText) return;

      const ctx = (msg.meta?.ctx || {}) as Record<string, unknown>;
      const botId = ctx.botid ? String(ctx.botid) : '';
      if (botId) {
        const gatewayInfo = msg.source.gateway;
        const gatewayNpub = gatewayInfo?.npub || getEnv('GATEWAY_NPUB', '');
        if (gatewayInfo?.type && gatewayNpub) {
          rememberGatewayBotId(gatewayInfo.type, gatewayNpub, gatewayUser, botId);
        }
      }

      // --- Onboarding Flow ---
      if (!isUserKnown(gatewayUser, msg.source.gateway.type) || onboardingState.has(gatewayUser)) {
        await handleOnboarding(msg, messageText);
        return;
      }

      // --- Payment Confirmation Flow ---
      if (messageText.toLowerCase() === 'yes') {
        console.log(`[identity] Received 'YES' confirmation from ${gatewayUser}.`);
        const pendingPayment = retrieveAndClearConfirmation(gatewayUser);

        if (pendingPayment) {
          console.log(`[identity] Found pending payment for ${gatewayUser}. Processing...`);
          const result = await makePayment(pendingPayment);

          const ctx = (msg.meta?.ctx || {}) as Record<string, unknown>;
          const metaCtx = {
            networkID: msg.source.gateway.type,
            userId: gatewayUser,
            ...(ctx.returnGatewayID ? { returnGatewayID: String(ctx.returnGatewayID) } : {}),
            ...(ctx.botid ? { botid: String(ctx.botid) } : {}),
          };
          ensureBotId(metaCtx, msg.source.gateway.type, gatewayUser);
          if (result.success) {
            let confirmationText = 'Payment confirmed!';
            if (result.receipt) {
              confirmationText += ` Your receipt is: ${result.receipt}`;
            }
            try {
              const balance = await getBalance(pendingPayment.npub);
              if (balance.success && typeof balance.balance === 'number') {
                confirmationText += ` Your new balance is ${balance.balance} sats.`;
              }
            } catch (balanceError) {
              console.error('[identity] Failed to fetch balance after payment', balanceError);
            }
            enqueueIdentityOut({ to: gatewayUser, body: confirmationText, gateway: msg.source.gateway, meta: { ctx: metaCtx } });
            const confirmationSummary = result.receipt
              ? `Successful payment. Receipt: ${result.receipt}`
              : 'Successful payment.';
            await sendPaymentConfirmation('paid', confirmationSummary, pendingPayment);
          } else {
            enqueueIdentityOut({ to: gatewayUser, body: `Payment failed: ${result.error}`, gateway: msg.source.gateway, meta: { ctx: metaCtx } });
            await sendPaymentConfirmation('rejected', result.error || 'Payment failed', pendingPayment);
          }
        } else {
          console.log(`[identity] No pending payment found for ${gatewayUser}. Ignoring 'YES'.`);
        }
        return;
      }
      
      // If user is known but there's no 'YES', we can add more commands here later.
      console.log(`[identity] No handler for known user message: "${messageText}"`);

    } catch (e) {
      console.error('[identity] CRITICAL ERROR in consumeIdentityBeacon:', e);
    }
  });
  console.log('[identity] worker started');
}
