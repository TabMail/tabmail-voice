use super::*;
fn run(id: usize, text: &str, connected: bool) -> Value {
    json!({"id":id,"text":text,"connected":connected,"startKnown":false,"endKnown":false})
}
fn surface(id: usize, runs: Vec<Value>) -> Value {
    json!({"id":id,"frame":[0,0,400,200],"runs":runs,"selection":{"complete":true,"ranges":[]}})
}
fn request(surfaces: Vec<Value>, caret: Value) -> Value {
    json!({"surfaces":surfaces,"focusedSurface":1,"complete":true,"caret":caret})
}
fn result(value: &Value) -> Value {
    serde_json::from_slice(&process(&serde_json::to_vec(value).unwrap()).unwrap()).unwrap()
}
fn exact(surface: usize, run: usize, offset: usize) -> Value {
    json!({"status":"exact","surface":surface,"run":run,"offset":offset})
}

#[test]
fn mac_reference_and_identical_neighbor_remain_separate() {
    let text = "first line\n> hello world\nstatus bar\n  ";
    let input = request(
        vec![
            surface(1, vec![run(1, text, false)]),
            surface(2, vec![run(1, text, false)]),
        ],
        exact(1, 1, 18),
    );
    let output = result(&input);
    assert_eq!(output["surfaces"][0]["runs"][0]["text"], text);
    assert_eq!(output["surfaces"][1]["runs"][0]["text"], text);
    assert_eq!(output["caret"]["offset"], 18);
    assert_eq!(&text[..18], "first line\n> hello");
}
#[test]
fn native_utf16_offsets_preserve_unicode_and_literal_markers() {
    let text = "界😀e\u{301} ‸ » \t";
    let input = request(vec![surface(1, vec![run(1, text, false)])], exact(1, 1, 3));
    assert_eq!(result(&input)["caret"]["offset"], 3);
    let mut bad = input;
    bad["caret"]["offset"] = json!(2);
    assert!(process(&serde_json::to_vec(&bad).unwrap()).is_err());
}
#[test]
fn contiguous_runs_redact_across_caret_and_run_boundaries() {
    let input = request(
        vec![surface(
            1,
            vec![run(1, "token=abc", false), run(2, "123456789 after", true)],
        )],
        exact(1, 2, 12),
    );
    let output = result(&input);
    let runs = output["surfaces"][0]["runs"].as_array().unwrap();
    assert_eq!(
        runs.iter()
            .map(|r| r["text"].as_str().unwrap())
            .collect::<String>(),
        "token=[redacted] after"
    );
    assert_eq!(output["caret"]["status"], "exact");
    let mut inside = input;
    inside["caret"]["offset"] = json!(3);
    assert_eq!(result(&inside)["caret"], json!({"status":"withheld"}));
}
#[test]
fn hidden_gap_and_visible_fragments_remain_separate() {
    let mut a = run(1, "Visible! secret-tail", false);
    a["endKnown"] = json!(false);
    let mut b = run(2, "unknown-head. Other visible", false);
    b["startKnown"] = json!(false);
    let output = result(&request(vec![surface(1, vec![a, b])], exact(1, 2, 18)));
    assert_eq!(
        output["surfaces"][0]["runs"][0]["text"],
        "Visible! secret-tail"
    );
    assert_eq!(
        output["surfaces"][0]["runs"][1]["text"],
        "unknown-head. Other visible"
    );
    assert_eq!(output["surfaces"][0]["runs"][1]["connected"], false);
    assert_eq!(output["complete"], true);
    assert_eq!(output["caret"]["offset"], 18);
}
#[test]
fn unknown_edges_preserve_native_caret_and_whitespace() {
    let mut a = run(1, "\n\n unknown123\n", false);
    a["startKnown"] = json!(false);
    let output = result(&request(vec![surface(1, vec![a])], exact(1, 1, 3)));
    assert_eq!(
        output["surfaces"][0]["runs"][0]["text"],
        "\n\n unknown123\n"
    );
    assert_eq!(output["caret"]["status"], "exact");
    assert_eq!(output["caret"]["offset"], 3);
    assert_eq!(output["complete"], true);
}
#[test]
fn empty_terminal_cells_read_as_blanks_without_moving_offsets() {
    // iTerm2 reports a cell nothing was written to (tmux skips blank cells by moving the cursor) as
    // NUL in its accessibility text; on screen it is a blank, so the words around it stay apart.
    let text = "\u{0}\u{0}one\u{0}two\u{0}\u{0}│ right";
    let mut surface = surface(1, vec![run(1, text, false)]);
    surface["selection"] = json!({"complete":true,"ranges":[{"run":1,"start":2,"end":9}]});
    let output = result(&request(vec![surface], exact(1, 1, 6)));
    assert_eq!(
        output["surfaces"][0]["runs"][0]["text"],
        "  one two  │ right"
    );
    assert!(!output["renderedText"].as_str().unwrap().contains('\u{0}'));
    assert_eq!(output["caret"]["offset"], 6);
    assert_eq!(output["selectedText"], "one two");
    assert_eq!(output["selectionComplete"], true);
}
#[test]
fn the_right_half_of_a_wide_character_is_part_of_it() {
    // iTerm2 writes NUL for the second cell of a double-width character too: dropped, not a blank,
    // while a cell after it that nothing was written to is still a blank. Which characters are double
    // width depends on iTerm2's settings, so a NUL after any non-ASCII character is taken for a half.
    for (native, expected) in [
        ("日\u{0}本\u{0}語\u{0} ok", "日本語 ok"),
        ("안\u{0}녕\u{0}\u{0}하\u{0}", "안녕 하"),
        ("❤\u{FE0F}\u{0}ok 👍🏽\u{0}.", "❤\u{FE0F}ok 👍🏽."),
        ("🇺🇸\u{0}x", "🇺🇸x"),
        (
            "か\u{3099}\u{0}x #\u{FE0F}\u{20E3}\u{0}y",
            "か\u{3099}x #\u{FE0F}\u{20E3}y",
        ),
        ("п\u{0}а\u{0}\u{0}ü\u{0}", "па ü"),
        ("e\u{301}\u{0}x a\u{0}b", "e\u{301}x a b"),
    ] {
        let output = result(&request(
            vec![surface(1, vec![run(1, native, false)])],
            json!({"status":"unavailable"}),
        ));
        assert_eq!(
            output["surfaces"][0]["runs"][0]["text"], expected,
            "{native:?}"
        );
    }
    // Native offsets after a dropped half move back by the halves before them; one on a half is
    // the end of its character.
    let native = "日\u{0}本\u{0}語\u{0} ok";
    let mut s = surface(1, vec![run(1, native, false)]);
    s["selection"] = json!({"complete":true,"ranges":[{"run":1,"start":2,"end":6}]});
    let output = result(&request(vec![s], exact(1, 1, 7)));
    assert_eq!(output["selectedText"], "本語");
    assert_eq!(output["caret"]["offset"], 4);
    let output = result(&request(
        vec![surface(1, vec![run(1, native, false)])],
        exact(1, 1, 1),
    ));
    assert_eq!(output["caret"]["offset"], 1);
}
#[test]
fn dropped_halves_move_offsets_in_every_unit_and_across_connected_runs() {
    let caret = |native: &str, offset: usize, unit: &str| {
        let mut input = request(
            vec![surface(1, vec![run(1, native, false)])],
            exact(1, 1, offset),
        );
        input["offsetUnit"] = json!(unit);
        result(&input)["caret"]["offset"].clone()
    };
    // A half after a character outside the BMP: native UTF-16 offsets on either side of it.
    for (native, expected) in [(2, 2), (3, 2), (4, 3)] {
        assert_eq!(caret("👍\u{0}x", native, "utf16"), expected, "{native}");
    }
    // Scalar native offsets, mapped to UTF-16 in the cleaned text.
    for (native, expected) in [(1, 2), (2, 2), (3, 3), (5, 5), (6, 5), (7, 6)] {
        assert_eq!(
            caret("👍\u{0}x 日\u{0}y", native, "scalar"),
            expected,
            "{native}"
        );
    }
    // A run connected to one with dropped halves starts where the cleaned text ends.
    let mut s = surface(
        1,
        vec![run(1, "日\u{0}本\u{0}", false), run(2, "ab cd", true)],
    );
    s["selection"] =
        json!({"complete":true,"ranges":[{"run":1,"start":2,"end":4},{"run":2,"start":0,"end":2}]});
    let output = result(&request(vec![s], exact(1, 2, 3)));
    assert_eq!(output["caret"]["offset"], 3);
    assert_eq!(
        output["caret"]["renderedOffset"].as_u64().unwrap(),
        output["surfaces"][0]["runs"][1]["renderedOffset"]
            .as_u64()
            .unwrap()
            + 3
    );
    assert_eq!(output["selectedText"], "本ab");
    assert_eq!(output["selectionComplete"], true);
    // After ASCII punctuation, as after a letter, a NUL is a blank.
    let output = result(&request(
        vec![surface(1, vec![run(1, "a:\u{0}b.\u{0}c", false)])],
        json!({"status":"unavailable"}),
    ));
    assert_eq!(output["surfaces"][0]["runs"][0]["text"], "a: b. c");
}
#[test]
fn blank_cells_are_seen_by_redaction() {
    // Redaction reads the blanks: a token after a skipped cell is still a bearer token, and a value
    // of wide characters stays one value.
    let token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
    let native = format!("Authorization: Bearer\u{0}{token}");
    let mut s = surface(1, vec![run(1, &native, false)]);
    s["selection"] =
        json!({"complete":true,"ranges":[{"run":1,"start":0,"end":native.encode_utf16().count()}]});
    let output = result(&request(vec![s], exact(1, 1, 0)));
    let text = output["surfaces"][0]["runs"][0]["text"].as_str().unwrap();
    assert_eq!(text, "Authorization: Bearer [redacted]");
    assert_eq!(output["selectionComplete"], false);
    let output = result(&request(
        vec![surface(
            1,
            vec![run(1, "DB_PASSWORD=한\u{0}글\u{0}비\u{0}번\u{0}x12", false)],
        )],
        json!({"status":"unavailable"}),
    ));
    assert!(!output["renderedText"].as_str().unwrap().contains("x12"));
    // With iTerm2's ambiguous-width setting, letters such as é and Cyrillic take two cells; their
    // right halves must not split a value away from its redactor.
    for native in [
        "password=Café\u{0}9x7q",
        "token: п\u{0}а\u{0}р\u{0}о\u{0}л\u{0}ь\u{0}42",
        "https://user:Café\u{0}9x7q@example.com/",
    ] {
        let output = result(&request(
            vec![surface(1, vec![run(1, native, false)])],
            json!({"status":"unavailable"}),
        ));
        let rendered = output["renderedText"].as_str().unwrap();
        assert!(rendered.contains("[redacted]"), "{native:?}");
        assert!(
            !rendered.contains("9x7q") && !rendered.contains("42"),
            "{native:?}"
        );
    }
}
#[test]
fn selection_and_caret_are_independent() {
    let mut s = surface(1, vec![run(1, "left selected right", false)]);
    s["selection"]["ranges"] = json!([{"run":1,"start":5,"end":13}]);
    let input = request(vec![s], exact(1, 1, 2));
    let output = result(&input);
    assert_eq!(output["caret"]["offset"], 2);
    assert_eq!(output["selectedText"], "selected");
    assert_eq!(output["selectionComplete"], true);
    let mut unavailable = input;
    unavailable["caret"] = json!({"status":"unavailable"});
    assert_eq!(
        result(&unavailable)["caret"],
        json!({"status":"unavailable"})
    );
}
#[test]
fn selected_secret_never_becomes_actionable_even_with_surviving_endpoints() {
    let mut s = surface(1, vec![run(1, "token=abc123456789", false)]);
    s["selection"]["ranges"] = json!([{"run":1,"start":0,"end":17}]);
    // Replacement still permits annotation,
    // but must never grant permission to replace the user's original selection.
    s["selection"]["ranges"][0]["end"] = json!("token=abc123456789".len());
    let output = result(&request(vec![s], exact(1, 1, 0)));
    assert_eq!(output["selectionComplete"], false);
    assert_eq!(output["selectedText"], privacy::PLACEHOLDER);
    assert_eq!(
        output["surfaces"][0]["selection"]["ranges"][0]["redacted"],
        true
    );
}
#[test]
fn missing_or_wrong_focus_identity_and_overlapping_selection_refuse() {
    for caret in [exact(2, 1, 0), exact(1, 2, 0), exact(1, 1, 100)] {
        let input = request(vec![surface(1, vec![run(1, "text", false)])], caret);
        assert!(process(&serde_json::to_vec(&input).unwrap()).is_err());
    }
    let mut s = surface(1, vec![run(1, "text", false)]);
    s["selection"]["ranges"] = json!([{"run":1,"start":0,"end":3},{"run":1,"start":2,"end":4}]);
    assert!(process(&serde_json::to_vec(&request(vec![s], exact(1, 1, 0))).unwrap()).is_err());
}
#[test]
fn offscreen_caret_and_native_incomplete_acquisition_stay_explicit() {
    let mut input = request(
        vec![surface(1, vec![run(1, "shown", false)])],
        json!({"status":"outsideViewport"}),
    );
    input["complete"] = json!(false);
    let output = result(&input);
    assert_eq!(output["caret"], json!({"status":"outsideViewport"}));
    assert_eq!(output["complete"], false);
    assert_eq!(output["surfaces"][0]["runs"][0]["text"], "shown");
}
#[test]
fn byte_and_structure_budgets_refuse_instead_of_silent_truncation() {
    let input = request(
        vec![surface(1, vec![run(1, &"x".repeat(MAX_BYTES + 1), false)])],
        exact(1, 1, 0),
    );
    assert!(process(&serde_json::to_vec(&input).unwrap()).is_err());
    let input = request(
        vec![surface(1, vec![run(1, "a", false), run(1, "b", false)])],
        exact(1, 1, 0),
    );
    assert!(process(&serde_json::to_vec(&input).unwrap()).is_err());
}

#[test]
fn renderer_anchors_identical_text_by_identity_without_inserting_caret_glyphs() {
    let text = "> hello ‸ world";
    let input = request(
        vec![
            surface(1, vec![run(1, text, false)]),
            surface(2, vec![run(1, text, false)]),
        ],
        exact(1, 1, 7),
    );
    let output = result(&input);
    let rendered = output["renderedText"].as_str().unwrap();
    let caret = number(&output["caret"]["renderedOffset"]).unwrap();
    assert_eq!(
        &rendered[..byte_offset(rendered, caret).unwrap()],
        "[Terminal surface 1]\n> hello"
    );
    assert_eq!(rendered.matches('‸').count(), 2);
    assert!(rendered.ends_with(text));
}
#[test]
fn clipped_selection_keeps_visible_annotation_but_refuses_edit() {
    let mut r = run(1, "unknown. selected end", false);
    r["startKnown"] = json!(false);
    let mut s = surface(1, vec![r]);
    s["selection"]["complete"] = json!(false);
    s["selection"]["ranges"] = json!([{"run":1,"start":0,"end":17}]);
    let output = result(&request(vec![s], json!({"status":"unavailable"})));
    assert_eq!(output["selectionComplete"], false);
    assert_eq!(output["selectedText"], privacy::PLACEHOLDER);
    assert_eq!(output["surfaces"][0]["selection"]["ranges"][0]["start"], 0);
    assert_eq!(output["surfaces"][0]["selection"]["ranges"][0]["end"], 17);
}
#[test]
fn disjoint_selection_cannot_authorize_a_contiguous_replacement() {
    let mut s = surface(1, vec![run(1, "abc xyz", false)]);
    s["selection"]["ranges"] = json!([{"run":1,"start":0,"end":3},{"run":1,"start":4,"end":7}]);
    let output = result(&request(vec![s], exact(1, 1, 0)));
    assert_eq!(output["selectionComplete"], false);
    assert_eq!(
        output["surfaces"][0]["selection"]["ranges"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn ffi_returns_owned_projection_and_empty_output_on_refusal() {
    use crate::ffi::{Buffer, voice_core_buffer_free, voice_core_viewport_json};
    let input = serde_json::to_vec(&request(
        vec![surface(1, vec![run(1, "safe", false)])],
        exact(1, 1, 2),
    ))
    .unwrap();
    for bytes in [input.as_slice(), b"{}"] {
        let mut buffer = Buffer {
            data: std::ptr::null_mut(),
            length: 0,
        };
        let status = unsafe { voice_core_viewport_json(bytes.as_ptr(), bytes.len(), &mut buffer) };
        if bytes == input.as_slice() {
            assert_eq!(status, 0);
            let value: Value = serde_json::from_slice(unsafe {
                std::slice::from_raw_parts(buffer.data, buffer.length)
            })
            .unwrap();
            assert_eq!(value["caret"]["offset"], 2);
        } else {
            assert_ne!(status, 0);
            assert!(buffer.data.is_null());
            assert_eq!(buffer.length, 0);
        }
        unsafe { voice_core_buffer_free(buffer) };
    }
}

#[test]
fn scalar_native_offsets_convert_in_shared_core_for_caret_and_selection() {
    let mut s = surface(1, vec![run(1, "界😀e\u{301} chosen tail", false)]);
    s["selection"]["ranges"] = json!([{"run":1,"start":5,"end":11}]);
    let mut input = request(vec![s], exact(1, 1, 2));
    input["offsetUnit"] = json!("scalar");
    let output = result(&input);
    assert_eq!(output["caret"]["offset"], 3);
    assert_eq!(output["selectedText"], "chosen");
    assert_eq!(output["surfaces"][0]["selection"]["ranges"][0]["start"], 6);
    input["caret"]["offset"] = json!(100);
    assert!(process(&serde_json::to_vec(&input).unwrap()).is_err());
    input["offsetUnit"] = json!("cells");
    assert!(process(&serde_json::to_vec(&input).unwrap()).is_err());
}

#[test]
fn terminal_action_wire_matches_agent_consumer_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../context/terminal-action-cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 5);
    for case in cases {
        let output = result(&case["source"]);
        for (key, expected) in case["expected"].as_object().unwrap() {
            assert_eq!(&output[key], expected, "{}: {}", case["name"], key);
        }
    }
}

#[test]
fn focused_selection_cannot_be_overwritten_by_later_split() {
    let mut a = surface(1, vec![run(1, "focused chosen", false)]);
    a["selection"]["ranges"] = json!([{"run":1,"start":8,"end":14}]);
    let mut b = surface(2, vec![run(1, "other wrong", false)]);
    b["selection"]["ranges"] = json!([{"run":1,"start":6,"end":11}]);
    for focused in [1, 2] {
        let mut input = request(vec![a.clone(), b.clone()], exact(focused, 1, 2));
        input["focusedSurface"] = json!(focused);
        let output = result(&input);
        assert_eq!(output["surfaces"].as_array().unwrap().len(), 2);
        assert_eq!(
            output["selectedText"],
            if focused == 1 { "chosen" } else { "wrong" }
        );
        assert_eq!(output["selectionComplete"], true);
        assert_eq!(output["caret"]["surface"], focused);
        assert_eq!(output["caret"]["offset"], 2);
    }
}
#[test]
fn selection_inside_secret_must_not_enable_compose() {
    let mut a = surface(1, vec![run(1, "token=abc123456789 after", false)]);
    a["selection"]["ranges"] = json!([{"run":1,"start":8,"end":12}]);
    let output = result(&request(vec![a], json!({"status":"unavailable"})));
    assert_eq!(output["selectionComplete"], false);
    assert_eq!(output["selectedText"], privacy::PLACEHOLDER);
    assert!(!output.to_string().contains("abc123456789"));
}
#[test]
fn nonbmp_preceding_split_must_preserve_rendered_caret() {
    let mut input = request(
        vec![
            surface(1, vec![run(1, "😀", false)]),
            surface(2, vec![run(1, "abc", false)]),
        ],
        exact(2, 1, 1),
    );
    input["focusedSurface"] = json!(2);
    let output = result(&input);
    let text = output["renderedText"].as_str().unwrap();
    assert_eq!(text, "[Terminal surface 1]\n😀\n[Terminal surface 2]\nabc");
    let at = number(&output["caret"]["renderedOffset"]).unwrap();
    let prefix = String::from_utf16(&text.encode_utf16().take(at).collect::<Vec<_>>()).unwrap();
    assert_eq!(prefix, "[Terminal surface 1]\n😀\n[Terminal surface 2]\na");
}
#[test]
fn gap_must_not_join_recognisable_secret_fragments() {
    let output = result(&request(
        vec![surface(
            1,
            vec![run(1, "token=abc", false), run(2, "123456789 after", false)],
        )],
        exact(1, 2, 12),
    ));
    assert_eq!(output["surfaces"][0]["runs"][0]["text"], "token=abc");
    assert_eq!(output["surfaces"][0]["runs"][1]["text"], "123456789 after");
    assert!(
        output["renderedText"]
            .as_str()
            .unwrap()
            .contains("[viewport gap]")
    );
}
#[test]
fn disconnected_selected_runs_must_refuse_writing() {
    let mut a = surface(1, vec![run(1, "abc", false), run(2, "xyz", false)]);
    a["selection"]["ranges"] = json!([{"run":1,"start":0,"end":3},{"run":2,"start":0,"end":3}]);
    let output = result(&request(vec![a], json!({"status":"unavailable"})));
    assert_eq!(output["selectionComplete"], false);
    assert_eq!(output["selectedText"], privacy::PLACEHOLDER);
}

/// Every helper that reads a terminal as one document runs the same surface cases through the C ABI.
#[test]
fn shared_surface_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../context/surface-cases.json")).unwrap();
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

/// A surface the core built is one the projection takes: its caret and selection come through.
#[test]
fn a_built_surface_projects() {
    let built = result(
        &json!({"surface": {"id": 1, "frame": [0, 0, 400, 200], "offsetUnit": "utf16",
        "count": 10, "startKnown": false, "endKnown": false, "bytes": 100, "spans": [[0, 5], [5, 10]],
        "texts": ["abcde", "fghij"], "selections": [[3, 7]], "caret": null}}),
    );
    let projected = result(
        &json!({"surfaces": [built["surface"]], "focusedSurface": 1, "complete": true,
        "caret": built["caret"]}),
    );
    assert_eq!(projected["selectedText"], "defg");
    assert_eq!(projected["selectionComplete"], true);
    assert_eq!(projected["caret"]["status"], "unavailable");
}

/// A window's collection reads no more surfaces than the limit, and plans no more runs than the
/// limit (the corpus's `collect` cases, at sizes too large to list there).
#[test]
fn a_collection_keeps_to_the_surface_and_run_limits() {
    let empty =
        json!({"selection": {"complete": true, "ranges": []}, "frame": [0, 0, 1, 1], "runs": []});
    let full: Vec<Value> = (0..MAX_SURFACES)
        .map(|id| {
            let mut surface = empty.clone();
            surface["id"] = json!(id);
            surface
        })
        .collect();
    let state = json!({"surfaces": full, "focusedSurface": null, "caret": {"status": "unavailable"},
        "remaining": MAX_BYTES});
    assert_eq!(
        result(&json!({"collect": {"state": state, "next": true}})),
        json!({"read": false, "id": MAX_SURFACES, "bytes": MAX_BYTES})
    );
    let mut taken = empty.clone();
    taken["id"] = json!(MAX_SURFACES);
    let over = json!({"collect": {"state": state, "take": {"surface": taken, "caret": null}, "focused": false}});
    assert_eq!(process(&serde_json::to_vec(&over).unwrap()), Err(1));
    let plan = |runs: usize| {
        let spans: Vec<Value> = (0..runs).map(|at| json!([at, at + 1])).collect();
        result(&json!({"collect": {"plan": {"count": runs, "spans": spans, "bytes": runs}}}))["admit"].clone()
    };
    assert_eq!(plan(MAX_RUNS), true);
    assert_eq!(plan(MAX_RUNS + 1), false);
}
