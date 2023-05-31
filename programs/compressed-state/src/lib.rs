use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use spl_account_compression;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// pub struct ConcurrentMerkleTree<const MAX_DEPTH: usize, const MAX_BUFFER_SIZE: usize> {
//     pub sequence_number: u64,
//     /// Index of most recent root & changes
//     pub active_index: u64,
//     /// Number of active changes we are tracking
//     pub buffer_size: u64,
//     /// Proof for respective root
//     pub change_logs: [ChangeLog<MAX_DEPTH>; MAX_BUFFER_SIZE],
//     pub rightmost_proof: Path<MAX_DEPTH>,
// }

// pub struct ChangeLog<const MAX_DEPTH: usize> {
//     /// Historical root value before Path was applied
//     pub root: Node,
//     /// Nodes of off-chain merkle tree
//     pub path: [Node; MAX_DEPTH],
//     /// Bitmap of node parity (used when hashing)
//     pub index: u32,
//     pub _padding: u32,
// }

// #[derive(Copy, Clone, Debug, PartialEq, Eq)]
// #[repr(C)]
// pub struct Path<const MAX_DEPTH: usize> {
//     pub proof: [Node; MAX_DEPTH],
//     pub leaf: Node,
//     pub index: u32,
//     pub _padding: u32,
// }

fn get_rightmost_proof_index(
    tree_bytes: &[u8],
    max_depth: u32,
    max_buffer_size: u32,
) -> Result<u32> {
    let changelog_size = 32 + 32 * max_depth + 4 + 4;
    let path_start = 8 + 8 + 8 + changelog_size * max_buffer_size;

    let index_start = path_start + 32 * max_depth + 32;
    let (_, _index_bytes) = tree_bytes.split_at(index_start as usize);
    let (index_bytes, _) = _index_bytes.split_at(4);

    let index = u32::try_from_slice(index_bytes)?;
    Ok(index)
}

fn get_rightmost_proof_index_from_account<'info>(account: &AccountInfo<'info>) -> Result<u32> {
    let merkle_tree_bytes = account.try_borrow_data()?;
    let (header_bytes, rest) = merkle_tree_bytes
        .split_at(spl_account_compression::state::CONCURRENT_MERKLE_TREE_HEADER_SIZE_V1);
    let header =
        spl_account_compression::state::ConcurrentMerkleTreeHeader::try_from_slice(header_bytes)?;
    let merkle_tree_size = spl_account_compression::state::merkle_tree_get_size(&header)?;
    let (tree_bytes, _canopy_bytes) = rest.split_at(merkle_tree_size);
    let rmp_index = get_rightmost_proof_index(
        tree_bytes,
        header.get_max_depth(),
        header.get_max_buffer_size(),
    )?;
    Ok(rmp_index)
}

#[program]
pub mod compressed_state {
    use spl_account_compression::merkle_tree_apply_fn;

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

        let rmp_index = get_rightmost_proof_index_from_account(&ctx.accounts.tree)?;
        msg!("Rmp: {}", rmp_index);

        // Asset ID is a PDA of tree & leaf index it is being minted to
        let asset_id = Pubkey::find_program_address(
            &[ctx.accounts.tree.key.as_ref(), &rmp_index.to_le_bytes()],
            &crate::ID,
        )
        .0;

        let mut bytes = State::DISCRIMINATOR.try_to_vec()?;
        let state_bytes = new_state.try_to_vec().unwrap();
        bytes.extend_from_slice(&state_bytes.clone());
        emit_cpi!({
            CrudCreate {
                owner: ctx.accounts.owner.key.clone(),
                asset_id: asset_id,
                pubkeys: vec![],
                data: bytes.clone(),
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
        let leaf: [u8; 32] = anchor_lang::solana_program::keccak::hashv(&[&state_bytes]).to_bytes();
        msg!("Leaf: {:?}", leaf);
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
        if *ctx.accounts.owner.key != old_state.owner {
            return Err(ErrorCode::InvalidOwner.into());
        }

        let rmp_index = get_rightmost_proof_index_from_account(&ctx.accounts.tree)?;
        msg!("Rmp: {}", rmp_index);

        let previous_bytes = old_state.try_to_vec().unwrap();
        let new_bytes = new_state.try_to_vec().unwrap();

        emit_cpi!({
            CrudUpdateBytes {
                asset_id: old_state.asset_id,
                data: new_bytes.clone(),
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
            anchor_lang::solana_program::keccak::hashv(&[&previous_bytes]).to_bytes();
        let new_leaf: [u8; 32] =
            anchor_lang::solana_program::keccak::hashv(&[&new_bytes]).to_bytes();
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
pub struct CrudCreate {
    pub owner: Pubkey,
    pub asset_id: Pubkey,
    pub pubkeys: Vec<Pubkey>,
    pub data: Vec<u8>,
}

#[event]
pub struct CrudUpdateBytes {
    pub asset_id: Pubkey,
    pub data: Vec<u8>,
}
