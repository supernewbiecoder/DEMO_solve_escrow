import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction, type AccountInfo, type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { Buffer } from 'buffer';
import { config, configured, DEMO, explorerAddr, explorerTx } from './config';
import * as S from './solva';

/* ------------------------------------------------------------------ helpers */

type Actor = 'Khách' | 'Quầy' | 'Solva' | 'Hội viên khác' | 'Chuẩn bị';
interface Entry {
  id: number; label: string; actor: Actor; signers: string[];
  status: 'pending' | 'ok' | 'fail'; sig?: string; error?: string; logs?: string[];
}
interface Toast { id: number; kind: 'ok' | 'bad'; title: string; sub?: string }
interface DemoState { counter: number[]; operator: number[]; members: number[][]; nonce?: string; prepared?: boolean; closed?: boolean }
interface Snap {
  sol: number; counterSol: number; operatorSol: number;
  usdc: bigint; facUsdc: bigint; treasuryUsdc: bigint; opUsdc: bigint;
  escrow?: S.EscrowAccount; vault?: bigint; facility?: S.FacilityAccount; chainNow: number;
}

const MINT = configured ? new PublicKey(config.mint) : PublicKey.default;
const TREASURY = configured ? new PublicKey(config.treasuryAta) : PublicKey.default;
const FAUCET = configured ? Keypair.fromSecretKey(Uint8Array.from(config.faucetSecret)) : Keypair.generate();
const PRICE = BigInt(Math.floor((DEMO.priceVnd / DEMO.rateVnd) * 1e6));
const MEMBERS = [{ name: 'Hải Yến', vnd: 6_000_000 }, { name: 'Quốc Bảo', vnd: 8_000_000 }];
const MEMBER_NONCE = 1n;
const STORE = `solva.demo.${config.cluster}.${config.programId}`;

const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner, true);
const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));
const fresh = (): DemoState => ({
  counter: Array.from(Keypair.generate().secretKey),
  operator: Array.from(Keypair.generate().secretKey),
  members: MEMBERS.map(() => Array.from(Keypair.generate().secretKey)),
});
function load(): DemoState {
  try { const s = localStorage.getItem(STORE); if (s) return JSON.parse(s); } catch { /* bộ nhớ trình duyệt bị chặn */ }
  return fresh();
}
function save(d: DemoState) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* bỏ qua */ } }

const vnd = (u: bigint | undefined) => `${Math.round((Number(u ?? 0n) / 1e6) * DEMO.rateVnd).toLocaleString('vi-VN')} đ`;
const usdc = (u: bigint | undefined) => `${(Number(u ?? 0n) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const tokenAmount = (i: AccountInfo<Buffer> | null) =>
  i && i.data.length >= 72 ? new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(64, true) : 0n;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isRateLimit = (e: unknown) => /429|rate limit|Too Many Requests|fetch failed|Failed to fetch|NetworkError/i.test(errText(e));
/** Gọi RPC, tự thử lại khi RPC công cộng trả 429 hoặc rớt mạng (chờ 1, 2, 4, 8 giây...). */
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let wait = 1000;
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !isRateLimit(e)) throw e;
      await sleep(wait); wait = Math.min(wait * 2, 8000);
    }
  }
}
const lamportsOf = (i: AccountInfo<Buffer> | null) => (i ? i.lamports : 0);
const clockTs = (i: AccountInfo<Buffer> | null) =>
  i && i.data.length >= 40 ? Number(new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigInt64(32, true)) : null;

/* ------------------------------------------------------------------ app */

export default function App() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [demo, setDemo] = useState<DemoState>(load);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const seq = useRef(0);
  const clockOffset = useRef(0);

  const counter = useMemo(() => kp(demo.counter), [demo.counter]);
  const operator = useMemo(() => kp(demo.operator), [demo.operator]);
  const members = useMemo(() => demo.members.map(kp), [demo.members]);
  const facilityAddr = useMemo(() => S.facilityPda(counter.publicKey), [counter]);
  const escrowAddr = useMemo(
    () => (publicKey && demo.nonce ? S.escrowPda(publicKey, counter.publicKey, BigInt(demo.nonce)) : null),
    [publicKey, counter, demo.nonce]);

  const update = useCallback((d: Partial<DemoState>) => setDemo(prev => { const n = { ...prev, ...d }; save(n); return n; }), []);
  useEffect(() => save(demo), []); // eslint-disable-line react-hooks/exhaustive-deps

  const toast = useCallback((kind: Toast['kind'], title: string, sub?: string) => {
    const id = ++seq.current;
    setToasts(t => [{ id, kind, title, sub }, ...t].slice(0, 3));
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  const nameOf = useCallback((pk: PublicKey) => {
    if (publicKey && pk.equals(publicKey)) return 'Khách (Phantom)';
    if (pk.equals(counter.publicKey)) return 'Quầy An Khang';
    if (pk.equals(operator.publicKey)) return 'Ví vận hành Solva';
    if (pk.equals(FAUCET.publicKey)) return 'Vòi USDC thử nghiệm';
    const i = members.findIndex(m => m.publicKey.equals(pk));
    return i >= 0 ? `Hội viên ${MEMBERS[i].name}` : short(pk.toBase58());
  }, [publicKey, counter, operator, members]);

  /* ---------- read chain ---------- */
  const refresh = useCallback(async () => {
    if (!publicKey || !configured) return;
    try {
      const vault = escrowAddr ? S.vaultPda(escrowAddr) : PublicKey.default;
      // Một request duy nhất cho mọi thứ cần hiển thị, kể cả số dư SOL và đồng hồ của chuỗi.
      const keys = [ata(publicKey), ata(counter.publicKey), TREASURY, ata(operator.publicKey), facilityAddr,
        escrowAddr ?? PublicKey.default, vault, publicKey, counter.publicKey, operator.publicKey, SYSVAR_CLOCK_PUBKEY];
      const infos = await withRetry(() => connection.getMultipleAccountsInfo(keys), 3);
      const sol = lamportsOf(infos[7]), cs = lamportsOf(infos[8]), os = lamportsOf(infos[9]);
      const bt = clockTs(infos[10]);
      if (bt) clockOffset.current = bt - Date.now() / 1000;
      let escrow: S.EscrowAccount | undefined; let facility: S.FacilityAccount | undefined;
      try { if (infos[5]) escrow = S.decodeEscrow(infos[5].data); } catch { /* chưa có */ }
      try { if (infos[4]) facility = S.decodeFacility(infos[4].data); } catch { /* chưa có */ }
      setSnap({
        sol: sol / LAMPORTS_PER_SOL, counterSol: cs / LAMPORTS_PER_SOL, operatorSol: os / LAMPORTS_PER_SOL,
        usdc: tokenAmount(infos[0]), facUsdc: tokenAmount(infos[1]), treasuryUsdc: tokenAmount(infos[2]), opUsdc: tokenAmount(infos[3]),
        facility, escrow, vault: infos[6] ? tokenAmount(infos[6]) : undefined,
        chainNow: Date.now() / 1000 + clockOffset.current,
      });
    } catch (e) { console.warn('refresh', e); }
  }, [publicKey, connection, counter, operator, facilityAddr, escrowAddr]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000 + clockOffset.current), 1000); return () => clearInterval(t); }, []);

  /* ---------- send ---------- */
  const send = useCallback(async (
    label: string, actor: Actor, ixs: TransactionInstruction[],
    opts: { wallet?: boolean; feePayer?: Keypair; signers?: Keypair[]; quiet?: boolean },
  ): Promise<boolean> => {
    const id = ++seq.current;
    const tx = new Transaction().add(...ixs);
    const signerKeys: PublicKey[] = [];
    const payer = opts.wallet ? publicKey : opts.feePayer?.publicKey;
    if (payer) signerKeys.push(payer);
    (opts.signers ?? []).forEach(k => { if (!signerKeys.some(p => p.equals(k.publicKey))) signerKeys.push(k.publicKey); });
    setLedger(l => [{ id, label, actor, status: 'pending' as const, signers: signerKeys.map(nameOf) }, ...l].slice(0, 80));
    const patch = (p: Partial<Entry>) => setLedger(l => l.map(e => (e.id === id ? { ...e, ...p } : e)));
    try {
      const { blockhash } = await withRetry(() => connection.getLatestBlockhash('confirmed'));
      tx.recentBlockhash = blockhash;
      let raw: Buffer;
      if (opts.wallet) {
        if (!publicKey || !signTransaction) throw new Error('Chưa kết nối ví Phantom');
        tx.feePayer = publicKey;
        if (opts.signers?.length) tx.partialSign(...opts.signers);
        raw = (await signTransaction(tx)).serialize();
      } else {
        const fp = opts.feePayer!;
        tx.feePayer = fp.publicKey;
        tx.sign(fp, ...(opts.signers ?? []).filter(k => !k.publicKey.equals(fp.publicKey)));
        raw = tx.serialize();
      }
      // skipPreflight: giao dịch bị từ chối vẫn được ghi lên chuỗi, có hash để tra trên Explorer.
      const sig = await withRetry(() => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }));
      patch({ sig });
      // Tự hỏi trạng thái mỗi 1,5 giây (không dùng websocket), tối đa 75 giây.
      let txErr: unknown = undefined; let landed = false;
      for (let i = 0; i < 50 && !landed; i++) {
        await sleep(1500);
        const st = await withRetry(() => connection.getSignatureStatuses([sig])).catch(() => null);
        const v = st?.value?.[0];
        if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) { landed = true; txErr = v.err; }
      }
      if (!landed) throw new Error('Mạng chưa xác nhận giao dịch sau 75 giây. Mở Explorer để kiểm tra rồi thử lại.');
      let logs: string[] | undefined;
      for (let i = 0; i < 4 && !logs; i++) {
        const t = await withRetry(() => connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).catch(() => null);
        logs = t?.meta?.logMessages ?? undefined;
        if (!logs) await sleep(1200);
      }
      if (txErr) {
        const pe = S.parseError(logs, txErr);
        patch({ status: 'fail', error: pe.text, logs });
        if (!opts.quiet) toast('bad', `${label}: bị chương trình từ chối`, pe.text);
        refresh();
        return false;
      }
      patch({ status: 'ok', logs });
      if (!opts.quiet) toast('ok', label, 'Giao dịch đã được xác nhận trên chuỗi');
      refresh();
      return true;
    } catch (e) {
      patch({ status: 'fail', error: errText(e) });
      if (!opts.quiet) toast('bad', label, errText(e));
      return false;
    }
  }, [connection, publicKey, signTransaction, nameOf, toast, refresh]);

  const run = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    try { await fn(); } finally { setBusy(null); }
  }, [busy]);

  /* ---------- actions ---------- */
  const params = (nonce: bigint, amount: bigint): S.EscrowParams => ({
    nonce, amount, upfrontBps: DEMO.upfrontBps, feeBps: DEMO.feeBps, periods: DEMO.periods,
    periodSecs: BigInt(DEMO.periodSecs), minCheckinsPerPeriod: DEMO.minCheckinsPerPeriod,
    closureSecs: BigInt(DEMO.closureSecs), minContracts: DEMO.minContracts,
  });

  const prepare = () => run('prepare', async () => {
    if (!publicKey) return;
    const lam = (x: number) => Math.round(x * LAMPORTS_PER_SOL);
    const memberEsc = members.map(m => S.escrowPda(m.publicKey, counter.publicKey, MEMBER_NONCE));
    // Đọc trạng thái hiện có để chạy tiếp từ chỗ dở nếu lần trước bị ngắt giữa chừng.
    const look = await withRetry(() => connection.getMultipleAccountsInfo([
      counter.publicKey, operator.publicKey, ...members.map(m => m.publicKey), ata(publicKey), ...members.map(m => ata(m.publicKey)), ...memberEsc,
    ]));
    const n = members.length;
    const funded = lamportsOf(look[0]) >= lam(0.03) && lamportsOf(look[1]) >= lam(0.01) && look.slice(2, 2 + n).every(i => lamportsOf(i) >= lam(0.015));
    const minted = tokenAmount(look[2 + n]) > 0n && look.slice(3 + n, 3 + 2 * n).every(i => tokenAmount(i) > 0n);
    const bought = look.slice(3 + 2 * n, 3 + 3 * n).map(i => !!i);

    if (!funded) {
      const ok = await send('Nạp phí mạng cho quầy, Solva và 2 hội viên', 'Chuẩn bị', [
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: counter.publicKey, lamports: lam(0.05) }),
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: operator.publicKey, lamports: lam(0.02) }),
        ...members.map(m => SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: m.publicKey, lamports: lam(0.03) })),
      ], { wallet: true });
      if (!ok) return;
    }
    const holders: [PublicKey, bigint][] = [
      [publicKey, PRICE + 16_000_000n],
      ...members.map((m, i): [PublicKey, bigint] => [m.publicKey, BigInt(Math.floor((MEMBERS[i].vnd / DEMO.rateVnd) * 1e6))]),
    ];
    if (!minted) {
      const faucet = holders.flatMap(([owner, amt]) => [
        createAssociatedTokenAccountIdempotentInstruction(counter.publicKey, ata(owner), owner, MINT),
        createMintToInstruction(MINT, ata(owner), FAUCET.publicKey, amt),
      ]);
      if (!(await send('Cấp USDC thử nghiệm cho khách và hội viên', 'Chuẩn bị', faucet, { feePayer: counter, signers: [FAUCET] }))) return;
    }
    for (let i = 0; i < n; i++) {
      if (bought[i]) continue;
      const m = members[i];
      const amount = holders[i + 1][1];
      await sleep(1500);
      const ok2 = await send(`Hội viên ${MEMBERS[i].name} mua gói`, 'Hội viên khác', [
        S.createEscrowIx({ buyer: m.publicKey, facilityAuth: counter.publicKey, mint: MINT, feeRecipient: TREASURY, params: params(MEMBER_NONCE, amount) }),
        S.depositIx({ buyer: m.publicKey, escrow: memberEsc[i], facilityAuth: counter.publicKey, buyerToken: ata(m.publicKey) }),
      ], { feePayer: m, signers: [counter] });
      if (!ok2) { toast('bad', 'Chưa xong bước chuẩn bị', 'Bấm “Chuẩn bị quầy” lần nữa để chạy tiếp từ chỗ dở.'); return; }
    }
    update({ prepared: true, closed: false });
    toast('ok', 'Quầy đã sẵn sàng', 'Hai hội viên khác đang tập và check-in định kỳ.');
  });

  const buy = () => run('buy', async () => {
    if (!publicKey) return;
    const nonce = BigInt(Date.now());
    const esc = S.escrowPda(publicKey, counter.publicKey, nonce);
    const ok = await send('Khách mua gói 12 tháng', 'Khách', [
      S.createEscrowIx({ buyer: publicKey, facilityAuth: counter.publicKey, mint: MINT, feeRecipient: TREASURY, params: params(nonce, PRICE) }),
      S.depositIx({ buyer: publicKey, escrow: esc, facilityAuth: counter.publicKey, buyerToken: ata(publicKey) }),
    ], { wallet: true, signers: [counter] });
    if (ok) update({ nonce: nonce.toString() });
  });

  const checkin = () => run('checkin', async () => {
    if (!publicKey || !escrowAddr) return;
    if (demo.closed) { toast('bad', 'Quầy không phản hồi', 'Phòng tập đã đóng cửa nên không ai ký phía cơ sở.'); return; }
    await send('Khách check-in tại quầy', 'Khách', [S.checkinIx({ buyer: publicKey, facilityAuth: counter.publicKey, escrow: escrowAddr })], { wallet: true, signers: [counter] });
  });

  const fakeCheckin = () => run('fake', async () => {
    if (!publicKey || !escrowAddr) return;
    await send('Quầy tự ghi check-in, không có khách', 'Quầy',
      [S.checkinIx({ buyer: publicKey, facilityAuth: counter.publicKey, escrow: escrowAddr, buyerSigns: false })], { feePayer: counter });
  });

  const confirm = () => run('confirm', async () => {
    if (!escrowAddr) return;
    await send('Xác nhận mốc (ai gọi cũng được)', 'Solva', [S.confirmMilestoneIx({ escrow: escrowAddr, facilityAuth: counter.publicKey })], { feePayer: operator });
  });

  const facWithdraw = (amount?: bigint) => run('facw', async () => {
    if (!escrowAddr) return;
    await send(amount == null ? 'Quầy rút phần đã giải ngân' : 'Quầy thử rút toàn bộ vault', 'Quầy', [
      createAssociatedTokenAccountIdempotentInstruction(counter.publicKey, ata(counter.publicKey), counter.publicKey, MINT),
      S.withdrawIx({ caller: counter.publicKey, escrow: escrowAddr, destination: ata(counter.publicKey), feeRecipient: TREASURY, amount: amount ?? null }),
    ], { feePayer: counter });
  });

  const opSteal = () => run('opsteal', async () => {
    if (!escrowAddr) return;
    await send('Solva thử rút toàn bộ vault về ví Solva', 'Solva', [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(operator.publicKey), operator.publicKey, MINT),
      S.withdrawIx({ caller: operator.publicKey, escrow: escrowAddr, destination: ata(operator.publicKey), feeRecipient: TREASURY, amount: null }),
    ], { feePayer: operator });
  });

  const opFreeze = () => run('opfreeze', async () => {
    if (!escrowAddr) return;
    await send('Solva thử đóng băng hợp đồng', 'Solva', [S.freezeIx({ caller: operator.publicKey, escrow: escrowAddr })], { feePayer: operator });
  });

  const refund = () => run('refund', async () => {
    if (!publicKey || !escrowAddr || !snap?.escrow) return;
    const ixs: TransactionInstruction[] = [];
    if (snap.escrow.status === 1) ixs.push(S.triggerTerminationIx({ escrow: escrowAddr, facilityAuth: counter.publicKey }));
    ixs.push(S.withdrawIx({ caller: publicKey, escrow: escrowAddr, destination: ata(publicKey), feeRecipient: TREASURY, amount: null }));
    await send('Khách lấy lại tiền', 'Khách', ixs, { wallet: true });
  });

  const toggleClosed = () => {
    update({ closed: !demo.closed });
    toast(demo.closed ? 'ok' : 'bad', demo.closed ? 'Phòng tập mở cửa lại' : 'Phòng tập đóng cửa', demo.closed ? '' : `Không ai check-in nữa. Sau ${DEMO.closureSecs} giây, dữ liệu cho phép khách lấy lại tiền.`);
  };

  const reset = () => {
    const d = fresh(); setDemo(d); save(d); setLedger([]); setSnap(null);
    toast('ok', 'Đã tạo quầy mới', 'Bấm “Chuẩn bị quầy” để bắt đầu lượt demo mới.');
  };

  /* ---------- hội viên khác check-in định kỳ khi phòng tập mở ---------- */
  const auto = useRef({ send, members, counter, demo, i: 0 });
  auto.current = { ...auto.current, send, members, counter, demo };
  useEffect(() => {
    const t = setInterval(() => {
      const a = auto.current;
      if (!a.demo.prepared || a.demo.closed || !configured) return;
      const idx = a.i++ % a.members.length;
      const m = a.members[idx];
      const esc = S.escrowPda(m.publicKey, a.counter.publicKey, MEMBER_NONCE);
      a.send(`Hội viên ${MEMBERS[idx].name} check-in`, 'Hội viên khác',
        [S.checkinIx({ buyer: m.publicKey, facilityAuth: a.counter.publicKey, escrow: esc })], { feePayer: a.counter, signers: [m], quiet: true });
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  /* ---------- derived ---------- */
  const e = snap?.escrow;
  const f = snap?.facility;
  const owedFac = e ? e.released - e.facWithdrawn : 0n;
  const protectedAmt = e && snap?.vault != null ? snap.vault - owedFac : 0n;
  const silent = f ? Math.max(0, now - Number(f.lastCheckinTs)) : 0;
  const closureIn = f ? Math.ceil(Number(f.closureSecs) - silent) : 0;
  const stopped = !!f && (f.closed || (f.activeContracts >= f.minContracts && closureIn <= 0));
  const nextDue = e && e.status === 1 ? Number(e.startTs) + (e.confirmed + 1) * Number(e.periodSecs) : 0;
  const dueIn = nextDue ? Math.ceil(nextDue - now) : 0;
  const lowSol = snap && snap.sol < 0.1;

  const steps = [
    { t: 'Khách mua gói', d: 'Tiền vào vault', done: !!e, cue: 'Khách đăng nhập bằng Phantom, mua gói 12 tháng. Tiền không vào ví phòng tập mà vào một vault do chương trình Solana giữ; 20% mở ngay cho cơ sở.', act: buy, can: !!demo.prepared && !e },
    { t: 'Check-in chữ ký kép', d: 'Khách + quầy cùng ký', done: !!e && e.checkins > 0, cue: 'Mỗi lần check-in là một giao dịch có hai chữ ký: khách ký trên Phantom, quầy ký trên thiết bị của quầy. Mở Explorer để thấy hai chữ ký.', act: checkin, can: !!e && e.status === 1 },
    { t: 'Quầy tự khai', d: 'Thiếu chữ ký khách', done: ledger.some(x => x.label.startsWith('Quầy tự ghi') && x.status === 'fail'), cue: 'Mời giám khảo đóng vai chủ phòng tập, tự ghi một buổi tập không có khách. Giao dịch lên chuỗi nhưng thất bại: thiếu chữ ký khách.', act: fakeCheckin, can: !!e },
    { t: 'Qua một kỳ', d: `${DEMO.periodSecs}s = 1 tháng`, done: !!e && e.confirmed > 0, cue: 'Một tháng được nén thành 60 giây. Ai cũng gọi được lệnh xác nhận mốc; chương trình chỉ kiểm tra thời gian và số check-in. Sau đó quầy rút đúng phần của mình.', act: async () => { await confirm(); await facWithdraw(); }, can: !!e && e.status === 1 && dueIn <= 0 },
    { t: 'Thử rút tiền khách', d: 'Solva, quầy đều bị từ chối', done: ledger.some(x => x.label.startsWith('Solva thử rút') && x.status === 'fail'), cue: 'Mời giám khảo bấm “Rút toàn bộ vault về ví Solva”, rồi “Quầy thử rút toàn bộ vault”. Cả hai thất bại trên chuỗi. Solva không có chìa khóa.', act: async () => { await opSteal(); if (snap?.vault) await facWithdraw(snap.vault); }, can: !!e },
    { t: 'Phòng tập đóng cửa', d: 'Khách tự lấy lại tiền', done: !!e && e.buyerWithdrawn > 0n, cue: `Bấm “Đóng cửa phòng tập”. Sau ${DEMO.closureSecs} giây không có check-in, mời giám khảo bấm “Lấy lại tiền” trên phía khách. Giao dịch chỉ có chữ ký của khách.`, act: async () => { if (!demo.closed) toggleClosed(); }, can: !!e },
  ];
  const firstOpen = steps.findIndex(s => !s.done);
  const current = firstOpen === -1 ? steps.length - 1 : firstOpen;

  /* ---------- render ---------- */
  return (
    <div className="wrap">
      <div className="bar">
        <div className="brand">
          <h1>Sol<span>va</span></h1>
          <span className="net">{config.cluster === 'localnet' ? 'Localnet' : 'Solana Devnet'}</span>
          <a className="mono addr" href={explorerAddr(config.programId)} target="_blank" rel="noreferrer">Program {short(config.programId)}</a>
        </div>
        <div className="barright">
          <span className="note">Thời gian nén: 1 tháng = {DEMO.periodSecs}s · 7 ngày = {DEMO.closureSecs}s</span>
          <WalletMultiButton />
        </div>
      </div>

      {!configured && (
        <div className="alert">Chưa có cấu hình. Chạy <code>npm run setup:devnet</code> (xem README) để tạo USDC thử nghiệm và ghi <code>src/config.json</code>.</div>
      )}
      {configured && !publicKey && (
        <div className="panel intro"><h2>Kết nối ví Phantom (Devnet) để bắt đầu</h2>
          <p className="note">Trong Phantom: Cài đặt → Nhà phát triển → bật Testnet Mode, chọn Solana Devnet. Ví cần khoảng 0,2 SOL devnet (faucet.solana.com).</p></div>
      )}

      {configured && publicKey && (
        <>
          {!demo.prepared && (
            <div className="panel intro">
              <h2>Chuẩn bị quầy</h2>
              <p className="note">Một lần duyệt trên Phantom để nạp phí mạng cho quầy, ví Solva và hai hội viên khác. Sau đó ứng dụng tự cấp USDC thử nghiệm và cho hai hội viên mua gói tại cùng phòng tập.</p>
              {lowSol && <div className="alert">Ví đang có {snap?.sol.toFixed(3)} SOL. Cần tối thiểu 0,15 SOL devnet.</div>}
              <button className="btn primary" disabled={!!busy} onClick={prepare}>{busy === 'prepare' ? 'Đang chuẩn bị…' : 'Chuẩn bị quầy'}</button>
            </div>
          )}

          <section className="steps" aria-label="Kịch bản demo">
            <ol>
              {steps.map((s, i) => (
                <li key={s.t}>
                  <button className={`step ${s.done ? 'done' : ''} ${i === current ? 'current' : ''}`} disabled={!!busy || !s.can} onClick={() => s.act()}>
                    <span className="n">{s.done ? '✓' : i + 1}</span><b>{s.t}</b><span>{s.d}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="cue"><strong>Lời dẫn</strong><span>{steps[current].cue}</span></div>
          </section>

          <div className="main">
            <div className="roles">
              {/* ---------------- khách */}
              <section className="panel">
                <header><span className="eyebrow">Người mua gói · ví Phantom</span><h2>Ứng dụng của khách</h2>
                  <a className="mono addr" href={explorerAddr(publicKey.toBase58())} target="_blank" rel="noreferrer">Ví {short(publicKey.toBase58())}</a></header>
                <div className="phone"><div className="screen">
                  <div className="appbar"><b>Solva</b><span>{snap ? `${snap.sol.toFixed(3)} SOL` : '…'}</span></div>
                  {!e ? (
                    <>
                      <div className="offer"><span className="eyebrow">Phòng tập An Khang</span><b>Gói tập 12 tháng</b>
                        <span className="price">{DEMO.priceVnd.toLocaleString('vi-VN')} đ</span>
                        <span className="note">{usdc(PRICE)} · 20% chuyển cho phòng tập khi ký, phần còn lại được giữ trong vault và chuyển dần theo tháng.</span></div>
                      <div className="row"><span>Số dư ví</span><b className="num">{vnd(snap?.usdc)}</b></div>
                      <button className="btn primary wide" disabled={!!busy || !demo.prepared} onClick={buy}>{busy === 'buy' ? 'Đang chờ ký…' : 'Thanh toán và ký hợp đồng'}</button>
                    </>
                  ) : (
                    <>
                      {e.buyerWithdrawn > 0n ? (
                        <div className="refund"><small>Đã nhận lại về ví</small><span className="big">{vnd(e.buyerWithdrawn)}</span>
                          <span className="note">{usdc(e.buyerWithdrawn)} từ vault về ví của khách.</span></div>
                      ) : (
                        <div className="vaultcard"><small>Tiền của bạn đang được giữ trong vault</small><span className="big">{vnd(protectedAmt)}</span>
                          <div className="meter"><i style={{ width: `${Math.min(100, (Number(e.released) / Number(e.amount)) * 100)}%` }} /></div>
                          <small>Đã mở cho phòng tập {vnd(e.released)} · 20% trả trước + {e.confirmed} tháng</small></div>
                      )}
                      <div className="months">{Array.from({ length: e.periods }, (_, i) => <i key={i} className={i < e.confirmed ? 'on' : ''} />)}</div>
                      <div className="row"><span>Tình trạng</span>
                        {e.status === 2 ? <span className="pill idle">Kết thúc · {S.REASON[e.reason]}</span>
                          : stopped ? <span className="pill bad">Phòng tập ngừng phục vụ</span>
                            : <span className="pill ok">Phòng tập đang phục vụ</span>}</div>
                      {e.status === 1 && <div className="row"><span>Mốc tháng tiếp theo</span><b className="num">{dueIn > 0 ? `sau ${dueIn}s` : 'đã tới hạn'}</b></div>}
                      <div className="row"><span>Lượt check-in của bạn</span><b className="num">{e.checkins}</b></div>
                      {e.buyerWithdrawn === 0n && (stopped || e.status === 2) &&
                        <div className="alert">Dữ liệu trên chuỗi cho thấy phòng tập đã ngừng phục vụ. Bạn có thể lấy lại phần tiền chưa dùng.</div>}
                      <div className="btnrow">
                        <button className="btn" disabled={!!busy || e.status !== 1 || !!demo.closed} onClick={checkin}>{busy === 'checkin' ? 'Đang ký…' : 'Check-in'}</button>
                        <button className={`btn ${stopped || e.status === 2 ? 'primary pulse' : ''}`} disabled={!!busy || e.buyerWithdrawn > 0n} onClick={refund}>{busy === 'refund' ? 'Đang ký…' : 'Lấy lại tiền'}</button>
                      </div>
                    </>
                  )}
                </div></div>
              </section>

              {/* ---------------- quầy */}
              <section className="panel">
                <header><span className="eyebrow">Cơ sở dịch vụ · tên mô phỏng</span><h2>Quầy · Phòng tập An Khang</h2>
                  <a className="mono addr" href={explorerAddr(counter.publicKey.toBase58())} target="_blank" rel="noreferrer">Ví quầy {short(counter.publicKey.toBase58())} · {snap?.counterSol.toFixed(3) ?? '…'} SOL</a></header>
                <div className="stats">
                  <Stat label="Hợp đồng đang chạy" value={f ? String(f.activeContracts) : '—'} />
                  <Stat label="Tổng lượt check-in" value={f ? f.checkinCount.toString() : '—'} />
                  <Stat label="Check-in gần nhất" value={f ? `${Math.floor(silent)}s trước` : '—'} />
                  <Stat label="Ngưỡng ngừng phục vụ" value={!f ? '—' : f.closed ? 'Đã đóng' : closureIn > 0 ? `còn ${closureIn}s` : 'Đã chạm'} />
                  <Stat label="Của khách này, rút được" value={e ? vnd(owedFac) : '—'} />
                  <Stat label="Đã về ví quầy" value={vnd(snap?.facUsdc)} />
                </div>
                <div className="group"><span className="eyebrow">Vận hành</span>
                  <button className="btn" disabled={!!busy || !e || owedFac === 0n} onClick={() => facWithdraw()}>Rút phần đã giải ngân</button>
                  <button className="btn" disabled={!demo.prepared} onClick={toggleClosed}>{demo.closed ? 'Mở cửa lại' : 'Đóng cửa phòng tập'}</button>
                  <p className="note">{demo.closed ? 'Phòng tập đóng: không còn ai check-in.' : 'Hai hội viên khác check-in khoảng 30 giây một lần.'}</p>
                </div>
                <div className="group"><span className="eyebrow">Thử gian lận</span>
                  <button className="btn danger" disabled={!!busy || !e} onClick={fakeCheckin}>Tự ghi check-in, không cần khách</button>
                  <button className="btn danger" disabled={!!busy || !e || !snap?.vault} onClick={() => facWithdraw(snap?.vault ?? 0n)}>Rút toàn bộ tiền trong vault</button>
                </div>
              </section>

              {/* ---------------- solva */}
              <section className="panel">
                <header><span className="eyebrow">Đơn vị vận hành</span><h2>Quản trị Solva</h2>
                  <a className="mono addr" href={explorerAddr(operator.publicKey.toBase58())} target="_blank" rel="noreferrer">Ví Solva {short(operator.publicKey.toBase58())} · {snap?.operatorSol.toFixed(3) ?? '…'} SOL</a></header>
                <div className="stats">
                  <Stat label="Phí 0,75% đã thu" value={vnd(snap?.treasuryUsdc)} />
                  <Stat label="Trong vault của khách" value={snap?.vault != null ? vnd(snap.vault) : '—'} />
                  <Stat label="Quyền rút tiền vault" value="Không có" />
                  <Stat label="Khóa quản trị" value="Không có" />
                </div>
                <div className="group"><span className="eyebrow">Dịch vụ nền</span>
                  <button className="btn" disabled={!!busy || !e || e.status !== 1} onClick={confirm}>Xác nhận mốc tháng</button>
                  <p className="note">Lệnh này ai gọi cũng được và không chạm vào tiền; chương trình chỉ kiểm tra thời gian và số check-in.</p>
                </div>
                <div className="group"><span className="eyebrow">Thử can thiệp tiền của khách</span>
                  <button className="btn danger" disabled={!!busy || !e} onClick={opSteal}>Rút toàn bộ vault về ví Solva</button>
                  <button className="btn danger" disabled={!!busy || !e} onClick={opFreeze}>Đóng băng hợp đồng của khách</button>
                </div>
                <button className="btn subtle" onClick={reset}>Tạo quầy mới cho lượt demo khác</button>
              </section>
            </div>

            {/* ---------------- ledger */}
            <aside className="panel ledger">
              <header><span className="eyebrow">Giao dịch thật trên {config.cluster === 'localnet' ? 'localnet' : 'devnet'}</span><h2>Sổ giao dịch</h2></header>
              <div className="list">
                {ledger.length === 0 && <div className="empty">Chưa có giao dịch. Mỗi thao tác sẽ hiện ở đây kèm mã hash và liên kết Solana Explorer.</div>}
                {ledger.map(x => (
                  <article key={x.id} className={`tx ${x.status === 'fail' ? 'rej' : ''} ${x.status === 'pending' ? 'pend' : ''}`}>
                    <div className="top"><span className="lbl">{x.label}</span>
                      <span className={`pill ${x.status === 'ok' ? 'ok' : x.status === 'fail' ? 'bad' : 'warn'}`}>{x.status === 'ok' ? 'Thành công' : x.status === 'fail' ? 'Bị từ chối' : 'Đang gửi'}</span></div>
                    <div className="who">{x.signers.map(s => <span key={s} className="chip">✍ {s}</span>)}</div>
                    {x.error && <div className="err">{x.error}</div>}
                    {x.sig && <a className="mono sig" href={explorerTx(x.sig)} target="_blank" rel="noreferrer">{short(x.sig)} · xem trên Explorer ↗</a>}
                    {x.logs && <details><summary>Nhật ký chương trình</summary><pre>{x.logs.join('\n')}</pre></details>}
                  </article>
                ))}
              </div>
            </aside>
          </div>
        </>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.title}{t.sub && <small>{t.sub}</small>}</div>)}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><small>{label}</small><b>{value}</b></div>;
}
