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
  SPL_NOOP_ADDRESS,
  SPL_ACCOUNT_COMPRESSION_ADDRESS,
} from "@solana/spl-account-compression";
import { keccak_256 } from "js-sha3";
import { Keypair, PublicKey } from "@solana/web3.js";

type UniversalIx = {
  programId: anchor.web3.PublicKey;
  keys: anchor.web3.PublicKey[];
  data: Buffer;
};

function orderInstructions(tx: anchor.web3.TransactionResponse): UniversalIx[] {
  let accounts: anchor.web3.PublicKey[] =
    tx.transaction.message.staticAccountKeys;
  accounts = accounts.concat(tx.meta.loadedAddresses.writable ?? []);
  accounts = accounts.concat(tx.meta.loadedAddresses.readonly ?? []);

  let ordered: UniversalIx[] = [];

  let outerIdx = 0;
  let innerIdx = 0;
  for (const outerIxFlat of tx.transaction.message.instructions) {
    let outerIx: UniversalIx = {
      programId: accounts[outerIxFlat.programIdIndex],
      keys: outerIxFlat.accounts.map((idx) => accounts[idx]),
      data: anchor.utils.bytes.bs58.decode(outerIxFlat.data),
    };
    ordered.push(outerIx);

    const innerIxBucket = tx.meta?.innerInstructions[innerIdx];
    if (innerIxBucket && innerIxBucket.index === outerIdx) {
      for (const innerIxFlat of innerIxBucket.instructions) {
        let innerIx: UniversalIx = {
          programId: accounts[innerIxFlat.programIdIndex],
          keys: innerIxFlat.accounts.map((idx) => accounts[idx]),
          data: anchor.utils.bytes.bs58.decode(innerIxFlat.data),
        };
        ordered.push(innerIx);
      }
      innerIdx += 1;
    }
    outerIdx += 1;
  }
  return ordered;
}

const CPI_EVENT_IX: Buffer = Buffer.from([
  0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d,
]);

// Parses CPI events from a transaction for the given anchor program
function parseCpiEvents(
  tx: anchor.web3.TransactionResponse,
  program: anchor.Program
): anchor.Event[] {
  let orderedIxs = orderInstructions(tx);
  // console.log(orderedIxs);

  let events: anchor.Event[] = [];
  for (let i = 1; i < orderedIxs.length; i += 1) {
    const ix = orderedIxs[i];

    if (ix.data.slice(0, 8).equals(CPI_EVENT_IX)) {
      const eventAuthority = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        program.programId
      )[0];

      // CHECK that the event authority is the CPI authority
      if (
        ix.keys.length != 1 ||
        ix.keys[0].toBase58() !== eventAuthority.toBase58()
      ) {
        continue;
      }

      const eventData = anchor.utils.bytes.base64.encode(ix.data.slice(8));
      const event = program.coder.events.decode(eventData);
      events.push(event);
    }
  }

  return events;
}

type CrudCreate = {
  assetId: PublicKey;
  owner: PublicKey;
  pubkeys: PublicKey[];
  data: Buffer;
};

type State = {
  assetId: PublicKey;
  owner: PublicKey;
};

function deserializeCrudCreate(
  program: anchor.Program<CompressedState>,
  event: CrudCreate
): State {
  let data = program.coder.accounts.decode("State", event.data);
  return data as State;
}

class CompressedStateIndexer<S> {
  programId: anchor.web3.PublicKey;
  treeId: anchor.web3.PublicKey;
  tree: MerkleTree;
  compressedState: Map<String, S>;

  constructor(
    programId: anchor.web3.PublicKey,
    treeId: anchor.web3.PublicKey,
    config: ValidDepthSizePair
  ) {
    this.programId = programId;
    this.treeId = treeId;
    this.tree = MerkleTree.sparseMerkleTreeFromLeaves([], config.maxDepth);
    this.compressedState = new Map<String, S>();
  }

  createNewState(index: number, state: S, serializedBytes: Buffer) {
    let assetId = this.getAssetId(index);

    let leaf = Buffer.from(keccak_256.digest(serializedBytes));
    this.tree.updateLeaf(index, leaf);
    this.compressedState.set(assetId.toBase58(), state);
  }

  getAssetId(index: number) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        this.treeId.toBuffer(),
        Buffer.from(new anchor.BN(index).toArray("le", 8)),
      ],
      this.programId
    )[0];
  }

  getState(assetId: PublicKey): S {
    return this.compressedState.get(assetId.toBase58());
  }

  getStateByIndex(index: number): S {
    return this.getState(this.getAssetId(index));
  }

  getProof(index: number) {
    return this.tree.getProof(index);
  }
}

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

    let cpiEvents = parseCpiEvents(
      await program.provider.connection.getTransaction(tx, {
        commitment: "confirmed",
      }),
      program
    );

    let deserializedEvent = deserializeCrudCreate(
      program,
      cpiEvents[0].data as CrudCreate
    );

    compressedIndexer.createNewState(
      0,
      deserializedEvent,
      (cpiEvents[0].data.data as Buffer).slice(8)
    );
    console.log("State:", deserializedEvent);
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
    let oldAsset = compressedIndexer.getStateByIndex(0);
    const tx = await program.methods
      .replace(
        {
          owner: Keypair.generate().publicKey,
          assetId: compressedIndexer.getAssetId(index),
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
