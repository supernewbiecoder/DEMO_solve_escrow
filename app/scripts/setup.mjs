// Chuẩn bị môi trường demo: tạo USDC thử nghiệm, ví nhận phí của Solva, rồi ghi src/config.json.
//
//   node scripts/setup.mjs devnet            # dùng https://api.devnet.solana.com
//   node scripts/setup.mjs localnet          # dùng http://127.0.0.1:8899 (solana-test-validator)
//   node scripts/setup.mjs devnet --rpc <url>
//
// Ví trả phí: ~/.config/solana/id.json (đổi bằng biến môi trường SOLANA_KEYPAIR).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cluster = process.argv[2] === 'localnet' ? 'localnet' : 'devnet';
const rpcFlag = process.argv.indexOf('--rpc');
const rpc = rpcFlag > 0 ? process.argv[rpcFlag + 1] : cluster === 'localnet' ? 'http://127.0.0.1:8899' : 'https://api.devnet.solana.com';

// Trên Windows, gọi process.exit() khi kết nối mạng còn mở gây lỗi "UV_HANDLE_CLOSING";
// vì vậy chỉ đặt exitCode và để Node tự thoát.
function fail() { process.exitCode = 1; }

async function main() {
  const walletPath = process.env.SOLANA_KEYPAIR || join(homedir(), '.config', 'solana', 'id.json');
  if (!existsSync(walletPath)) {
    console.error(`Không thấy ví ${walletPath}. Tạo bằng: solana-keygen new`);
    return fail();
  }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));

  function programId() {
    const kpPath = join(root, 'target', 'deploy', 'solva-keypair.json');
    if (existsSync(kpPath)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, 'utf8')))).publicKey.toBase58();
    const lib = readFileSync(join(root, 'programs', 'solva', 'src', 'lib.rs'), 'utf8');
    return /declare_id!\("(\w+)"\)/.exec(lib)[1];
  }

  const conn = new Connection(rpc, 'confirmed');
  const pid = programId();
  console.log(`Mạng: ${cluster} (${rpc})`);
  console.log(`Ví trả phí: ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${pid}`);

  const bal = await conn.getBalance(payer.publicKey);
  console.log(`Số dư: ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    if (cluster === 'localnet') {
      await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL));
    } else {
      console.error('Ví cần ít nhất 0,05 SOL devnet. Lấy tại https://faucet.solana.com rồi chạy lại.');
      return fail();
    }
  }

  const prog = await conn.getAccountInfo(new PublicKey(pid));
  if (!prog?.executable) {
    console.warn('Cảnh báo: chưa thấy chương trình được deploy ở địa chỉ này. Chạy `anchor deploy` trước khi demo.');
  }

  // Vòi USDC thử nghiệm: khóa này chỉ có quyền đúc token thử nghiệm trên mạng thử.
  const faucet = Keypair.generate();
  const mint = await createMint(conn, payer, faucet.publicKey, null, 6);
  console.log(`USDC thử nghiệm (mint): ${mint.toBase58()}`);
  const treasury = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  console.log(`Ví nhận phí 0,75% của Solva: ${treasury.address.toBase58()}`);

  const config = {
    cluster,
    rpc,
    programId: pid,
    mint: mint.toBase58(),
    faucetSecret: Array.from(faucet.secretKey),
    treasuryAta: treasury.address.toBase58(),
    decimals: 6,
  };
  writeFileSync(join(here, '..', 'src', 'config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('Đã ghi app/src/config.json. Chạy `npm run dev` để mở demo.');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
