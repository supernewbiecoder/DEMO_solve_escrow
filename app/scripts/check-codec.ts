// Kiểm tra bộ mã hóa/giải mã frontend với dữ liệu thật do test Rust ghi ra.
//   cargo test -p solva --test flow   (tạo target/layout-sample.json)
//   npx tsx scripts/check-codec.ts
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import * as S from '../src/solva';

const j = JSON.parse(readFileSync(new URL('../../target/layout-sample.json', import.meta.url), 'utf8'));
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
let fails = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  const ok = String(a) === String(b);
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'SAI '} ${name}: ${a} ${ok ? '' : `≠ ${b}`}`);
};

const e = S.decodeEscrow(hex(j.escrow));
const x = j.expect;
eq('buyer', e.buyer.toBase58(), x.buyer);
eq('amount', e.amount, x.amount);
eq('released', e.released, x.released);
eq('facWithdrawn', e.facWithdrawn, x.facWithdrawn);
eq('buyerWithdrawn', e.buyerWithdrawn, x.buyerWithdrawn);
eq('confirmed', e.confirmed, x.confirmed);
eq('checkins', e.checkins, x.checkins);
eq('status', e.status, x.status);
eq('reason', e.reason, x.reason);
eq('startTs', e.startTs, x.startTs);
eq('lastCheckinTs', e.lastCheckinTs, x.lastCheckinTs);
const f = S.decodeFacility(hex(j.facility));
eq('facility.checkinCount', f.checkinCount, x.facCheckins);
eq('facility.lastCheckinTs', f.lastCheckinTs, x.facLast);
eq('facility.closed', f.closed, x.closed);
eq('facility.activeContracts', f.activeContracts, x.active);

const k = PublicKey.default;
const create = S.createEscrowIx({ buyer: k, facilityAuth: k, mint: k, feeRecipient: k, params: {
  nonce: 42n, amount: 384_615_384n, upfrontBps: 2000, feeBps: 75, periods: 12, periodSecs: 60n,
  minCheckinsPerPeriod: 1, closureSecs: 120n, minContracts: 1 } });
eq('create_escrow data', Buffer.from(create.data).toString('hex'), j.createData);
const w = S.withdrawIx({ caller: k, escrow: k, destination: k, feeRecipient: k, amount: 123n });
eq('withdraw data', Buffer.from(w.data).toString('hex'), j.withdrawData);
if (fails) { console.error(`${fails} trường không khớp`); process.exit(1); }
console.log('Bộ mã hóa frontend khớp với chương trình.');
