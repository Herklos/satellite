use sha2::{Sha256, Digest};
use serde_json::Value;

/// Deterministic JSON serialization with sorted keys (recursive).
/// Must produce identical output to the server's stableStringify.
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        Value::Number(n) => serde_json::to_string(n).unwrap_or_else(|_| "null".to_string()),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()),
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(stable_stringify).collect();
            format!("[{}]", items.join(","))
        }
        Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .iter()
                .map(|k| {
                    let key_str = serde_json::to_string(k).unwrap_or_else(|_| "\"\"".to_string());
                    format!("{}:{}", key_str, stable_stringify(&obj[*k]))
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
    }
}

/// Compute SHA-256 hex digest of the stable-stringified data.
pub fn compute_hash(data: &Value) -> String {
    let serialized = stable_stringify(data);
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_stable_stringify_sorts_keys() {
        let input = json!({"b": 2, "a": 1});
        assert_eq!(stable_stringify(&input), r#"{"a":1,"b":2}"#);
    }

    #[test]
    fn test_stable_stringify_nested() {
        let input = json!({"z": {"b": 2, "a": 1}, "a": 0});
        assert_eq!(stable_stringify(&input), r#"{"a":0,"z":{"a":1,"b":2}}"#);
    }

    #[test]
    fn test_stable_stringify_array() {
        let input = json!([3, 1, 2]);
        assert_eq!(stable_stringify(&input), "[3,1,2]");
    }

    #[test]
    fn test_stable_stringify_null() {
        assert_eq!(stable_stringify(&Value::Null), "null");
    }

    #[test]
    fn test_stable_stringify_string() {
        let input = json!("hello");
        assert_eq!(stable_stringify(&input), r#""hello""#);
    }

    #[test]
    fn test_stable_stringify_bool() {
        assert_eq!(stable_stringify(&json!(true)), "true");
    }

    #[test]
    fn test_compute_hash() {
        let input = json!({"hello": "world"});
        let hash = compute_hash(&input);
        assert_eq!(hash, "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588");
    }

    #[test]
    fn test_compute_hash_sorted() {
        let input = json!({"b": 2, "a": 1});
        let hash = compute_hash(&input);
        assert_eq!(hash, "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    }
}
