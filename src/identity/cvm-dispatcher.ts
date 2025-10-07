import { consumeIdentityOut } from './queues';
import type { GatewayOutData } from '../types';
import { getEnv } from '../types';
import { GatewayCvmClient, type ReceiveMessageRequest } from '../gateway/cvm/client';

/**
 * Dispatches Identity outbound messages to remote gateways via Context VM.
 * Requires env `ID_RETURN_GATEWAY_ID` (hex pubkey of the remote gateway CVM server)
 * and `IDENTITY_CVM_PRIVATE_KEY` (signing key for this client).
 */
export function startIdentityCvmDispatcher() {
  const defaultReturnGateway = (getEnv('ID_RETURN_GATEWAY_ID') || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(defaultReturnGateway)) {
    console.warn('[identity-cvm-dispatch] missing/invalid ID_RETURN_GATEWAY_ID; dispatcher will still start but messages will fail to send');
  }

  consumeIdentityOut(async (msg: GatewayOutData) => {
    try {
      const ctx = (msg.meta?.ctx || {}) as Record<string, unknown>;
      const returnGatewayID = String(ctx.returnGatewayID || defaultReturnGateway || '');
      if (!/^[0-9a-fA-F]{64}$/.test(returnGatewayID)) {
        console.error('[identity-cvm-dispatch] missing/invalid returnGatewayID for message', { to: msg.to });
        return;
      }

      const networkID = String(ctx.networkID || msg.gateway?.type || '');
      if (!networkID) {
        console.error('[identity-cvm-dispatch] missing networkID', { to: msg.to });
        return;
      }

      const userId = String(ctx.userId || msg.to || '');
      if (!userId) {
        console.error('[identity-cvm-dispatch] missing userId');
        return;
      }

      const req: ReceiveMessageRequest = {
        refId: String(msg.deliveryId || msg.messageId || Date.now().toString()),
        returnGatewayID,
        networkID,
        botid: String((ctx as any).botid || ''),
        botType: 'id',
        groupID: (ctx.groupID as string | undefined) || undefined,
        userId,
        messageID: msg.quotedMessageId || undefined,
        message: String(msg.body || ''),
      };

      const client = new GatewayCvmClient(returnGatewayID);
      console.log('[identity-cvm-dispatch] receiveMessage ->', { target: returnGatewayID.slice(0,8) + '…', to: userId });
      const res = await client.receiveMessage(req);
      console.log('[identity-cvm-dispatch] dispatched', { to: userId, status: res?.status });
    } catch (err) {
      console.error('[identity-cvm-dispatch] error', err);
    }
  });
}
