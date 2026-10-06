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
/// children (fetching one more than the budget), and one child more than fits is a look that has
/// not seen the element whole.
#[test]
fn a_census_sees_the_node_budget_whole() {
    let look = |children: u64| {
        let start: Value = serde_json::from_slice(
            &process(json!({"census": {"start": true}}).to_string().as_bytes()).unwrap(),
        )
        .unwrap();
        let mut queued = children.min(start["children"].as_u64().unwrap());
        let mut visited = 0u64;
        while queued > 0 {
            queued -= 1;
            let reply: Value = serde_json::from_slice(
                &process(
                    json!({"census": {"visited": visited, "queued": queued}})
                        .to_string()
                        .as_bytes(),
                )
                .unwrap(),
            )
            .unwrap();
            match reply["step"].as_str().unwrap() {
                "notSeenWhole" => return "notSeenWhole",
                "descend" => assert!(reply["children"].as_u64().unwrap() >= 1),
                step => panic!("{step}"),
            }
            visited += 1;
        }
        "none"
    };
    assert_eq!(look(1), "none");
    assert_eq!(look(5_000), "none");
    assert_eq!(look(5_001), "notSeenWhole");
}
