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

/// A token the terminal wraps over two rows of the box reaches the field read: the rows are the
/// lines the screen shows, redacted as such, and nothing is withheld for a match across a row break.
#[test]
fn a_token_wrapped_over_two_rows_is_not_withheld() {
    let text = "log one    \u{2502}key sk-ReviewWrap1234\nlog two    \u{2502}567890abcdefgh\nlog three  \u{2502}$ ";
    let request = json!({"field": {"maxLength": 20_000, "viewport": {
        "surfaces": [{"id": 1, "frame": [0, 0, 400, 200], "runs": [{"id": 1, "text": text,
            "connected": false, "startKnown": false, "endKnown": false}],
            "selection": {"complete": true, "ranges": []}}],
        "focusedSurface": 1, "complete": true,
        "caret": {"status": "exact", "surface": 1, "run": 1, "offset": text.encode_utf16().count()}}}});
    let reply: Value =
        serde_json::from_slice(&process(request.to_string().as_bytes()).unwrap()).unwrap();
    assert!(reply["value"].is_string(), "the field read was withheld");
}
