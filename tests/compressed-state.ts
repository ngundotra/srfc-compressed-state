import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressedState } from "../target/types/compressed_state";

import {
  DepthSizePair,
  ValidDepthSizePair,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
  createAllocTreeIx,
} from "@solana/spl-account-compression";

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
    console.log("Neehaw");

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
  });
  it("Update state", async () => {
    const tx = await program.methods
      .createNewState()
      .accounts({
        owner: program.provider.publicKey,
        tree: merkleTree,
        splAc: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        noop: SPL_NOOP_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Teehaw");
  });
});
