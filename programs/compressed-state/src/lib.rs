use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use serde::{self, Serialize};
use serde_json;
use spl_account_compression;

mod bs58_pubkey;
mod compression;

use bs58_pubkey::serde_pubkey;
use compression::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

fn create_state(ctx: Context<CreateNewState>, leaf: [u8; 32]) -> Result<()> {
    let seeds = &[
        b"__event_authority".as_ref(),
        &[*ctx.bumps.get("event_authority").unwrap()],
    ];
    let authority_pda_signer = &[&seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.spl_ac.to_account_info(),
        spl_account_compression::cpi::accounts::Modify {
            merkle_tree: ctx.accounts.tree.to_account_info(),
            authority: ctx.accounts.event_authority.to_account_info(),
            noop: ctx.accounts.noop.to_account_info(),
        },
        authority_pda_signer,
    );
    spl_account_compression::cpi::append(cpi_ctx, leaf)?;
    Ok(())
}

fn replace_state(
    ctx: Context<ChangeState>,
    new_leaf: [u8; 32],
    previous_leaf: [u8; 32],
    root: &Pubkey,
    leaf_index: u32,
) -> Result<()> {
    // invoke compression
    let seeds = &[
        b"__event_authority".as_ref(),
        &[*ctx.bumps.get("event_authority").unwrap()],
    ];
    let authority_pda_signer = &[&seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.spl_ac.to_account_info(),
        spl_account_compression::cpi::accounts::Modify {
            authority: ctx.accounts.event_authority.to_account_info(),
            merkle_tree: ctx.accounts.tree.to_account_info(),
            noop: ctx.accounts.noop.to_account_info(),
        },
        authority_pda_signer,
    );
    // let previous_leaf: [u8; 32] =
    //     anchor_lang::solana_program::keccak::hashv(&[&previous_bytes]).to_bytes();
    // let new_leaf: [u8; 32] = anchor_lang::solana_program::keccak::hashv(&[&new_bytes]).to_bytes();
    spl_account_compression::cpi::replace_leaf(
        cpi_ctx,
        root.to_bytes(),
        previous_leaf,
        new_leaf,
        leaf_index,
    )?;
    Ok(())
}

pub fn hash_state(state: &State) -> Result<[u8; 32]> {
    Ok(anchor_lang::solana_program::keccak::hashv(&[&state.try_to_vec()?]).to_bytes())
}

#[program]
pub mod compressed_state {
    use super::*;

    pub fn init_new_tree(
        ctx: Context<InitTree>,
        max_depth: u32,
        max_buffer_size: u32,
    ) -> Result<()> {
        // invoke compression
        let seeds = &[
            b"__event_authority".as_ref(),
            &[*ctx.bumps.get("event_authority").unwrap()],
        ];

        let authority_pda_signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.spl_ac.to_account_info(),
            spl_account_compression::cpi::accounts::Initialize {
                authority: ctx.accounts.event_authority.to_account_info(),
                merkle_tree: ctx.accounts.tree.to_account_info(),
                noop: ctx.accounts.noop.to_account_info(),
            },
            authority_pda_signer,
        );
        spl_account_compression::cpi::init_empty_merkle_tree(cpi_ctx, max_depth, max_buffer_size)?;
        Ok(())
    }

    pub fn create_new_state(ctx: Context<CreateNewState>) -> Result<()> {
        let rmp_index = get_rightmost_proof_index_from_account(&ctx.accounts.tree)?;
        msg!("Rmp: {}", rmp_index);

        // Asset ID is a PDA of tree & leaf index it is being minted to
        let asset_id = Pubkey::find_program_address(
            &[ctx.accounts.tree.key.as_ref(), &rmp_index.to_le_bytes()],
            &crate::ID,
        )
        .0;

        let new_state = State {
            asset_id: asset_id,
            owner: ctx.accounts.owner.key.clone(),
        };

        emit_cpi!({
            CrudCreate {
                authority: ctx.accounts.owner.key.clone(),
                asset_id: asset_id,
                pubkeys: vec![],
                data: emittable_bytes(&new_state)?,
            }
        });

        // invoke compression
        create_state(ctx, hash_state(&new_state)?)?;
        Ok(())
    }

    pub fn delete(
        ctx: Context<ChangeState>,
        state: State,
        root: Pubkey,
        leaf_index: u32,
    ) -> Result<()> {
        if *ctx.accounts.owner.key != state.owner {
            return Err(ErrorCode::InvalidOwner.into());
        }

        emit_cpi!({
            CrudDelete {
                asset_id: state.asset_id,
            }
        });

        replace_state(ctx, [0u8; 32], hash_state(&state)?, &root, leaf_index)?;
        Ok(())
    }

    pub fn replace(
        ctx: Context<ChangeState>,
        new_state: State,
        old_state: State,
        root: Pubkey,
        leaf_index: u32,
    ) -> Result<()> {
        if *ctx.accounts.owner.key != old_state.owner {
            return Err(ErrorCode::InvalidOwner.into());
        }
        if new_state.asset_id != old_state.asset_id {
            return Err(ErrorCode::InvalidAssetId.into());
        }

        let rmp_index = get_rightmost_proof_index_from_account(&ctx.accounts.tree)?;
        msg!("Rmp: {}", rmp_index);

        emit_cpi!({
            CrudUpdateBytes {
                asset_id: old_state.asset_id,
                data: emittable_bytes(&new_state)?,
            }
        });

        // invoke compression
        replace_state(
            ctx,
            hash_state(&new_state)?,
            hash_state(&old_state)?,
            &root,
            leaf_index,
        )?;
        Ok(())
    }

    pub fn get_asset_data(ctx: Context<GetAssetData>, data: Vec<u8>) -> Result<()> {
        let data_disc = &data[..8];
        let json_data = if *data_disc == State::DISCRIMINATOR {
            let state = State::try_from_slice(&data[8..])?;
            serde_json::to_string(&state).unwrap()
        } else {
            "".to_string()
        };
        anchor_lang::solana_program::program::set_return_data(&json_data.as_bytes());
        Ok(())
    }
}

/// Appends the State discriminator to support adding more state types in the future
pub fn emittable_bytes(state: &State) -> Result<Vec<u8>> {
    let mut bytes = State::DISCRIMINATOR.try_to_vec().unwrap();
    let state_bytes = state.try_to_vec().unwrap();
    bytes.extend_from_slice(&state_bytes.clone());
    Ok(bytes)
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid owner")]
    InvalidOwner,
    #[msg("Invalid asset id")]
    InvalidAssetId,
}

#[event_cpi]
#[derive(Accounts)]
pub struct InitTree<'info> {
    /// CHECK:
    #[account(mut)]
    tree: AccountInfo<'info>,
    /// CHECK:
    spl_ac: AccountInfo<'info>,
    /// CHECK:
    noop: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct GetAssetData<'info> {
    /// CHECK:
    authority: AccountInfo<'info>,
    /// CHECK:
    asset_id: AccountInfo<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CreateNewState<'info> {
    owner: Signer<'info>,
    /// CHECK: tree
    #[account(mut)]
    tree: AccountInfo<'info>,
    /// CHECK: program
    spl_ac: AccountInfo<'info>,
    /// CHECK: program
    noop: AccountInfo<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ChangeState<'info> {
    owner: Signer<'info>,
    /// CHECK: program
    #[account(mut)]
    tree: AccountInfo<'info>,
    /// CHECK: program
    spl_ac: AccountInfo<'info>,
    /// CHECK: program
    noop: AccountInfo<'info>,
}

#[derive(Debug, Serialize)]
#[account]
pub struct State {
    #[serde(with = "serde_pubkey")]
    asset_id: Pubkey,
    #[serde(with = "serde_pubkey")]
    owner: Pubkey,
}

#[event]
pub struct CrudCreate {
    pub authority: Pubkey,
    pub asset_id: Pubkey,
    pub pubkeys: Vec<Pubkey>,
    pub data: Vec<u8>,
}

#[event]
pub struct CrudUpdateBytes {
    pub asset_id: Pubkey,
    pub data: Vec<u8>,
}

#[event]
pub struct CrudDelete {
    pub asset_id: Pubkey,
}
