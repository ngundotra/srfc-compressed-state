use anchor_lang::prelude::*;
use spl_account_compression;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod compressed_state {
    use super::*;

    pub fn init_new_tree(
        ctx: Context<InitTree>,
        max_depth: u32,
        max_buffer_size: u32,
    ) -> Result<()> {
        // invoke spl ac
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
        let new_state = State {
            asset_id: ctx.accounts.tree.key.clone(),
            owner: ctx.accounts.owner.key.clone(),
        };
        let bytes = new_state.try_to_vec().unwrap();
        emit_cpi!({
            CrudCreateBytes {
                payload: bytes.clone(),
            }
        });

        // invoke compression
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
        let leaf: [u8; 32] = anchor_lang::solana_program::hash::hashv(&[&bytes]).to_bytes();
        spl_account_compression::cpi::append(cpi_ctx, leaf)?;
        Ok(())
    }

    pub fn replace(
        ctx: Context<ChangeState>,
        new_state: State,
        old_state: State,
        root: Pubkey,
        leaf_index: u32,
    ) -> Result<()> {
        if *ctx.accounts.owner.key != new_state.owner {
            return Err(ErrorCode::InvalidOwner.into());
        }

        let previous_bytes = old_state.try_to_vec().unwrap();
        let new_bytes = new_state.try_to_vec().unwrap();

        emit_cpi!({
            CrudUpdateBytes {
                payload: new_bytes.clone(),
            }
        });

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
        let previous_leaf: [u8; 32] =
            anchor_lang::solana_program::hash::hashv(&[&previous_bytes]).to_bytes();
        let new_leaf: [u8; 32] = anchor_lang::solana_program::hash::hashv(&[&new_bytes]).to_bytes();
        spl_account_compression::cpi::replace_leaf(
            cpi_ctx,
            root.to_bytes(),
            previous_leaf,
            new_leaf,
            leaf_index,
        )?;
        Ok(())
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid owner")]
    InvalidOwner,
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

#[account]
pub struct State {
    asset_id: Pubkey,
    owner: Pubkey,
}

#[event]
pub struct CrudCreateBytes {
    pub payload: Vec<u8>,
}

#[event]
pub struct CrudUpdateBytes {
    pub payload: Vec<u8>,
}

// pub struct CrudtCreate<P: AccountSerialize + AccountDeserialize + Sized> {
//     payload: P,
// }
// impl<P> borsh::ser::BorshSerialize for CrudtCreate<P>
// where
//     P: borsh::ser::BorshSerialize,
// {
//     fn serialize<W: borsh::maybestd::io::Write>(
//         &self,
//         writer: &mut W,
//     ) -> ::core::result::Result<(), borsh::maybestd::io::Error> {
//         borsh::BorshSerialize::serialize(&self.payload, writer)?;
//         Ok(())
//     }
// }
// impl<P> borsh::de::BorshDeserialize for CrudtCreate<P>
// where
//     P: borsh::BorshDeserialize,
// {
//     fn deserialize(buf: &mut &[u8]) -> ::core::result::Result<Self, borsh::maybestd::io::Error> {
//         Ok(Self {
//             payload: borsh::BorshDeserialize::deserialize(buf)?,
//         })
//     }
// }
// impl<P> anchor_lang::Event for CrudtCreate<P>
// where
//     P: AccountSerialize + AccountDeserialize + Sized,
// {
//     fn data(&self) -> Vec<u8> {
//         let mut d = [158, 23, 22, 123, 251, 96, 205, 150].to_vec();
//         d.append(&mut self.try_to_vec().unwrap());
//         d
//     }
// }
// impl<P> anchor_lang::Discriminator for CrudtCreate<P>
// where
//     P: AccountSerialize + AccountDeserialize + Sized,
// {
//     const DISCRIMINATOR: [u8; 8] = [158, 23, 22, 123, 251, 96, 205, 150];
// }
