use super::*;

/// Every helper's suite runs the same cases through the C ABI.
#[test]
fn shared_walk_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../context/walk-cases.json")).unwrap();
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

/// A census of a wide element sees exactly the node budget: the look starts from the element's
/// children (fetching one more than the budget) and visits the last fetched first, so one child
/// more than fits is a look that has not seen the element whole, unless it finds an excluded
/// page among those it visits.
#[test]
fn a_census_sees_the_node_budget_whole() {
    let ask = |request: Value| -> Value {
        serde_json::from_slice(
            &process(json!({ "census": request }).to_string().as_bytes()).unwrap(),
        )
        .unwrap()
    };
    // `excluded`: the child, counted from the first, that is an excluded page.
    let look = |children: u64, excluded: Option<u64>| {
        let start = ask(json!({"start": true}));
        let mut stack: Vec<u64> = (0..children.min(start["children"].as_u64().unwrap())).collect();
        let mut visited = 0u64;
        while let Some(child) = stack.pop() {
            let mut request = json!({"visited": visited});
            if excluded == Some(child) {
                request["page"] = json!("excluded");
            }
            let reply = ask(request);
            match reply["step"].as_str().unwrap() {
                "notSeenWhole" => return "notSeenWhole",
                "excluded" => return "excluded",
                "descend" => assert!(reply["children"].as_u64().unwrap() >= 1),
                step => panic!("{step}"),
            }
            visited += 1;
        }
        "none"
    };
    assert_eq!(look(1, None), "none");
    assert_eq!(look(5_000, None), "none");
    assert_eq!(look(5_001, None), "notSeenWhole");
    // What waits beyond the budget does not hide an excluded page the look reaches.
    assert_eq!(look(5_001, Some(5_000)), "excluded");
    assert_eq!(look(5_001, Some(1)), "excluded");
    assert_eq!(look(5_001, Some(0)), "notSeenWhole");
}
