//! Solva: ký quỹ tiền trả trước cho gói dịch vụ dài hạn.
//!
//! Tiền của khách nằm trong một vault (token account do PDA của hợp đồng sở hữu).
//! Tiền chảy sang cơ sở theo mốc dịch vụ; nếu cơ sở ngừng phục vụ, phần chưa dùng
//! thuộc về khách và chính khách rút được.
//!
//! Chương trình có đúng 6 lệnh. Không lệnh nào cần chữ ký của Solva, không có
//! khóa quản trị, không có lệnh sửa điều khoản, đóng băng hay chuyển tiền về Solva.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("4MjW4QLoNE36QmiymyzGo3c3cbNBDbe5t89MhWXF7Eab");

pub const BPS: u64 = 10_000;

pub const STATUS_INIT: u8 = 0;
pub const STATUS_ACTIVE: u8 = 1;
pub const STATUS_ENDED: u8 = 2;

pub const REASON_NONE: u8 = 0;
pub const REASON_COMPLETED: u8 = 1;
pub const REASON_FACILITY_STOPPED: u8 = 2;
pub const REASON_EXPIRED: u8 = 3;

#[program]
pub mod solva {
    use super::*;

    /// Khách và cơ sở cùng ký. Ghi điều khoản cố định, tạo vault rỗng.
    /// Tài khoản cơ sở (Facility PDA) được tạo ở hợp đồng đầu tiên của cơ sở đó.
    pub fn create_escrow(ctx: Context<CreateEscrow>, params: EscrowParams) -> Result<()> {
        require!(params.amount > 0, SolvaError::InvalidParams);
        require!(params.upfront_bps as u64 <= 5_000, SolvaError::InvalidParams);
        require!(params.fee_bps as u64 <= 500, SolvaError::InvalidParams);
        require!(params.periods >= 1 && params.periods <= 60, SolvaError::InvalidParams);
        require!(params.period_secs > 0 && params.closure_secs > 0, SolvaError::InvalidParams);

        let now = Clock::get()?.unix_timestamp;
        let facility = &mut ctx.accounts.facility;
        if facility.authority == Pubkey::default() {
            facility.authority = ctx.accounts.facility_authority.key();
            facility.active_contracts = 0;
            facility.min_contracts = params.min_contracts.max(1);
            facility.checkin_count = 0;
            facility.last_checkin_ts = now;
            facility.closure_secs = params.closure_secs;
            facility.created_ts = now;
            facility.closed = false;
            facility.bump = ctx.bumps.facility;
        }
        require!(!facility.closed, SolvaError::FacilityClosed);

        let e = &mut ctx.accounts.escrow;
        e.buyer = ctx.accounts.buyer.key();
        e.facility = ctx.accounts.facility_authority.key();
        e.mint = ctx.accounts.mint.key();
        e.fee_recipient = ctx.accounts.fee_recipient.key();
        e.nonce = params.nonce;
        e.amount = params.amount;
        e.upfront_bps = params.upfront_bps;
        e.fee_bps = params.fee_bps;
        e.periods = params.periods;
        e.period_secs = params.period_secs;
        e.min_checkins_per_period = params.min_checkins_per_period;
        e.status = STATUS_INIT;
        e.reason = REASON_NONE;
        e.start_ts = 0;
        e.confirmed = 0;
        e.released = 0;
        e.fac_withdrawn = 0;
        e.buyer_withdrawn = 0;
        e.facility_checkins_snapshot = 0;
        e.checkins = 0;
        e.last_checkin_ts = 0;
        e.bump = ctx.bumps.escrow;
        e.vault_bump = ctx.bumps.vault;

        msg!(
            "Solva: điều khoản đã khóa: {} đơn vị, {} mốc x {} giây, trả trước {} bps, phí {} bps",
            e.amount, e.periods, e.period_secs, e.upfront_bps, e.fee_bps
        );
        Ok(())
    }

    /// Khách ký. Chuyển đủ tiền từ ví khách vào vault; hợp đồng bắt đầu chạy
    /// và phần trả trước được mở cho cơ sở.
    pub fn deposit(ctx: Context<Deposit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.facility.closed, SolvaError::FacilityClosed);
        require!(ctx.accounts.escrow.status == STATUS_INIT, SolvaError::InvalidState);

        let amount = ctx.accounts.escrow.amount;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        let facility = &mut ctx.accounts.facility;
        if facility.active_contracts == 0 {
            // Cơ sở vừa có lại hợp đồng đang chạy: cửa sổ phát hiện ngừng phục vụ bắt đầu lại.
            facility.last_checkin_ts = now;
        }
        facility.active_contracts = facility.active_contracts.saturating_add(1);

        let e = &mut ctx.accounts.escrow;
        e.status = STATUS_ACTIVE;
        e.start_ts = now;
        e.released = mul_bps(amount, e.upfront_bps as u64)?;
        e.facility_checkins_snapshot = facility.checkin_count;
        msg!("Solva: {} đơn vị đã vào vault; mở trước {} cho cơ sở", amount, e.released);
        Ok(())
    }

    /// Khách và cơ sở cùng ký. Một lượt check-in là bằng chứng cơ sở còn phục vụ.
    pub fn record_checkin(ctx: Context<RecordCheckin>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let facility = &mut ctx.accounts.facility;
        require!(!facility.closed, SolvaError::FacilityClosed);
        let e = &mut ctx.accounts.escrow;
        require!(e.status == STATUS_ACTIVE, SolvaError::InvalidState);

        facility.checkin_count = facility.checkin_count.saturating_add(1);
        facility.last_checkin_ts = now;
        e.checkins = e.checkins.saturating_add(1);
        e.last_checkin_ts = now;
        msg!("Solva: check-in có chữ ký của khách và cơ sở (lượt {} của hợp đồng)", e.checkins);
        Ok(())
    }

    /// Ai gọi cũng được. Chỉ kiểm tra điều kiện đã khóa lúc ký; không tạo quyết định.
    pub fn confirm_milestone(ctx: Context<ConfirmMilestone>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let facility = &mut ctx.accounts.facility;
        require!(!facility.closed, SolvaError::FacilityClosed);
        let e = &mut ctx.accounts.escrow;
        require!(e.status == STATUS_ACTIVE, SolvaError::InvalidState);
        require!(e.confirmed < e.periods, SolvaError::AllMilestonesConfirmed);

        let m = e.confirmed as i64 + 1;
        let due = e
            .start_ts
            .checked_add(e.period_secs.checked_mul(m).ok_or(SolvaError::MathOverflow)?)
            .ok_or(SolvaError::MathOverflow)?;
        require!(now >= due, SolvaError::MilestoneNotDue);

        let evidence = facility.checkin_count.saturating_sub(e.facility_checkins_snapshot);
        require!(
            evidence >= e.min_checkins_per_period as u64,
            SolvaError::NotEnoughEvidence
        );

        let upfront = mul_bps(e.amount, e.upfront_bps as u64)?;
        let per = (e.amount - upfront) / e.periods as u64;
        let add = if m == e.periods as i64 { e.amount - e.released } else { per };
        e.released = e.released.checked_add(add).ok_or(SolvaError::MathOverflow)?;
        e.confirmed += 1;
        e.facility_checkins_snapshot = facility.checkin_count;
        msg!("Solva: mốc {} xác nhận với {} lượt check-in; mở thêm {}", m, evidence, add);

        if e.confirmed == e.periods {
            e.status = STATUS_ENDED;
            e.reason = REASON_COMPLETED;
            facility.active_contracts = facility.active_contracts.saturating_sub(1);
            msg!("Solva: hợp đồng hoàn thành");
        }
        Ok(())
    }

    /// Ai gọi cũng được. Kết thúc hợp đồng khi dữ liệu trên chuỗi chứng minh lý do.
    /// Khi cơ sở bị xác định ngừng phục vụ, cờ `closed` bật một chiều và áp cho
    /// mọi hợp đồng của cơ sở đó.
    pub fn trigger_termination(ctx: Context<TriggerTermination>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let facility = &mut ctx.accounts.facility;
        let e = &mut ctx.accounts.escrow;
        require!(e.status == STATUS_ACTIVE, SolvaError::InvalidState);

        let silent_for = now.saturating_sub(facility.last_checkin_ts);
        let reason = if facility.closed {
            REASON_FACILITY_STOPPED
        } else if facility.active_contracts >= facility.min_contracts
            && silent_for >= facility.closure_secs
        {
            facility.closed = true;
            msg!(
                "Solva: cơ sở không có check-in nào trong {} giây (ngưỡng {}): ngừng phục vụ",
                silent_for, facility.closure_secs
            );
            REASON_FACILITY_STOPPED
        } else {
            let end = e
                .start_ts
                .checked_add(e.period_secs.checked_mul(e.periods as i64).ok_or(SolvaError::MathOverflow)?)
                .and_then(|x| x.checked_add(facility.closure_secs))
                .ok_or(SolvaError::MathOverflow)?;
            require!(now >= end, SolvaError::FacilityStillServing);
            REASON_EXPIRED
        };

        e.status = STATUS_ENDED;
        e.reason = reason;
        facility.active_contracts = facility.active_contracts.saturating_sub(1);
        msg!("Solva: hợp đồng kết thúc, mã lý do {}", reason);
        Ok(())
    }

    /// Chủ của phần tiền rút phần đã thuộc về mình.
    /// Cơ sở: phần đã giải ngân (trừ phí Solva). Khách: phần chưa giải ngân, sau khi hợp đồng kết thúc.
    /// Bất kỳ ai khác, kể cả Solva: bị từ chối.
    pub fn withdraw(ctx: Context<Withdraw>, amount: Option<u64>) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let e = &ctx.accounts.escrow;
        require!(ctx.accounts.destination.owner == caller, SolvaError::DestinationNotOwned);

        let outstanding_fac = e.released.saturating_sub(e.fac_withdrawn);
        let buyer_key = e.buyer;
        let facility_key = e.facility;
        let nonce = e.nonce.to_le_bytes();
        let bump = [e.bump];
        let seeds: &[&[u8]] = &[b"escrow", buyer_key.as_ref(), facility_key.as_ref(), &nonce, &bump];
        let signer = &[seeds];

        if caller == facility_key {
            let req = amount.unwrap_or(outstanding_fac);
            require!(req <= outstanding_fac, SolvaError::ExceedsReleased);
            require!(req > 0, SolvaError::NothingToWithdraw);
            let fee = mul_bps(req, e.fee_bps as u64)?;
            let net = req - fee;
            let a = &ctx.accounts;
            transfer_from_vault(a.token_program.to_account_info(), a.vault.to_account_info(),
                a.escrow.to_account_info(), a.destination.to_account_info(), signer, net)?;
            if fee > 0 {
                transfer_from_vault(a.token_program.to_account_info(), a.vault.to_account_info(),
                    a.escrow.to_account_info(), a.fee_recipient.to_account_info(), signer, fee)?;
            }
            let e = &mut ctx.accounts.escrow;
            e.fac_withdrawn = e.fac_withdrawn.checked_add(req).ok_or(SolvaError::MathOverflow)?;
            msg!("Solva: cơ sở rút {} (phí {})", net, fee);
        } else if caller == buyer_key {
            require!(e.status == STATUS_ENDED, SolvaError::EscrowActive);
            let owed_buyer = ctx.accounts.vault.amount.saturating_sub(outstanding_fac);
            let req = amount.unwrap_or(owed_buyer);
            require!(req <= owed_buyer, SolvaError::ExceedsReleased);
            require!(req > 0, SolvaError::NothingToWithdraw);
            let a = &ctx.accounts;
            transfer_from_vault(a.token_program.to_account_info(), a.vault.to_account_info(),
                a.escrow.to_account_info(), a.destination.to_account_info(), signer, req)?;
            let e = &mut ctx.accounts.escrow;
            e.buyer_withdrawn = e.buyer_withdrawn.checked_add(req).ok_or(SolvaError::MathOverflow)?;
            msg!("Solva: khách rút {} từ vault về ví của mình", req);
        } else {
            return err!(SolvaError::NotOwner);
        }
        Ok(())
    }
}

fn mul_bps(amount: u64, bps: u64) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(SolvaError::MathOverflow)?
        / BPS as u128;
    Ok(v as u64)
}

fn transfer_from_vault<'info>(
    token_program: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    escrow: AccountInfo<'info>,
    to: AccountInfo<'info>,
    signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new_with_signer(token_program, Transfer { from: vault, to, authority: escrow }, signer),
        amount,
    )
}

// ---------------------------------------------------------------- accounts

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EscrowParams {
    pub nonce: u64,
    pub amount: u64,
    pub upfront_bps: u16,
    pub fee_bps: u16,
    pub periods: u8,
    pub period_secs: i64,
    pub min_checkins_per_period: u32,
    /// Chỉ dùng khi hợp đồng này tạo tài khoản cơ sở lần đầu.
    pub closure_secs: i64,
    /// Chỉ dùng khi hợp đồng này tạo tài khoản cơ sở lần đầu.
    pub min_contracts: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Facility {
    pub authority: Pubkey,
    pub active_contracts: u32,
    pub min_contracts: u32,
    pub checkin_count: u64,
    pub last_checkin_ts: i64,
    pub closure_secs: i64,
    pub created_ts: i64,
    pub closed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub buyer: Pubkey,
    pub facility: Pubkey,
    pub mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub upfront_bps: u16,
    pub fee_bps: u16,
    pub periods: u8,
    pub period_secs: i64,
    pub min_checkins_per_period: u32,
    pub status: u8,
    pub reason: u8,
    pub start_ts: i64,
    pub confirmed: u8,
    pub released: u64,
    pub fac_withdrawn: u64,
    pub buyer_withdrawn: u64,
    pub facility_checkins_snapshot: u64,
    pub checkins: u32,
    pub last_checkin_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
#[instruction(params: EscrowParams)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub facility_authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + Facility::INIT_SPACE,
        seeds = [b"facility", facility_authority.key().as_ref()],
        bump
    )]
    pub facility: Account<'info, Facility>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", buyer.key().as_ref(), facility_authority.key().as_ref(), &params.nonce.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(token::mint = mint)]
    pub fee_recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"facility", escrow.facility.as_ref()], bump = facility.bump)]
    pub facility: Account<'info, Facility>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecordCheckin<'info> {
    pub buyer: Signer<'info>,
    pub facility_authority: Signer<'info>,
    #[account(
        mut,
        has_one = buyer,
        constraint = escrow.facility == facility_authority.key() @ SolvaError::WrongFacility
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"facility", facility_authority.key().as_ref()], bump = facility.bump)]
    pub facility: Account<'info, Facility>,
}

#[derive(Accounts)]
pub struct ConfirmMilestone<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"facility", escrow.facility.as_ref()], bump = facility.bump)]
    pub facility: Account<'info, Facility>,
}

#[derive(Accounts)]
pub struct TriggerTermination<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"facility", escrow.facility.as_ref()], bump = facility.bump)]
    pub facility: Account<'info, Facility>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint)]
    pub destination: Account<'info, TokenAccount>,
    #[account(mut, address = escrow.fee_recipient @ SolvaError::WrongFeeRecipient)]
    pub fee_recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum SolvaError {
    #[msg("Tham số hợp đồng không hợp lệ")]
    InvalidParams,
    #[msg("Trạng thái hợp đồng không cho phép thao tác này")]
    InvalidState,
    #[msg("Cơ sở đã bị xác định ngừng phục vụ")]
    FacilityClosed,
    #[msg("Chữ ký cơ sở không khớp với hợp đồng")]
    WrongFacility,
    #[msg("Mốc chưa tới hạn")]
    MilestoneNotDue,
    #[msg("Chưa đủ lượt check-in làm bằng chứng cơ sở còn phục vụ")]
    NotEnoughEvidence,
    #[msg("Đã xác nhận đủ số mốc")]
    AllMilestonesConfirmed,
    #[msg("Cơ sở vẫn đang phục vụ: dữ liệu không cho phép kết thúc hợp đồng")]
    FacilityStillServing,
    #[msg("Người ký không sở hữu phần tiền nào trong vault này")]
    NotOwner,
    #[msg("Vượt phần được phép rút")]
    ExceedsReleased,
    #[msg("Không còn phần nào để rút")]
    NothingToWithdraw,
    #[msg("Tài khoản nhận không thuộc về người ký")]
    DestinationNotOwned,
    #[msg("Hợp đồng đang thực hiện: phần của khách chưa được mở")]
    EscrowActive,
    #[msg("Tài khoản nhận phí không khớp điều khoản")]
    WrongFeeRecipient,
    #[msg("Tràn số")]
    MathOverflow,
}
