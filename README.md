# Compressed State

Here's a generic State Compression protocol that allows programs to
compress state up <= 300 bytes in total size (arbitrary limit imposed by transaction size when updating state).

This proposal is built on top of SRFC #16 and SRFC #13

# Motivation

It can be expensive to cover the cost of storing state on-chain. This is especially true for businesses that intend to
cover the costs for consumers when interacting with on-chain programs.

The use of SPL Account Compression solves this, however the lack of general infrastructure to index generic usage beyond Metaplex's compressed NFTs has stagnated development. 

Compressed NFTs (cNFTs) have demonstrated exponential cost savings for NFT developers and applications and we seek to expand 
these cost savings to all programs.

Concretely, the problem with generic indexing was that there was no way to link state data with the 32 byte hash that SPL Account compression uses to update it's internal concurrent merkle tree. 

This proposal describes basic infrastructure for programs and indexers to support compression of state up to 300 bytes 
by linking application data via `emit_cpi!` calls with Create/Update/Deleta payloads described in sRFC #16.

# Specification

This specification describes requirements around CPI events and a view function 
that allows indexers to render compressed state into JSON.

1. Issuing compressed state

Issuing compressed state requires that program data be linked with the 32 byte hash that SPL Account Compression 
instruction has in it's `append` instruction.

This is done by emitting a CPI event with the following structure (CudCreate follows from SRFC #16). 
Application data must fit into the `data` field, which is recommended to be less than 300 bytes.

```rust
emit_cpi!(CudCreate {
    /// Unique key to identify the compressed state
    asset_id: Pubkey
    /// Owner of the data
    authority: Pubkey,
    /// Additional keys to use when indexing the compressed state
    pubkeys: Pubkey[],
    /// The data to compress
    data: Vec<u8>
}) 
```
This emission *_must_* be followed with a call to SPL Account Compression's `append` instruction to be
a considered a valid issuance of compressed state & thus indexed appropriately.

Indexers can deserialize this `data` field by complying with step #4.

2. Updating compressed state

Updating compressed state requires both being able to recreate
the old state as well as serializing the new state.

Updating compressed state requires the following payload to be emitted
```rust
emit_cpi!(CudUpdate {
    /// Unique key to identify the compressed state
    asset_id: Pubkey
    /// Owner of the data
    authority: Pubkey,
    /// Additional keys to use when indexing the compressed state
    pubkeys: Pubkey[],
    /// Updated data to compress
    data: Vec<u8>
})
```
This emission *_must_* be followed with a call to SPL Account Compression's `replace_leaf` instruction 
to be considered a valid update of compressed state & thus indexed appropriately.

3. Deleting compressed state

Deleting compressed state only requires replacing existing data with `[0u8; 32]` as the new leaf value.

Deleting compressed state requires the following payload to be emitted
```rust
emit_cpi!(CudDelete {
    /// Unique key to identify the compressed state
    asset_id: Pubkey
})
```
This emission *_must_* be followed with a call to SPL Account Compression's `replace_leaf` instruction 
with a new leaf value consisting of `[0u8; 32]` to be considered a valid update of compressed state & thus indexed appropriately.

4. Viewing compressed state

Application data can be shown as JSON by sending a transaction to a simulated view function on the program that
has the following structure.

```rust
pub fn get_asset_data(ctx: Context<GetAssetData>, data: Vec<u8>) -> Result<()> {
    // Deserialize payload data into JSON here
    anchor_lang::solana_program::program::set_return_data(&json_data.as_bytes());
    Ok(())
}

#[derive(Accounts)]
pub struct GetAssetData<'info> {
    /// CHECK:
    authority: AccountInfo<'info>,
    /// CHECK:
    asset_id: AccountInfo<'info>,
}
```

# Pros / Cons

Pros:
- Cost savings for developers and users
- Indexing with SRFC #17 allows for indexing of compressed state

Cons:
- This specification currently is unable to process state that exceeds 300 bytes in a single transaction

# Implementation
The following program `compressed-state` shows an example of a program that creates & updates compressed state
using SPL account compression.

### Running the tests

This repo requires `anchor` version >= 0.27.0, which is only available by compiling `anchor` from source.

1. Install TS dependencies: `yarn`
2. Compile `coral-xyz/anchor` on `master` and symlink the build to `./eanchor` via `ln -s /path/to/anchor/target/debug|release/anchor ./eanchor`
3. Run the tests: `./eanchor test`