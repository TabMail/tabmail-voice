// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use std::time::{Duration, Instant};
const CORPUS: &str = include_str!("../../../privacy/redaction-cases.json");

fn joined(value: &Value) -> String {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|s| match s.as_str().unwrap() {
            "{redacted}" => PLACEHOLDER,
            text => text,
        })
        .collect()
}
fn case_lines(value: &Value) -> Lines {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line.as_array().unwrap().iter().map(joined).collect())
        .collect()
}
fn scalar(text: &str) -> String {
    redact(&vec![vec![text.into()]]).unwrap()[0][0].clone()
}

#[test]
fn shared_scalar_and_fragmented_corpus() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 357);
    let mut names = std::collections::HashSet::new();
    for case in cases {
        assert!(names.insert(case["name"].as_str().unwrap()));
        let actual = scalar(&joined(&case["text"]));
        assert_eq!(actual, joined(&case["expected"]), "{}", case["name"]);
        assert_eq!(scalar(&actual), actual, "idempotence {}", case["name"]);
    }
    let lines = corpus["lineCases"].as_array().unwrap();
    assert!(lines.len() >= 19);
    for case in lines {
        let actual = redact(&case_lines(&case["lines"])).unwrap();
        assert_eq!(actual, case_lines(&case["expected"]), "{}", case["name"]);
        assert_eq!(redact(&actual).unwrap(), actual);
    }
}

#[test]
fn every_rule_and_case_flag_has_an_observable_fixture() {
    let definitions: Value = serde_json::from_str(DEFINITIONS).unwrap();
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let detects = |rules: &[Rule]| {
        cases.iter().any(|case| {
            redact_with(&vec![vec![joined(&case["text"])]], rules).unwrap()[0][0]
                != joined(&case["expected"])
        })
    };
    let mut flips = 0;
    for index in 0..definitions["redactors"].as_array().unwrap().len() {
        let mut removed = definitions.clone();
        let rule = removed["redactors"].as_array_mut().unwrap().remove(index);
        assert!(
            detects(&compile(&removed.to_string()).unwrap()),
            "removal {}",
            rule["name"]
        );
        // Address-password has no case-dependent literal in its grammar.
        if rule["name"] == "address-password" {
            continue;
        }
        let mut flipped = definitions.clone();
        flipped["redactors"][index]["ignoreCase"] =
            Value::Bool(!rule["ignoreCase"].as_bool().unwrap());
        assert!(
            detects(&compile(&flipped.to_string()).unwrap()),
            "case flag {}",
            rule["name"]
        );
        flips += 1;
    }
    assert_eq!(flips, 17);
}

#[test]
fn hostile_text_stays_under_two_seconds() {
    let cases = [
        ("a.", ""),
        ("token:", ""),
        ("-eyJ", ""),
        ("-----BEGIN A ", ""),
        ("://a:b", ""),
        ("://a:b@", ""),
        ("@://a:b", ""),
        ("Bearer ", ""),
        ("-sk-a", ""),
        (
            "password                                                                ",
            "",
        ),
        ("a", ""),
        ("PRIVATE KEY ", "-----BEGIN "),
        ("PRIVATE KEY ", "-----BEGIN PRIVATE KEY-----\n-----END "),
    ];
    // Compile before timing; cold startup has a separate helper latency gate.
    scalar("");
    for (unit, prefix) in cases {
        let text = format!("{prefix}{}", unit.repeat(200_000usize.div_ceil(unit.len())));
        let start = Instant::now();
        scalar(&text);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "hostile family {unit:?}"
        );
    }
}

#[test]
fn continuation_after_all_long_runs_is_redacted() {
    let a = "a".repeat(400_000);
    let spaces = " ".repeat(400_000);
    let runs = [
        format!("sk-{a}"),
        format!("data token=7{a}"),
        format!("Bearer {a}"),
        format!("password:{spaces}x"),
        format!("Bearer{spaces}x"),
        format!("eyJ{a}"),
        format!("eyJa.eyJ{a}"),
        format!("eyJa.eyJa.{a}"),
        format!("://u:{a}"),
        format!("-----BEGIN PRIVATE KEY-----\n{a}"),
        format!("sk_live_{a}"),
        format!("glpat-{a}"),
        format!("xoxb-{a}"),
    ];
    for run in runs {
        let result = scalar(&format!("{run}\npassword: {}\n", "hunter2x"));
        assert!(result.ends_with(&format!(": {PLACEHOLDER}\n")));
        assert!(!result.contains("hunter"));
    }
}

#[test]
fn benign_large_input_is_not_withheld() {
    let text = "ordinary documentation and prose. ".repeat(65_000);
    assert_eq!(scalar(&text), text);
}

#[test]
fn actual_engine_failure_withholds_tail_after_successful_match() {
    let text = format!(
        "token={}\npassword:{}x\nprivate-tail-sentinel",
        "abc123def",
        " ".repeat(1_000_100)
    );
    assert_eq!(scalar(&text), format!("token={PLACEHOLDER}{PLACEHOLDER}"));
}

#[test]
fn unicode_boundaries_and_empty_structure() {
    assert_eq!(redact(&vec![]).unwrap(), Lines::new());
    assert_eq!(
        redact(&vec![vec![], vec![String::new()]]).unwrap(),
        vec![Vec::<String>::new(), vec![String::new()]]
    );
    let pieces = vec![vec![
        "😀e\u{301} ".into(),
        "password: ".into(),
        "hunter".into(),
        "2x".into(),
        " 🐚".into(),
    ]];
    let result = redact(&pieces).unwrap();
    assert_eq!(
        result,
        vec![vec!["😀e\u{301} ", "password: ", PLACEHOLDER, "", " 🐚"]]
    );
}

#[test]
fn invalid_definitions_are_refused() {
    for change in ["pattern", "replacement", "ignoreCase"] {
        let mut value: Value = serde_json::from_str(DEFINITIONS).unwrap();
        value["redactors"][0][change] = match change {
            "pattern" => Value::String("(".into()),
            "replacement" => Value::String("$999".into()),
            _ => Value::Null,
        };
        assert!(compile(&value.to_string()).is_err());
    }
}

#[test]
fn corpus_is_nonvacuous_and_contains_no_complete_secret_per_source_line() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(
        cases
            .iter()
            .any(|c| joined(&c["text"]) != joined(&c["expected"]))
    );
    assert!(cases.iter().any(|c| !joined(&c["text"]).is_empty() && joined(&c["text"]) == joined(&c["expected"])));
    let lines = corpus["lineCases"].as_array().unwrap();
    let names: std::collections::HashSet<_> =
        lines.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names.len(), lines.len());
    for (index, line) in CORPUS.lines().enumerate() {
        assert_eq!(scalar(line), line, "fixture source line {}", index + 1);
    }
}

#[test]
fn definition_schema_guards_survive_generator_removal() {
    let original: Value = serde_json::from_str(DEFINITIONS).unwrap();
    for (field, value) in [
        ("name", Value::String("Uppercase".into())),
        ("name", Value::String("bad\nname".into())),
        ("description", Value::String(String::new())),
        ("pattern", Value::Null),
        ("replacement", Value::Null),
        ("replacement", Value::String("$0{placeholder}".into())),
        ("replacement", Value::String("$1".into())),
        ("replacement", Value::String(String::new())),
    ] {
        let mut changed = original.clone();
        changed["redactors"][0][field] = value;
        assert!(compile(&changed.to_string()).is_err(), "{field}");
    }
    let mut duplicate = original.clone();
    let item = duplicate["redactors"][0].clone();
    duplicate["redactors"].as_array_mut().unwrap().push(item);
    assert!(compile(&duplicate.to_string()).is_err());
    for value in [Value::Null, Value::Array(vec![])] {
        let mut changed = original.clone();
        changed["redactors"] = value;
        assert!(compile(&changed.to_string()).is_err());
    }
    for value in [
        Value::Null,
        Value::String(String::new()),
        Value::String("$1".into()),
        Value::String("a\\b".into()),
    ] {
        let mut changed = original.clone();
        changed["placeholder"] = value;
        assert!(compile(&changed.to_string()).is_err());
    }
}

#[test]
fn terminal_reference_anchor_preserves_unicode_whitespace_and_literal_markers() {
    let text = "first line\n> 你好😀e\u{301} hello world\nstatus ‸ bar\n  ";
    let caret = text[..text.find(" world").unwrap()].encode_utf16().count();
    let lines = vec![vec![text.into()]];
    let (actual, anchors) =
        redact_anchored(&lines, &[0, caret, text.encode_utf16().count()]).unwrap();
    assert_eq!(actual, lines);
    assert_eq!(
        anchors,
        vec![Some(0), Some(caret), Some(text.encode_utf16().count())]
    );
}

#[test]
fn terminal_anchor_rejects_split_surrogates_and_out_of_source_offsets() {
    let lines = vec![vec!["a😀b".into()]];
    assert_eq!(redact_anchored(&lines, &[2]), Err(Error::InvalidBoundary));
    assert_eq!(redact_anchored(&lines, &[5]), Err(Error::InvalidBoundary));
    assert_eq!(
        redact_anchored(&lines, &[usize::MAX]),
        Err(Error::InvalidBoundary)
    );
    assert_eq!(
        redact_anchored(&lines, &[1, 3]).unwrap().1,
        vec![Some(1), Some(3)]
    );
}

#[test]
fn terminal_anchor_inside_secret_is_withheld_and_later_anchor_moves_exactly() {
    let text = "before token=abc123456789 after";
    let inside = text.find("123").unwrap();
    let after = text.find(" after").unwrap();
    let lines = vec![vec![text[..inside].into(), text[inside..].into()]];
    let (actual, anchors) = redact_anchored(&lines, &[0, inside, after, text.len()]).unwrap();
    let joined = actual[0].concat();
    assert_eq!(joined, "before token=[redacted] after");
    assert_eq!(
        anchors,
        vec![
            Some(0),
            None,
            Some(joined.find(" after").unwrap()),
            Some(joined.len())
        ]
    );
    assert_eq!(actual, redact(&lines).unwrap());
}

#[test]
fn terminal_anchor_withholding_survives_later_redaction_rules() {
    let text = "Bearer abcdefghijklmnop token=abc123456789 done";
    let (actual, anchors) = redact_anchored(
        &vec![vec![text.into()]],
        &[
            text.find("def").unwrap(),
            text.find("123").unwrap(),
            text.len(),
        ],
    )
    .unwrap();
    assert_eq!(actual[0][0], "Bearer [redacted] token=[redacted] done");
    assert_eq!(anchors, vec![None, None, Some(actual[0][0].len())]);
}

#[test]
fn terminal_anchor_accounts_for_outer_line_separators() {
    let lines = vec![vec!["😀".into()], vec!["token=abc123456789 end".into()]];
    let (actual, anchors) = redact_anchored(&lines, &[2, 3, 3 + 21]).unwrap();
    assert_eq!(
        actual,
        vec![
            vec!["😀".to_string()],
            vec!["token=[redacted] end".to_string()]
        ]
    );
    assert_eq!(anchors, vec![Some(2), Some(3), Some(3 + 19)]);
}
