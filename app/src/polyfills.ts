// Phải được import đầu tiên: thư viện Solana dùng Buffer, global, process ngay khi nạp.
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown; process?: { env: Record<string, string> } };
g.Buffer = g.Buffer ?? Buffer;
g.global = g.global ?? globalThis;
g.process = g.process ?? { env: {} };
