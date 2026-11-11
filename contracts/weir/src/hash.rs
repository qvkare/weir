//! Section 6.2: the commit preimage and its hash. The one host function used is
//! `sha256`, which near-sdk also provides natively, so this runs in plain tests.

use near_sdk::env;

use crate::types::Side;

/// `weir:v1|<series>|<round>|<account_id>|<side>|<size>|<price>|<salt>`.
pub fn preimage(
    series: u32,
    round: u64,
    account_id: &str,
    side: Side,
    size: u64,
    price: u64,
    salt: &str,
) -> String {
    format!(
        "weir:v1|{series}|{round}|{account_id}|{}|{size}|{price}|{salt}",
        side.letter()
    )
}

pub fn commit_hash(
    series: u32,
    round: u64,
    account_id: &str,
    side: Side,
    size: u64,
    price: u64,
    salt: &str,
) -> [u8; 32] {
    env::sha256_array(preimage(series, round, account_id, side, size, price, salt).as_bytes())
}

pub fn is_lower_hex(value: &str, min_len: usize, max_len: usize) -> bool {
    (min_len..=max_len).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `hash` and `bundle`: a sha256 in lowercase hex.
pub fn parse_digest(value: &str) -> Option<[u8; 32]> {
    if !is_lower_hex(value, 64, 64) {
        return None;
    }
    let mut digest = [0u8; 32];
    hex::decode_to_slice(value, &mut digest).ok()?;
    Some(digest)
}

pub fn is_salt(value: &str) -> bool {
    is_lower_hex(value, 32, 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preimage_has_no_padding() {
        assert_eq!(
            preimage(3, 0, "alice.near", Side::Short, 10, 205_000, "00ff"),
            "weir:v1|3|0|alice.near|S|10|205000|00ff"
        );
    }

    #[test]
    fn hash_is_sha256_of_the_preimage() {
        // Python: hashlib.sha256(b"weir:v1|0|0|a.near|L|1|1000|" + b"0" * 32).hexdigest()
        let hash = commit_hash(0, 0, "a.near", Side::Long, 1, 1_000, &"0".repeat(32));
        assert_eq!(
            hex::encode(hash),
            "b8cb1fd8d730d14e83eeee09dbf77f01a86fbb18655fb1e083d06d248c277c1e"
        );
    }

    #[test]
    fn digests_are_64_lowercase_hex() {
        let ok = "ab".repeat(32);
        assert_eq!(parse_digest(&ok), Some([0xab; 32]));
        assert_eq!(parse_digest(&"AB".repeat(32)), None);
        assert_eq!(parse_digest(&"ab".repeat(31)), None);
        assert_eq!(parse_digest(&format!("{}g", "a".repeat(63))), None);
    }

    #[test]
    fn salts_are_32_to_64_lowercase_hex() {
        assert!(is_salt(&"0".repeat(32)));
        assert!(is_salt(&"f".repeat(64)));
        assert!(!is_salt(&"0".repeat(31)));
        assert!(!is_salt(&"0".repeat(65)));
        assert!(!is_salt(&"F".repeat(32)));
    }
}
