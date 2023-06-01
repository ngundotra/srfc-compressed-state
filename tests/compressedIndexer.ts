import * as anchor from "@coral-xyz/anchor";
import {
  ValidDepthSizePair,
  MerkleTree,
  ChangeLogEventV1,
  SPL_NOOP_ADDRESS,
  deserializeChangeLogEventV1,
  ConcurrentMerkleTreeAccount,
  MerkleTreeProof,
  emptyNode,
} from "@solana/spl-account-compression";
import { keccak_256 } from "js-sha3";
import { AssetGroup, getAssetData } from "./getAssetData";

type CrudCreate = {
  assetId: anchor.web3.PublicKey;
  owner: anchor.web3.PublicKey;
  pubkeys: anchor.web3.PublicKey[];
  data: Buffer;
};

type State = {
  assetId: anchor.web3.PublicKey;
  owner: anchor.web3.PublicKey;
};

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

type CompressionCpiEvent = {
  event: anchor.Event;
  changeLogs: ChangeLogEventV1[];
};

function parseCpiEventsWithCompression(
  tx: anchor.web3.TransactionResponse,
  program: anchor.Program
): CompressionCpiEvent[] {
  let orderedIxs = orderInstructions(tx);
  // console.log(orderedIxs);

  let compressionEvents: CompressionCpiEvent[] = [];
  let currentEvent: CompressionCpiEvent = null;
  for (let i = 1; i < orderedIxs.length; i += 1) {
    const ix = orderedIxs[i];

    if (
      ix.programId.toBase58() === program.programId.toBase58() &&
      ix.data.slice(0, 8).equals(CPI_EVENT_IX)
    ) {
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

      if (currentEvent) {
        compressionEvents.push(currentEvent);
      }

      currentEvent = {
        event: program.coder.events.decode(eventData),
        changeLogs: [],
      };
    }

    if (ix.programId.toBase58() === SPL_NOOP_ADDRESS) {
      let changeLog = deserializeChangeLogEventV1(ix.data);
      if (currentEvent) {
        currentEvent.changeLogs.push(changeLog);
      }
    }
  }

  if (currentEvent) {
    compressionEvents.push(currentEvent);
  }
  return compressionEvents;
}

export class CompressedStateIndexer {
  programId: anchor.web3.PublicKey;
  treeId: anchor.web3.PublicKey;
  tree: MerkleTree;
  compressedMap: Map<String, AssetGroup>;
  compressedState: Map<String, Object>;
  numItems: number;

  constructor(
    programId: anchor.web3.PublicKey,
    treeId: anchor.web3.PublicKey,
    config: ValidDepthSizePair
  ) {
    this.programId = programId;
    this.treeId = treeId;
    this.tree = MerkleTree.sparseMerkleTreeFromLeaves([], config.maxDepth);
    this.compressedMap = new Map<String, AssetGroup>();
    this.compressedState = new Map<String, Object>();
    this.numItems = 0;
  }

  handleTransaction(
    tx: anchor.web3.TransactionResponse,
    program: anchor.Program
  ) {
    let cpiEvents = parseCpiEventsWithCompression(tx, program);

    for (const event of cpiEvents) {
      this.handleCpiEvent(event.event, event.changeLogs[0]);
    }
  }

  handleCpiEvent(event: anchor.Event, changeLog: ChangeLogEventV1) {
    if (event.name == "CrudCreate") {
      let assetGroup = event.data as AssetGroup;
      this.createNewState(changeLog.index, assetGroup);
    } else if (event.name === "CrudUpdateBytes") {
      let assetId = event.data.assetId as anchor.web3.PublicKey;
      let newData = event.data.data as Buffer;

      this.updateState(assetId, newData, changeLog);
    } else if (event.name === "CrudDelete") {
      let assetId = event.data.assetId as anchor.web3.PublicKey;
      this.deleteState(assetId, changeLog);
    } else {
      throw new Error("Unrecognized event name: " + event.name);
    }
  }

  hashAssetGroupData(assetGroup: AssetGroup) {
    return Buffer.from(keccak_256.digest(assetGroup.data.slice(8)));
  }

  createNewState(index: number, assetGroup: AssetGroup) {
    let assetId = this.getAssetId(index);

    let leaf = this.hashAssetGroupData(assetGroup);
    this.tree.updateLeaf(index, leaf);
    this.compressedMap.set(assetId.toBase58(), assetGroup);
    this.numItems += 1;
  }

  updateState(
    assetId: anchor.web3.PublicKey,
    newData: Buffer,
    changeLog: ChangeLogEventV1
  ) {
    let assetGroup = this.compressedMap.get(assetId.toBase58())!;
    this.compressedMap.set(assetId.toBase58(), {
      assetId: assetGroup.assetId,
      authority: assetGroup.authority,
      pubkeys: assetGroup.pubkeys,
      data: newData,
    });
    assetGroup = this.compressedMap.get(assetId.toBase58())!;

    // Evict the cache, force chain reload
    this.compressedState.delete(assetId.toBase58());
    this.tree.updateLeaf(changeLog.index, this.hashAssetGroupData(assetGroup));
  }

  deleteState(assetId: anchor.web3.PublicKey, changeLog: ChangeLogEventV1) {
    // Not sure if we want to delete this (ie we want a record of things we indexed & then deleted)
    // so that we never reindex this
    this.compressedMap.set(assetId.toBase58(), {
      assetId: anchor.web3.PublicKey.default,
      authority: anchor.web3.PublicKey.default,
      pubkeys: [],
      data: Buffer.from([]),
    });
    this.compressedState.set(assetId.toBase58(), {});
    this.tree.updateLeaf(changeLog.index, emptyNode(0));
  }

  getAssetId(index: number) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        this.treeId.toBuffer(),
        Buffer.from(new anchor.BN(index).toArray("le", 4)),
      ],
      this.programId
    )[0];
  }

  getAssetGroup(assetId: anchor.web3.PublicKey): AssetGroup {
    return this.compressedMap.get(assetId.toBase58());
  }

  async getRenderedAsset(
    assetId: anchor.web3.PublicKey,
    program: anchor.Program
  ): Promise<Object> {
    let assetAddress = assetId.toBase58();
    if (this.compressedState.has(assetAddress)) {
      return this.compressedState.get(assetAddress);
    } else {
      if (this.compressedMap.has(assetAddress)) {
        let assetGroup = this.compressedMap.get(assetAddress);
        let assetData = await getAssetData(assetGroup, program);
        this.compressedState.set(assetAddress, assetData);
        return assetData;
      } else {
        throw new Error("Asset does not exist");
      }
    }
  }

  async getState(
    assetId: anchor.web3.PublicKey,
    program: anchor.Program
  ): Promise<State> {
    let obj = (await this.getRenderedAsset(assetId, program)) as any;
    console.log("Rendered asset is:", obj);
    return {
      assetId: new anchor.web3.PublicKey(obj.asset_id as string),
      owner: new anchor.web3.PublicKey(obj.owner as string),
    };
  }

  async getStateByIndex(
    index: number,
    program: anchor.Program
  ): Promise<State> {
    return this.getState(this.getAssetId(index), program);
  }

  getProof(index: number) {
    return this.tree.getProof(index);
  }

  async verify(proof: MerkleTreeProof, program: anchor.Program) {
    let cmt = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      program.provider.connection,
      this.treeId,
      "confirmed"
    );
    let proofVerified = MerkleTree.verify(cmt.getCurrentRoot(), proof, false);
    if (!proofVerified) {
      console.log("Verification result:", proofVerified);
      console.log("Root:", cmt.getCurrentRoot());
      console.log("Root:", proof.root);
      throw new Error("Proof invalid");
    }
  }
}
