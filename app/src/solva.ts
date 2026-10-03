// Client cho chương trình Solva: mã hóa lệnh (Anchor/Borsh) và giải mã tài khoản.
// Viết tay để không phụ thuộc IDL; layout khớp programs/solva/src/lib.rs.
import { Buffer } from 'buffer';
import {
  PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, type AccountMeta,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from './config';

export const PROGRAM_ID = new PublicKey(config.programId);

// sha256("global:<tên lệnh>")[0..8]
const IX = {
  create_escrow: [253, 215, 165, 116, 36, 108, 68, 80],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  record_checkin: [118, 204, 183, 163, 118, 202, 223, 127],
  confirm_milestone: [236, 44, 53, 130, 120, 214, 40, 73],
  trigger_termination: [151, 167, 182, 40, 240, 114, 224, 61],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  // Không tồn tại trong chương trình: dùng để chứng minh không có lệnh đóng băng.
  freeze_escrow: [100, 4, 61, 102, 0, 123, 141, 187],
} as const;
// sha256("account:<Tên>")[0..8]
const ACC = {
  Escrow: [31, 213, 123, 187, 186, 22, 218, 155],
  Facility: [16, 190, 236, 249, 84, 151, 160, 37],
};

export const STATUS = ['Khởi tạo', 'Đang thực hiện', 'Kết thúc'] as const;
export const REASON = ['', 'Hoàn thành', 'Cơ sở ngừng phục vụ', 'Hết hạn'] as const;

export const ERRORS: Record<number, string> = {
  101: 'Lệnh không tồn tại trong chương trình',
  3010: 'Thiếu chữ ký bắt buộc',
  6000: 'Tham số hợp đồng không hợp lệ',
  6001: 'Trạng thái hợp đồng không cho phép thao tác này',
  6002: 'Cơ sở đã bị xác định ngừng phục vụ',
  6003: 'Chữ ký cơ sở không khớp với hợp đồng',
  6004: 'Mốc chưa tới hạn',
  6005: 'Chưa đủ lượt check-in làm bằng chứng',
  6006: 'Đã xác nhận đủ số mốc',
  6007: 'Cơ sở vẫn đang phục vụ',
  6008: 'Người ký không sở hữu phần tiền nào trong vault',
  6009: 'Vượt phần được phép rút',
  6010: 'Không còn phần nào để rút',
  6011: 'Tài khoản nhận không thuộc về người ký',
  6012: 'Hợp đồng đang thực hiện: phần của khách chưa mở',
  6013: 'Tài khoản nhận phí không khớp điều khoản',
  6014: 'Tràn số',
};

class Writer {
  private parts: Uint8Array[] = [];
  raw(b: ArrayLike<number>) { this.parts.push(Uint8Array.from(b)); return this; }
  private num(bytes: number, set: (v: DataView) => void) { const b = new Uint8Array(bytes); set(new DataView(b.buffer)); this.parts.push(b); return this; }
  u8(v: number) { return this.num(1, d => d.setUint8(0, v)); }
  u16(v: number) { return this.num(2, d => d.setUint16(0, v, true)); }
  u32(v: number) { return this.num(4, d => d.setUint32(0, v, true)); }
  u64(v: bigint) { return this.num(8, d => d.setBigUint64(0, v, true)); }
  i64(v: bigint) { return this.num(8, d => d.setBigInt64(0, v, true)); }
  done() { return Buffer.concat(this.parts.map(p => Buffer.from(p))); }
}

class Reader {
  private o = 0;
  private d: DataView;
  constructor(private b: Uint8Array) { this.d = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  skip(n: number) { this.o += n; return this; }
  u8() { return this.d.getUint8(this.o++); }
  u16() { const v = this.d.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.d.getUint32(this.o, true); this.o += 4; return v; }
  u64() { const v = this.d.getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { const v = this.d.getBigInt64(this.o, true); this.o += 8; return v; }
  key() { const k = new PublicKey(this.b.slice(this.o, this.o + 32)); this.o += 32; return k; }
  bool() { return this.u8() !== 0; }
}

export const u64le = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };

export function facilityPda(facilityAuth: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('facility'), facilityAuth.toBuffer()], PROGRAM_ID)[0];
}
export function escrowPda(buyer: PublicKey, facilityAuth: PublicKey, nonce: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), buyer.toBuffer(), facilityAuth.toBuffer(), Buffer.from(u64le(nonce))], PROGRAM_ID)[0];
}
export function vaultPda(escrow: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), escrow.toBuffer()], PROGRAM_ID)[0];
}

export interface EscrowParams {
  nonce: bigint; amount: bigint; upfrontBps: number; feeBps: number; periods: number;
  periodSecs: bigint; minCheckinsPerPeriod: number; closureSecs: bigint; minContracts: number;
}

const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
const ix = (keys: AccountMeta[], data: Buffer) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

export function createEscrowIx(a: { buyer: PublicKey; facilityAuth: PublicKey; mint: PublicKey; feeRecipient: PublicKey; params: EscrowParams }) {
  const escrow = escrowPda(a.buyer, a.facilityAuth, a.params.nonce);
  const p = a.params;
  const data = new Writer().raw(IX.create_escrow)
    .u64(p.nonce).u64(p.amount).u16(p.upfrontBps).u16(p.feeBps).u8(p.periods)
    .i64(p.periodSecs).u32(p.minCheckinsPerPeriod).i64(p.closureSecs).u32(p.minContracts).done();
  return ix([
    m(a.buyer, true, true),
    m(a.facilityAuth, true, false),
    m(facilityPda(a.facilityAuth), false, true),
    m(escrow, false, true),
    m(vaultPda(escrow), false, true),
    m(a.mint, false, false),
    m(a.feeRecipient, false, false),
    m(TOKEN_PROGRAM_ID, false, false),
    m(SystemProgram.programId, false, false),
    m(SYSVAR_RENT_PUBKEY, false, false),
  ], data);
}

export function depositIx(a: { buyer: PublicKey; escrow: PublicKey; facilityAuth: PublicKey; buyerToken: PublicKey }) {
  return ix([
    m(a.buyer, true, false),
    m(a.escrow, false, true),
    m(facilityPda(a.facilityAuth), false, true),
    m(vaultPda(a.escrow), false, true),
    m(a.buyerToken, false, true),
    m(TOKEN_PROGRAM_ID, false, false),
  ], new Writer().raw(IX.deposit).done());
}

/** buyerSigns = false tạo lệnh check-in thiếu chữ ký khách (để chứng minh bị từ chối). */
export function checkinIx(a: { buyer: PublicKey; facilityAuth: PublicKey; escrow: PublicKey; buyerSigns?: boolean }) {
  return ix([
    m(a.buyer, a.buyerSigns !== false, false),
    m(a.facilityAuth, true, false),
    m(a.escrow, false, true),
    m(facilityPda(a.facilityAuth), false, true),
  ], new Writer().raw(IX.record_checkin).done());
}

export function confirmMilestoneIx(a: { escrow: PublicKey; facilityAuth: PublicKey }) {
  return ix([m(a.escrow, false, true), m(facilityPda(a.facilityAuth), false, true)], new Writer().raw(IX.confirm_milestone).done());
}

export function triggerTerminationIx(a: { escrow: PublicKey; facilityAuth: PublicKey }) {
  return ix([m(a.escrow, false, true), m(facilityPda(a.facilityAuth), false, true)], new Writer().raw(IX.trigger_termination).done());
}

export function withdrawIx(a: { caller: PublicKey; escrow: PublicKey; destination: PublicKey; feeRecipient: PublicKey; amount?: bigint | null }) {
  const w = new Writer().raw(IX.withdraw);
  if (a.amount == null) w.u8(0); else w.u8(1).u64(a.amount);
  return ix([
    m(a.caller, true, false),
    m(a.escrow, false, true),
    m(vaultPda(a.escrow), false, true),
    m(a.destination, false, true),
    m(a.feeRecipient, false, true),
    m(TOKEN_PROGRAM_ID, false, false),
  ], w.done());
}

export function freezeIx(a: { caller: PublicKey; escrow: PublicKey }) {
  return ix([m(a.caller, true, false), m(a.escrow, false, true)], new Writer().raw(IX.freeze_escrow).done());
}

export interface EscrowAccount {
  buyer: PublicKey; facility: PublicKey; mint: PublicKey; feeRecipient: PublicKey;
  nonce: bigint; amount: bigint; upfrontBps: number; feeBps: number; periods: number; periodSecs: bigint;
  minCheckinsPerPeriod: number; status: number; reason: number; startTs: bigint; confirmed: number;
  released: bigint; facWithdrawn: bigint; buyerWithdrawn: bigint; facilityCheckinsSnapshot: bigint;
  checkins: number; lastCheckinTs: bigint;
}
export interface FacilityAccount {
  authority: PublicKey; activeContracts: number; minContracts: number; checkinCount: bigint;
  lastCheckinTs: bigint; closureSecs: bigint; createdTs: bigint; closed: boolean;
}

function checkDisc(data: Uint8Array, disc: number[], name: string) {
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) throw new Error(`Không phải tài khoản ${name}`);
}

export function decodeEscrow(data: Uint8Array): EscrowAccount {
  checkDisc(data, ACC.Escrow, 'Escrow');
  const r = new Reader(data).skip(8);
  return {
    buyer: r.key(), facility: r.key(), mint: r.key(), feeRecipient: r.key(),
    nonce: r.u64(), amount: r.u64(), upfrontBps: r.u16(), feeBps: r.u16(), periods: r.u8(),
    periodSecs: r.i64(), minCheckinsPerPeriod: r.u32(), status: r.u8(), reason: r.u8(), startTs: r.i64(),
    confirmed: r.u8(), released: r.u64(), facWithdrawn: r.u64(), buyerWithdrawn: r.u64(),
    facilityCheckinsSnapshot: r.u64(), checkins: r.u32(), lastCheckinTs: r.i64(),
  };
}

export function decodeFacility(data: Uint8Array): FacilityAccount {
  checkDisc(data, ACC.Facility, 'Facility');
  const r = new Reader(data).skip(8);
  return {
    authority: r.key(), activeContracts: r.u32(), minContracts: r.u32(), checkinCount: r.u64(),
    lastCheckinTs: r.i64(), closureSecs: r.i64(), createdTs: r.i64(), closed: r.bool(),
  };
}

/** Rút mã lỗi Anchor từ nhật ký giao dịch. */
export function parseError(logs: string[] | null | undefined, err: unknown): { code?: number; text: string } {
  const line = (logs || []).find(l => l.includes('AnchorError') || l.includes('Error Number'));
  if (line) {
    const num = /Error Number: (\d+)/.exec(line)?.[1];
    const name = /Error Code: (\w+)/.exec(line)?.[1];
    const code = num ? Number(num) : undefined;
    return { code, text: `${name ?? 'Lỗi'} (${num}): ${code != null && ERRORS[code] ? ERRORS[code] : ''}` };
  }
  const custom = /"Custom":(\d+)/.exec(JSON.stringify(err ?? ''))?.[1];
  if (custom) { const c = Number(custom); return { code: c, text: `Mã ${c}: ${ERRORS[c] ?? ''}` }; }
  return { text: typeof err === 'string' ? err : JSON.stringify(err) };
}
