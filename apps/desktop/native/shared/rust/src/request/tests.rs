use super::*;

/// Every helper's suite runs the same cases through the C ABI.
#[test]
fn shared_request_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../context/request-cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.iter().any(|case| case["refused"] == true));
    for case in cases {
        let result = process(&serde_json::to_vec(&case["request"]).unwrap())
            .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap());
        if case["refused"] == true {
            assert_eq!(result, Err(1), "{}", case["name"]);
        } else {
            assert_eq!(result.unwrap(), case["expected"], "{}", case["name"]);
        }
    }
}

/// A paste of 512 KiB is accepted; one byte more is refused.
#[test]
fn a_paste_is_at_most_512_kib() {
    let at = |bytes: usize| {
        process(
            json!({"insert": {"text": "a".repeat(bytes)}})
                .to_string()
                .as_bytes(),
        )
    };
    assert_eq!(at(512 * 1024), Ok(b"{}".to_vec()));
    assert_eq!(at(512 * 1024 + 1), Err(1));
}
