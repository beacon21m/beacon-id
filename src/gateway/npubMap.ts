import { getDB } from '../db';
import type { GatewayType } from '../types';

export function resolveUserNpub(
  gatewayType: GatewayType,
  gatewayNpub: string,
  gatewayUser: string,
): string | undefined {
  try {
    const db = getDB();
    const row = db
      .query(
        `SELECT user_npub FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user = ?`
      )
      .get(gatewayType, gatewayNpub, gatewayUser) as any;
    return row?.user_npub || undefined;
  } catch {
    return undefined;
  }
}

export interface UserLinkRecord {
  userNpub: string;
  beaconBrainNpub?: string;
  beaconIdNpub?: string;
  gatewayBotId?: string;
}

/**
 * Returns the full mapping record for a given gateway triple, including
 * optional per-user links to remote services.
 */
export function resolveUserLinks(
  gatewayType: GatewayType,
  gatewayNpub: string,
  gatewayUser: string,
): UserLinkRecord | undefined {
  try {
    const db = getDB();
    const row = db
      .query(
        `SELECT user_npub, beacon_brain_npub, beacon_id_npub, gateway_bot_id
         FROM local_npub_map
         WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user = ?`
      )
      .get(gatewayType, gatewayNpub, gatewayUser) as any;
    if (!row) return undefined;
    return {
      userNpub: row.user_npub,
      beaconBrainNpub: row.beacon_brain_npub || undefined,
      beaconIdNpub: row.beacon_id_npub || undefined,
      gatewayBotId: row.gateway_bot_id || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Fallback resolver: try to find a mapping by gateway_user only,
 * ignoring gateway npub/type. Useful when environments change npub
 * or when legacy mappings exist.
 */
export function resolveUserNpubLoose(gatewayUser: string): string | undefined {
  try {
    const db = getDB();
    const row = db
      .query(
        `SELECT user_npub FROM local_npub_map WHERE gateway_user = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(gatewayUser) as any;
    return row?.user_npub || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Insert or update a local mapping row linking a gateway user to a user npub.
 */
export function upsertLocalNpubMap(
  gatewayType: GatewayType,
  gatewayNpub: string,
  gatewayUser: string,
  userNpub: string,
  options?: { beaconBrainNpub?: string | null; beaconIdNpub?: string | null; gatewayBotId?: string | null }
): void {
  const db = getDB();
  const stmt = db.query(`
    INSERT INTO local_npub_map (
      gateway_type, gateway_npub, gateway_user, user_npub, beacon_brain_npub, beacon_id_npub, gateway_bot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(gateway_type, gateway_npub, gateway_user) DO UPDATE SET
      user_npub = excluded.user_npub,
      beacon_brain_npub = COALESCE(excluded.beacon_brain_npub, local_npub_map.beacon_brain_npub),
      beacon_id_npub = COALESCE(excluded.beacon_id_npub, local_npub_map.beacon_id_npub),
      gateway_bot_id = COALESCE(NULLIF(TRIM(excluded.gateway_bot_id), ''), local_npub_map.gateway_bot_id)
  `);
  stmt.run(
    gatewayType,
    gatewayNpub,
    gatewayUser,
    userNpub,
    options?.beaconBrainNpub ?? null,
    options?.beaconIdNpub ?? null,
    options?.gatewayBotId ?? null,
  );
}

/**
 * Persist a bot identifier for an existing gateway mapping when provided by upstream payloads.
 */
export function rememberGatewayBotId(
  gatewayType: GatewayType,
  gatewayNpub: string,
  gatewayUser: string,
  gatewayBotId: string | null | undefined
): void {
  const normalized = (gatewayBotId || '').trim();
  if (!normalized) return;
  const db = getDB();
  db
    .query(`
      UPDATE local_npub_map
        SET gateway_bot_id = ?
        WHERE gateway_type = ?
          AND gateway_npub = ?
          AND gateway_user = ?
          AND (gateway_bot_id IS NULL OR TRIM(gateway_bot_id) = '' OR gateway_bot_id != ?)
    `)
    .run(normalized, gatewayType, gatewayNpub, gatewayUser, normalized);
}
