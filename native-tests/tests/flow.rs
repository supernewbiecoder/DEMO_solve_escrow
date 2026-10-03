//! Chạy toàn bộ kịch bản demo trên một ngân hàng Solana cục bộ (solana-program-test),
//! có SPL Token thật và đồng hồ điều khiển được.
//!
//!     cd native-tests && cargo test -- --nocapture

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{Instruction, InstructionError},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::{Transaction, TransactionError},
};
use solva::{Escrow, EscrowParams, Facility};

fn entry_wrapper(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    solva::entry(program_id, accounts, data)
}

const T0: i64 = 1_800_000_000;
const AMOUNT: u64 = 384_615_384; // 10.000.000 đ ở tỷ giá 26.000 đ/USDC, 6 chữ số thập phân

struct Env {
    ctx: ProgramTestContext,
    mint: Pubkey,
    buyer: Keypair,
    facility: Keypair,
    solva_op: Keypair,
    buyer_ata: Pubkey,
    facility_ata: Pubkey,
    treasury_ata: Pubkey,
    solva_ata: Pubkey,
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), BanksClientError> {
    let bh = ctx.get_new_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&ctx.payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&ctx.payer.pubkey()), &all, bh);
    ctx.banks_client.process_transaction(tx).await
}

fn code(r: Result<(), BanksClientError>) -> u32 {
    match r.expect_err("giao dịch lẽ ra phải bị từ chối").unwrap() {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => c,
        e => panic!("lỗi không mong đợi: {e:?}"),
    }
}

async fn set_time(ctx: &mut ProgramTestContext, ts: i64) {
    let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = ts;
    ctx.set_sysvar(&clock);
}

async fn token_account(ctx: &mut ProgramTestContext, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let kp = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let ixs = [
        system_instruction::create_account(&ctx.payer.pubkey(), &kp.pubkey(),
            rent.minimum_balance(spl_token::state::Account::LEN), spl_token::state::Account::LEN as u64, &spl_token::ID),
        spl_token::instruction::initialize_account3(&spl_token::ID, &kp.pubkey(), mint, owner).unwrap(),
    ];
    send(ctx, &ixs, &[&kp]).await.unwrap();
    kp.pubkey()
}

async fn balance(ctx: &mut ProgramTestContext, acct: &Pubkey) -> u64 {
    let a = ctx.banks_client.get_account(*acct).await.unwrap().unwrap();
    spl_token::state::Account::unpack(&a.data).unwrap().amount
}

async fn escrow_state(ctx: &mut ProgramTestContext, pk: &Pubkey) -> Escrow {
    let a = ctx.banks_client.get_account(*pk).await.unwrap().unwrap();
    Escrow::try_deserialize(&mut a.data.as_slice()).unwrap()
}

async fn facility_state(ctx: &mut ProgramTestContext, pk: &Pubkey) -> Facility {
    let a = ctx.banks_client.get_account(*pk).await.unwrap().unwrap();
    Facility::try_deserialize(&mut a.data.as_slice()).unwrap()
}

async fn setup() -> Env {
    let mut pt = ProgramTest::new("solva", solva::ID, processor!(entry_wrapper));
    pt.prefer_bpf(false);
    let mut ctx = pt.start_with_context().await;
    set_time(&mut ctx, T0).await;

    let buyer = Keypair::new();
    let facility = Keypair::new();
    let solva_op = Keypair::new();
    let fund: Vec<Instruction> = [&buyer, &facility, &solva_op]
        .iter()
        .map(|k| system_instruction::transfer(&ctx.payer.pubkey(), &k.pubkey(), 2_000_000_000))
        .collect();
    send(&mut ctx, &fund, &[]).await.unwrap();

    let mint_kp = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let payer = ctx.payer.pubkey();
    let ixs = [
        system_instruction::create_account(&payer, &mint_kp.pubkey(),
            rent.minimum_balance(spl_token::state::Mint::LEN), spl_token::state::Mint::LEN as u64, &spl_token::ID),
        spl_token::instruction::initialize_mint2(&spl_token::ID, &mint_kp.pubkey(), &payer, None, 6).unwrap(),
    ];
    send(&mut ctx, &ixs, &[&mint_kp]).await.unwrap();
    let mint = mint_kp.pubkey();

    let buyer_ata = token_account(&mut ctx, &mint, &buyer.pubkey()).await;
    let facility_ata = token_account(&mut ctx, &mint, &facility.pubkey()).await;
    let treasury_ata = token_account(&mut ctx, &mint, &solva_op.pubkey()).await;
    let solva_ata = token_account(&mut ctx, &mint, &solva_op.pubkey()).await;
    let ix = spl_token::instruction::mint_to(&spl_token::ID, &mint, &buyer_ata, &payer, &[], AMOUNT).unwrap();
    send(&mut ctx, &[ix], &[]).await.unwrap();

    Env { ctx, mint, buyer, facility, solva_op, buyer_ata, facility_ata, treasury_ata, solva_ata }
}

fn pdas(buyer: &Pubkey, facility: &Pubkey, nonce: u64) -> (Pubkey, Pubkey, Pubkey) {
    let (fac, _) = Pubkey::find_program_address(&[b"facility", facility.as_ref()], &solva::ID);
    let (esc, _) = Pubkey::find_program_address(&[b"escrow", buyer.as_ref(), facility.as_ref(), &nonce.to_le_bytes()], &solva::ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", esc.as_ref()], &solva::ID);
    (fac, esc, vault)
}

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: solva::ID, accounts: accounts.to_account_metas(None), data: data.data() }
}

fn params(nonce: u64) -> EscrowParams {
    EscrowParams {
        nonce,
        amount: AMOUNT,
        upfront_bps: 2_000,
        fee_bps: 75,
        periods: 12,
        period_secs: 60,          // demo: 1 tháng = 60 giây
        min_checkins_per_period: 1,
        closure_secs: 120,        // demo: 7 ngày = 120 giây
        min_contracts: 1,
    }
}

fn create_ix(e: &Env, buyer: &Pubkey, nonce: u64) -> Instruction {
    let (fac, esc, vault) = pdas(buyer, &e.facility.pubkey(), nonce);
    ix(
        solva::accounts::CreateEscrow {
            buyer: *buyer, facility_authority: e.facility.pubkey(), facility: fac, escrow: esc, vault,
            mint: e.mint, fee_recipient: e.treasury_ata,
            token_program: spl_token::ID, system_program: solana_sdk::system_program::ID,
            rent: solana_sdk::sysvar::rent::ID,
        },
        solva::instruction::CreateEscrow { params: params(nonce) },
    )
}

fn checkin_ix(e: &Env, buyer: &Pubkey, nonce: u64) -> Instruction {
    let (fac, esc, _) = pdas(buyer, &e.facility.pubkey(), nonce);
    ix(solva::accounts::RecordCheckin { buyer: *buyer, facility_authority: e.facility.pubkey(), escrow: esc, facility: fac },
       solva::instruction::RecordCheckin {})
}

fn withdraw_ix(e: &Env, esc_buyer: &Pubkey, nonce: u64, caller: &Pubkey, dest: &Pubkey, amount: Option<u64>) -> Instruction {
    let (_, esc, vault) = pdas(esc_buyer, &e.facility.pubkey(), nonce);
    ix(
        solva::accounts::Withdraw { caller: *caller, escrow: esc, vault, destination: *dest, fee_recipient: e.treasury_ata, token_program: spl_token::ID },
        solva::instruction::Withdraw { amount },
    )
}

#[tokio::test]
async fn full_demo_flow() {
    let mut e = setup().await;
    let buyer = e.buyer.pubkey();
    let (fac, esc, vault) = pdas(&buyer, &e.facility.pubkey(), 1);

    // 1. Khách mua gói: tạo hợp đồng (khách + cơ sở ký) rồi nạp tiền (khách ký).
    let c = create_ix(&e, &buyer, 1);
    send(&mut e.ctx, &[c], &[&e.buyer, &e.facility]).await.unwrap();
    let d = ix(solva::accounts::Deposit { buyer, escrow: esc, facility: fac, vault, buyer_token: e.buyer_ata, token_program: spl_token::ID },
               solva::instruction::Deposit {});
    send(&mut e.ctx, &[d], &[&e.buyer]).await.unwrap();
    assert_eq!(balance(&mut e.ctx, &vault).await, AMOUNT);
    assert_eq!(balance(&mut e.ctx, &e.buyer_ata).await, 0);
    let s = escrow_state(&mut e.ctx, &esc).await;
    assert_eq!(s.status, solva::STATUS_ACTIVE);
    assert_eq!(s.released, AMOUNT / 5);
    println!("1. mua gói: vault = {} , mở trước cho cơ sở = {}", AMOUNT, s.released);

    // Tạo hợp đồng thiếu chữ ký cơ sở: bị từ chối (Anchor AccountNotSigner = 3010).
    let mut c2 = create_ix(&e, &buyer, 2);
    c2.accounts[1].is_signer = false;
    assert_eq!(code(send(&mut e.ctx, &[c2], &[&e.buyer]).await), 3010);

    // 2. Check-in chữ ký kép.
    set_time(&mut e.ctx, T0 + 10).await;
    let ci = checkin_ix(&e, &buyer, 1);
    send(&mut e.ctx, &[ci], &[&e.buyer, &e.facility]).await.unwrap();
    println!("2. check-in hai chữ ký: thành công");

    // 3. Cơ sở tự ghi check-in, không có chữ ký khách: bị từ chối.
    let mut fake = checkin_ix(&e, &buyer, 1);
    fake.accounts[0].is_signer = false;
    assert_eq!(code(send(&mut e.ctx, &[fake], &[&e.facility]).await), 3010);
    println!("3. check-in thiếu chữ ký khách: bị từ chối (3010 AccountNotSigner)");

    // Xác nhận mốc sớm: bị từ chối.
    let cm = ix(solva::accounts::ConfirmMilestone { escrow: esc, facility: fac }, solva::instruction::ConfirmMilestone {});
    assert_eq!(code(send(&mut e.ctx, &[cm.clone()], &[]).await), 6004);

    // 4. Qua một kỳ: ai cũng xác nhận được mốc; cơ sở rút đúng phần của mình.
    set_time(&mut e.ctx, T0 + 61).await;
    send(&mut e.ctx, &[cm.clone()], &[]).await.unwrap();
    let s = escrow_state(&mut e.ctx, &esc).await;
    let per = (AMOUNT - AMOUNT / 5) / 12;
    assert_eq!(s.confirmed, 1);
    assert_eq!(s.released, AMOUNT / 5 + per);
    // Kỳ 2 chưa có check-in mới: tới hạn cũng không đủ bằng chứng (6005).
    set_time(&mut e.ctx, T0 + 125).await;
    assert_eq!(code(send(&mut e.ctx, &[cm.clone()], &[]).await), 6005);
    let ci2 = checkin_ix(&e, &buyer, 1);
    send(&mut e.ctx, &[ci2], &[&e.buyer, &e.facility]).await.unwrap();

    let w = withdraw_ix(&e, &buyer, 1, &e.facility.pubkey(), &e.facility_ata, None);
    send(&mut e.ctx, &[w], &[&e.facility]).await.unwrap();
    let gross = AMOUNT / 5 + per;
    let fee = (gross as u128 * 75 / 10_000) as u64;
    assert_eq!(balance(&mut e.ctx, &e.facility_ata).await, gross - fee);
    assert_eq!(balance(&mut e.ctx, &e.treasury_ata).await, fee);
    println!("4. mốc 1 xác nhận; cơ sở rút {} , phí Solva {}", gross - fee, fee);

    // 5. Thử rút tiền của khách.
    let steal = withdraw_ix(&e, &buyer, 1, &e.solva_op.pubkey(), &e.solva_ata, None);
    assert_eq!(code(send(&mut e.ctx, &[steal], &[&e.solva_op]).await), 6008);
    let all = balance(&mut e.ctx, &vault).await;
    let over = withdraw_ix(&e, &buyer, 1, &e.facility.pubkey(), &e.facility_ata, Some(all));
    assert_eq!(code(send(&mut e.ctx, &[over], &[&e.facility]).await), 6009);
    let early = withdraw_ix(&e, &buyer, 1, &buyer, &e.buyer_ata, None);
    assert_eq!(code(send(&mut e.ctx, &[early], &[&e.buyer]).await), 6012);
    // Lệnh không tồn tại (ví dụ "đóng băng hợp đồng"): Anchor InstructionFallbackNotFound = 101.
    let freeze = Instruction { program_id: solva::ID, accounts: vec![solana_sdk::instruction::AccountMeta::new_readonly(e.solva_op.pubkey(), true)], data: anchor_lang::solana_program::hash::hash(b"global:freeze_escrow").to_bytes()[..8].to_vec() };
    assert_eq!(code(send(&mut e.ctx, &[freeze], &[&e.solva_op]).await), 101);
    println!("5. Solva rút: 6008 NotOwner; cơ sở rút quá: 6009; khách rút sớm: 6012; lệnh đóng băng: 101");

    // Cơ sở vẫn phục vụ: không ai kết thúc được hợp đồng.
    set_time(&mut e.ctx, T0 + 200).await;
    let tt = ix(solva::accounts::TriggerTermination { escrow: esc, facility: fac }, solva::instruction::TriggerTermination {});
    assert_eq!(code(send(&mut e.ctx, &[tt.clone()], &[]).await), 6007);

    // 6. Cơ sở đóng cửa: 120 giây không có check-in (lần cuối ở T0+125). Khách tự lấy lại tiền
    //    bằng một giao dịch gồm trigger_termination + withdraw, chỉ khách ký.
    set_time(&mut e.ctx, T0 + 246).await;
    let owed = balance(&mut e.ctx, &vault).await;
    let refund = withdraw_ix(&e, &buyer, 1, &buyer, &e.buyer_ata, None);
    send(&mut e.ctx, &[tt.clone(), refund], &[&e.buyer]).await.unwrap();
    assert_eq!(balance(&mut e.ctx, &e.buyer_ata).await, owed);
    assert_eq!(balance(&mut e.ctx, &vault).await, 0);
    assert_eq!(AMOUNT - gross, owed);
    let f = facility_state(&mut e.ctx, &fac).await;
    assert!(f.closed);
    let s = escrow_state(&mut e.ctx, &esc).await;
    assert_eq!(s.reason, solva::REASON_FACILITY_STOPPED);
    println!("6. cơ sở ngừng phục vụ; khách lấy lại {} (= {} đ)", owed, owed as u128 * 26_000 / 1_000_000);

    // Ghi mẫu dữ liệu thật để kiểm tra bộ giải mã phía frontend (app/scripts/check-codec.ts).
    {
        let ea = e.ctx.banks_client.get_account(esc).await.unwrap().unwrap();
        let fa = e.ctx.banks_client.get_account(fac).await.unwrap().unwrap();
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let s = escrow_state(&mut e.ctx, &esc).await;
        let f = facility_state(&mut e.ctx, &fac).await;
        let create = create_ix(&e, &buyer, 42).data;
        let wd = solva::instruction::Withdraw { amount: Some(123) }.data();
        let json = format!(
            "{{\"escrow\":\"{}\",\"facility\":\"{}\",\"createData\":\"{}\",\"withdrawData\":\"{}\",\"expect\":{{\"buyer\":\"{}\",\"amount\":\"{}\",\"released\":\"{}\",\"facWithdrawn\":\"{}\",\"buyerWithdrawn\":\"{}\",\"confirmed\":{},\"checkins\":{},\"status\":{},\"reason\":{},\"startTs\":\"{}\",\"lastCheckinTs\":\"{}\",\"facCheckins\":\"{}\",\"facLast\":\"{}\",\"closed\":{},\"active\":{}}}}}",
            hex(&ea.data), hex(&fa.data), hex(&create), hex(&wd), buyer, s.amount, s.released, s.fac_withdrawn, s.buyer_withdrawn,
            s.confirmed, s.checkins, s.status, s.reason, s.start_ts, s.last_checkin_ts, f.checkin_count, f.last_checkin_ts, f.closed, f.active_contracts);
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(format!("{dir}/layout-sample.json"), json).unwrap();
    }

    // Sau khi đóng, không check-in hay tạo hợp đồng mới được ở cơ sở này.
    let ci3 = checkin_ix(&e, &buyer, 1);
    assert_eq!(code(send(&mut e.ctx, &[ci3], &[&e.buyer, &e.facility]).await), 6002);
    let c3 = create_ix(&e, &buyer, 3);
    assert_eq!(code(send(&mut e.ctx, &[c3], &[&e.buyer, &e.facility]).await), 6002);
}

#[tokio::test]
async fn closure_applies_to_every_contract_of_the_facility() {
    let mut e = setup().await;
    let buyer = e.buyer.pubkey();
    // Khách thứ hai tại cùng cơ sở.
    let other = Keypair::new();
    let fund = system_instruction::transfer(&e.ctx.payer.pubkey(), &other.pubkey(), 1_000_000_000);
    send(&mut e.ctx, &[fund], &[]).await.unwrap();
    let other_ata = token_account(&mut e.ctx, &e.mint, &other.pubkey()).await;
    let payer = e.ctx.payer.pubkey();
    let m = spl_token::instruction::mint_to(&spl_token::ID, &e.mint, &other_ata, &payer, &[], AMOUNT).unwrap();
    send(&mut e.ctx, &[m], &[]).await.unwrap();

    for (kp, ata) in [(&e.buyer, e.buyer_ata), (&other, other_ata)] {
        let (fac, esc, vault) = pdas(&kp.pubkey(), &e.facility.pubkey(), 7);
        let c = create_ix(&e, &kp.pubkey(), 7);
        send(&mut e.ctx, &[c], &[kp, &e.facility]).await.unwrap();
        let d = ix(solva::accounts::Deposit { buyer: kp.pubkey(), escrow: esc, facility: fac, vault, buyer_token: ata, token_program: spl_token::ID },
                   solva::instruction::Deposit {});
        send(&mut e.ctx, &[d], &[kp]).await.unwrap();
    }
    set_time(&mut e.ctx, T0 + 130).await;
    // Khách đầu gọi kết thúc: cờ closed bật cho cả cơ sở.
    let (fac, esc1, _) = pdas(&buyer, &e.facility.pubkey(), 7);
    send(&mut e.ctx, &[ix(solva::accounts::TriggerTermination { escrow: esc1, facility: fac }, solva::instruction::TriggerTermination {})], &[]).await.unwrap();
    // Khách thứ hai vẫn kết thúc và rút được, ngay cả khi đồng hồ quay lại vùng "còn sống".
    set_time(&mut e.ctx, T0 + 5).await;
    let (_, esc2, _) = pdas(&other.pubkey(), &e.facility.pubkey(), 7);
    let tt = ix(solva::accounts::TriggerTermination { escrow: esc2, facility: fac }, solva::instruction::TriggerTermination {});
    let w = withdraw_ix(&e, &other.pubkey(), 7, &other.pubkey(), &other_ata, None);
    send(&mut e.ctx, &[tt, w], &[&other]).await.unwrap();
    assert_eq!(balance(&mut e.ctx, &other_ata).await, AMOUNT - AMOUNT / 5);
    println!("Cơ sở đóng: khách thứ hai lấy lại {}", AMOUNT - AMOUNT / 5);
}
