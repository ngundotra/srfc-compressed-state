import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressedState } from "../target/types/compressed_state";

import {
  ValidDepthSizePair,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
  createAllocTreeIx,
  MerkleTree,
  ConcurrentMerkleTreeAccount,
} from "@solana/spl-account-compression";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CompressedStateIndexer } from "./compressedIndexer";

// function deserializeCrudCreate(
//   program: anchor.Program<CompressedState>,
//   event: CrudCreate
// ): State {
//   let data = program.coder.accounts.decode("State", event.data);
//   return data as State;
// }

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

    let cmt = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      program.provider.connection,
      merkleTree,
      "confirmed"
    );
    let proofVerified = MerkleTree.verify(cmt.getCurrentRoot(), proof);
    if (!proofVerified) {
      console.log("Verification result:", proofVerified);
      console.log("Root:", cmt.getCurrentRoot());
      console.log("Root:", proof.root);
      throw new Error("Proof invalid");
    }
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
          owner: Keypair.generate().publicKey,
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
  });
});
