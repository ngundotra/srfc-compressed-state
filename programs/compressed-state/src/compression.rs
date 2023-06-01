use anchor_lang::prelude::*;

pub fn get_rightmost_proof_index_from_account<'info>(account: &AccountInfo<'info>) -> Result<u32> {
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

/// Following commented out code is for reference when checking the byte math
/// for deserializing the rightmost proof index
///
///
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
