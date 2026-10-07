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

/// An element read outside the walk shows something by the walk's rule: drawn, not wholly
/// outside the window, and thicker than a point (at the display's scale); no size says nothing.
#[test]
fn an_element_read_outside_the_walk_is_shown_by_its_rule() {
    let shown = |frame: Value, hidden: bool, scale: f64| {
        let reply = process(
            &serde_json::to_vec(
                &json!({"shown": {"frame": frame, "window": [0, 0, 100, 100],
                "scale": scale, "hidden": hidden}}),
            )
            .unwrap(),
        )
        .unwrap();
        serde_json::from_slice::<Value>(&reply).unwrap()["shown"].clone()
    };
    assert_eq!(shown(json!([10, 10, 50, 20]), false, 1.0), true);
    assert_eq!(shown(json!([10, 10, 50, 20]), true, 1.0), false);
    assert_eq!(
        shown(json!([100, 10, 50, 20]), false, 1.0),
        false,
        "outside the window"
    );
    assert_eq!(
        shown(json!([10, 10, 50, 1]), false, 1.0),
        false,
        "a point thick"
    );
    assert_eq!(shown(json!([10, 10, 50, 2]), false, 1.0), true);
    assert_eq!(
        shown(json!([10, 10, 50, 2]), false, 2.0),
        false,
        "two units at twice the scale"
    );
    assert_eq!(
        shown(json!([10, 10, 0, 0]), false, 1.0),
        true,
        "no size says nothing"
    );
    assert_eq!(shown(json!([10, 10, 0, 5]), false, 1.0), false);
    assert_eq!(shown(Value::Null, false, 1.0), true);
    assert!(process(br#"{"shown":{"frame":[0,0,1,1],"scale":0}}"#).is_err());
    assert!(process(br#"{"shown":[]}"#).is_err());
}
