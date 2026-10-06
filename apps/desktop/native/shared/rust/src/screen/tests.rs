use super::*;

fn reply(request: &Value) -> Result<Value, u32> {
    process(&serde_json::to_vec(request).unwrap())
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
}

/// Every helper's suite runs the same cases through the C ABI.
#[test]
fn shared_screen_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../context/screen-cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(
        cases.iter().any(|case| case["refused"] == true)
            && cases.iter().any(|case| case["expected"]["hidden"] == true)
    );
    for case in cases {
        let result = reply(&case["request"]);
        if std::env::var_os("SCREEN_CASES_PRINT").is_some() {
            println!(
                "{} => {}",
                case["name"],
                result
                    .as_ref()
                    .map(Value::to_string)
                    .unwrap_or_else(|status| format!("refused {status}"))
            );
            continue;
        }
        if case["refused"] == true {
            assert_eq!(result, Err(1), "{}", case["name"]);
        } else {
            assert_eq!(result.unwrap(), case["expected"], "{}", case["name"]);
        }
    }
}

/// More text than a read sends is cut, and the summary says the read stopped at its text budget.
#[test]
fn a_read_cut_at_its_text_budget_says_so() {
    let block = "word ".repeat(40_000);
    let request = json!({"appName": "A", "exclusions": {"excludedAppIDs": [], "excludedHosts": []}, "nodes": 2, "milliseconds": 1,
        "blocks": [{"kind": "text", "text": block}, {"kind": "text", "text": block}], "caret": ["", "", ""], "selectionUnavailable": false});
    let result = reply(&request).unwrap();
    assert!(
        result["summary"]
            .as_str()
            .unwrap()
            .ends_with(", stopped: text budget")
    );
    assert!(
        result["logDescription"]
            .as_str()
            .unwrap()
            .contains(", stopped: text budget\n")
    );
    let mut stopped = request;
    stopped["stopped"] = json!("time budget");
    assert!(
        reply(&stopped).unwrap()["summary"]
            .as_str()
            .unwrap()
            .ends_with(", stopped: time budget")
    );
}
