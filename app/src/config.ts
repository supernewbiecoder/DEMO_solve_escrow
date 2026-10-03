import raw from './config.json';

export interface SolvaConfig {
  cluster: 'devnet' | 'localnet';
  rpc: string;
  programId: string;
  mint: string;
  faucetSecret: number[];
  treasuryAta: string;
  decimals: number;
}

export const config = raw as SolvaConfig;
export const configured = !!config.mint && !!config.treasuryAta && config.faucetSecret.length === 64;

// Tham số demo: thời gian nén để trình diễn trong vài phút.
export const DEMO = {
  priceVnd: 10_000_000,
  rateVnd: 26_000,           // tỷ giá mô phỏng VND/USDC
  periods: 12,
  periodSecs: 60,            // 1 tháng = 60 giây
  closureSecs: 120,          // 7 ngày không check-in = 120 giây
  upfrontBps: 2_000,         // 20% trả trước cho cơ sở
  feeBps: 75,                // phí Solva 0,75%
  minCheckinsPerPeriod: 1,
  minContracts: 1,
};

export function explorerTx(sig: string) {
  const q = config.cluster === 'localnet'
    ? `?cluster=custom&customUrl=${encodeURIComponent(config.rpc)}`
    : '?cluster=devnet';
  return `https://explorer.solana.com/tx/${sig}${q}`;
}
export function explorerAddr(addr: string) {
  const q = config.cluster === 'localnet'
    ? `?cluster=custom&customUrl=${encodeURIComponent(config.rpc)}`
    : '?cluster=devnet';
  return `https://explorer.solana.com/address/${addr}${q}`;
}
