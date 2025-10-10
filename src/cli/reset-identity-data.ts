#!/usr/bin/env bun
// CLI helper to wipe Identity-related local data tables in one run.

import { getDB } from '../db';

async function confirmDanger(): Promise<boolean> {
  if (process.argv.includes('--force')) return true;

  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question('This will DELETE all records from user_wallets, local_npub_map, and nicknames. Type YES to continue: ', (v) => resolve(String(v ?? '')));
  });
  rl.close();
  return answer.trim().toUpperCase() === 'YES';
}

function deleteTable(db: ReturnType<typeof getDB>, table: string): number {
  const countRow = db.query(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number } | undefined;
  db.exec(`DELETE FROM ${table};`);
  return countRow?.count ?? 0;
}

async function main() {
  const ok = await confirmDanger();
  if (!ok) {
    console.log('Aborted. No changes made.');
    return;
  }

  const db = getDB();
  db.exec('BEGIN;');
  try {
    const cleared = {
      user_wallets: deleteTable(db, 'user_wallets'),
      local_npub_map: deleteTable(db, 'local_npub_map'),
      nicknames: deleteTable(db, 'nicknames'),
    };
    db.exec('COMMIT;');
    console.log('Identity data cleared:', cleared);
  } catch (err) {
    db.exec('ROLLBACK;');
    console.error('Failed to clear identity data:', err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Unexpected failure:', err);
  process.exitCode = 1;
});
