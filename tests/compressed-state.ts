import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressedState } from "../target/types/compressed_state";

import {
  ValidDepthSizePair,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
  createAllocTreeIx,
} from "@solana/spl-account-compression";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CompressedStateIndexer } from "./compressedIndexer";

describe("compressed-state", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.CompressedState as Program<CompressedState>;

  let merkleTreeKp = anchor.web3.Keypair.generate();
  let merkleTree = merkleTreeKp.publicKey;
  let merkleTreeConfig: ValidDepthSizePair = {
    maxDepth: 14,
    maxBufferSize: 64,
  };

  let compressedIndexer = new CompressedStateIndexer(
    program.programId,
    merkleTree,
    merkleTreeConfig
  );

  let randomOwnerKp = Keypair.generate();
  let randomOwner = randomOwnerKp.publicKey;

  it("Initialize tree", async () => {
    // Add your test here.
    const tx = await program.methods
      .initNewTree(merkleTreeConfig.maxDepth, merkleTreeConfig.maxBufferSize)
      .accounts({
        tree: merkleTree,
        splAc: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        noop: SPL_NOOP_PROGRAM_ID,
      })
      .preInstructions([
        await createAllocTreeIx(
          program.provider.connection,
          merkleTree,
          program.provider.publicKey,
          merkleTreeConfig,
          0
        ),
      ])
      .signers([merkleTreeKp])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Your transaction signature", tx);
  });
  it("Create new state", async () => {
    const tx = await program.methods
      .createNewState()
      .accounts({
        owner: program.provider.publicKey,
        tree: merkleTree,
        splAc: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        noop: SPL_NOOP_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Your transaction signature", tx);

    compressedIndexer.handleTransaction(
      await program.provider.connection.getTransaction(tx, {
        commitment: "confirmed",
      }),
      program
    );
  });
  it("Update state", async () => {
    let index = 0;
    let proof = compressedIndexer.getProof(index);

    // TODO: tell the compressed indexer to do this
    await compressedIndexer.verify(proof, program);

    let oldAsset = await compressedIndexer.getStateByIndex(0, program);
    let newAssetId = compressedIndexer.getAssetId(index);
    console.log(
      "Old asset:",
      oldAsset.assetId.toBase58(),
      newAssetId.toBase58()
    );
    const tx = await program.methods
      .replace(
        {
          owner: randomOwner,
          assetId: newAssetId,
        },
        oldAsset,
        new PublicKey(proof.root),
        index
      )
      .accounts({
        owner: program.provider.publicKey,
        tree: merkleTree,
        splAc: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        noop: SPL_NOOP_PROGRAM_ID,
      })
      .remainingAccounts(
        proof.proof.map((p) => {
          return {
            isSigner: false,
            isWritable: false,
            pubkey: new PublicKey(p),
          };
        })
      )
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Your transaction signature", tx);

    compressedIndexer.handleTransaction(
      await program.provider.connection.getTransaction(tx, {
        commitment: "confirmed",
      }),
      program
    );
  });
  it("Delete asset", async () => {
    let index = 0;
    let asset = await compressedIndexer.getStateByIndex(index, program);
    console.log(
      "DELETING ASSET:",
      asset.assetId.toBase58(),
      asset.owner.toBase58()
    );
    let proof = compressedIndexer.getProof(index);
    await compressedIndexer.verify(proof, program);

    const tx = await program.methods
      .delete(asset, new anchor.web3.PublicKey(proof.root), proof.leafIndex)
      .accounts({
        owner: randomOwner,
        tree: merkleTree,
        splAc: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        noop: SPL_NOOP_PROGRAM_ID,
      })
      .remainingAccounts(
        proof.proof.map((p) => {
          return {
            isSigner: false,
            isWritable: false,
            pubkey: new PublicKey(p),
          };
        })
      )
      .signers([randomOwnerKp])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Your transaction signature", tx);

    compressedIndexer.handleTransaction(
      await program.provider.connection.getTransaction(tx, {
        commitment: "confirmed",
      }),
      program
    );
  });
});
