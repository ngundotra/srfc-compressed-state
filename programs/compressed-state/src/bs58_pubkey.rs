use anchor_lang::prelude::*;
use serde::{self, Deserializer, Serializer};

/// HACK: in order to render Pubkey as base58 str, we need to implement custom serde
/// otherwise it would render as array of bytes
/// Credit: GPT-4
pub mod serde_pubkey {
    use super::*;
    use anchor_lang::prelude::Pubkey;
    use bs58;

    pub fn serialize<S>(value: &Pubkey, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let s = bs58::encode(value.to_bytes()).into_string();
        serializer.serialize_str(&s)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> std::result::Result<Pubkey, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = <std::string::String as serde::Deserialize>::deserialize(deserializer)?;
        let bytes = bs58::decode(&s)
            .into_vec()
            .map_err(serde::de::Error::custom)?;
        Pubkey::try_from_slice(&bytes).map_err(serde::de::Error::custom)
    }
}
