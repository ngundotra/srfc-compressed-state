import * as anchor from "@coral-xyz/anchor";

export type AssetGroup = {
  assetId: anchor.web3.PublicKey;
  authority: anchor.web3.PublicKey;
  pubkeys: anchor.web3.PublicKey[];
  data: Buffer;
};

export async function getAssetData(
  assetGroup: AssetGroup,
  program: anchor.Program
): Promise<string> {
  let ix = await program.methods
    .getAssetData(assetGroup.data)
    .accounts({ assetId: assetGroup.assetId, authority: assetGroup.authority })
    .remainingAccounts(
      assetGroup.pubkeys.map((key) => {
        return {
          isSigner: false,
          isWritable: false,
          pubkey: key,
        };
      })
    )
    .instruction();
  const mv0 = anchor.web3.MessageV0.compile({
    instructions: [ix],
    payerKey: program.provider.publicKey!,
    recentBlockhash: (await program.provider.connection.getLatestBlockhash())
      .blockhash,
  });
  const vtx = new anchor.web3.VersionedTransaction(mv0);

  let simulationResult = await program.provider
    .simulate(vtx, [], "confirmed")
    .catch((err) => console.error(err));

  if (!simulationResult) {
    throw new Error("Unable to simulate transaction");
  }

  let returnData = simulationResult.returnData;
  if (returnData) {
    let returnDataLog = simulationResult.logs[simulationResult.logs.length - 2];
    let subjects = returnDataLog.split(" ");

    let programId = subjects[2];
    let retData = subjects[3];

    if (programId !== program.programId.toBase58()) {
      throw new Error("Program ID mismatch in return data");
    }

    let data = anchor.utils.bytes.base64.decode(retData);
    return JSON.parse(data.toString("utf-8"));
  }
  return "";
}
