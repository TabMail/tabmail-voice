// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use serde_json::Value;
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
fn every_redactor_and_case_flag_has_an_observable_fixture() {
    let definitions: Value = serde_json::from_str(DEFINITIONS).unwrap();
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let detects = |redactors: &[Redactor]| {
        cases.iter().any(|case| {
            redact_with(&vec![vec![joined(&case["text"])]], redactors).unwrap()[0][0]
                != joined(&case["expected"])
        })
    };
    let mut flips = 0;
    for index in 0..definitions["redactors"].as_array().unwrap().len() {
        let mut removed = definitions.clone();
        let redactor = removed["redactors"].as_array_mut().unwrap().remove(index);
        assert!(
            detects(&definitions::parse(&removed.to_string()).unwrap()),
            "removal {}",
            redactor["name"]
        );
        if let Some(flag) = redactor["ignoreCase"].as_bool() {
            let mut flipped = definitions.clone();
            flipped["redactors"][index]["ignoreCase"] = Value::Bool(!flag);
            assert!(
                detects(&definitions::parse(&flipped.to_string()).unwrap()),
                "case flag {}",
                redactor["name"]
            );
            flips += 1;
        }
    }
    assert_eq!(flips, 1);
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
        // Short lines, and lines of base64 a label or an indent puts after a space or a tab, as a
        // key's body may start (a log, a message's base64 part, indented YAML).
        ("A\n", ""),
        ("A\u{2029}", ""),
        (" AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", ""),
        ("\tAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \n", ""),
        (
            "  QUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJD\r\n",
            "",
        ),
        // Full lines with short ones between them, and a short line that goes on with other text,
        // as a key's last line is looked for; words after a key's header that end in punctuation.
        ("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\na1\n", "\n"),
        ("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\na1 b\n", "\n"),
        ("a1 ", "-----BEGIN PRIVATE KEY-----\n"),
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
    // A text that starts with one word, then a long blank run, then many keys' lines: whether a
    // key's lines follow the text's first line is looked up once, not per key.
    let line = "A".repeat(40);
    let text = format!(
        "a\n{}{}",
        "\n".repeat(100_000),
        format!("{line}\n{line}\nx y\n").repeat(2_500)
    );
    let start = Instant::now();
    scalar(&text);
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "a first line, a long blank run, then many keys' lines"
    );
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
    let original: Value = serde_json::from_str(DEFINITIONS).unwrap();
    assert!(definitions::parse(DEFINITIONS).is_ok());
    let refused = |changed: &Value| definitions::parse(&changed.to_string()).is_err();
    // Every redactor's every field, gone or the wrong type, is refused; so is a stray field.
    for (index, redactor) in original["redactors"].as_array().unwrap().iter().enumerate() {
        for key in redactor.as_object().unwrap().keys() {
            let optional = ["ignoreCase", "edge", "space", "keepPrefix"].contains(&key.as_str());
            let mut changed = original.clone();
            changed["redactors"][index][key] = Value::Array(vec![]);
            assert!(refused(&changed), "{} {key} wrong type", redactor["name"]);
            if !optional {
                changed["redactors"][index]
                    .as_object_mut()
                    .unwrap()
                    .remove(key);
                assert!(refused(&changed), "{} {key} missing", redactor["name"]);
            }
        }
        let mut changed = original.clone();
        changed["redactors"][index]["pattern"] = Value::String("a".into());
        assert!(refused(&changed), "{} stray field", redactor["name"]);
    }
    for (field, value) in [
        ("name", Value::String("Uppercase".into())),
        ("name", Value::String("bad\nname".into())),
        ("name", Value::String("1name".into())),
        ("description", Value::String(String::new())),
        ("kind", Value::String("regex".into())),
        ("min", Value::from(0)),
        ("body", Value::String(String::new())),
        ("body", Value::String("z-a".into())),
        ("body", Value::String("é".into())),
        ("edge", Value::String("line".into())),
        ("exact", Value::from(16)),
        ("prefixes", Value::Array(vec![])),
        ("prefixes", Value::Array(vec![Value::String(String::new())])),
        (
            "prefixes",
            Value::Array(vec![Value::String("\u{e9}-".into())]),
        ),
    ] {
        let mut changed = original.clone();
        let index = original["redactors"]
            .as_array()
            .unwrap()
            .iter()
            .position(|r| r["name"] == "api-key-sk")
            .unwrap();
        changed["redactors"][index][field] = value;
        assert!(refused(&changed), "{field}");
    }
    let entropy = original["redactors"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["kind"] == "entropy")
        .unwrap();
    // A text a redactor looks for is ASCII: a byte offset in it is a character's.
    let key = original["redactors"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["kind"] == "privateKey")
        .unwrap();
    for field in ["begin", "label", "close"] {
        for value in ["\u{e9}", ""] {
            let mut changed = original.clone();
            changed["redactors"][key][field] = Value::String(value.into());
            assert!(refused(&changed), "{field} {value:?}");
        }
    }
    for (field, value) in [
        ("maxWordShare", Value::from(0.0)),
        ("maxWordShare", Value::from(1.5)),
        ("minBits", Value::from(-1.0)),
        ("padding", Value::String("==".into())),
    ] {
        let mut changed = original.clone();
        changed["redactors"][entropy][field] = value;
        assert!(refused(&changed), "{field}");
    }
    // Every member of a list, after a good one, and every count at and below its least value.
    for (index, redactor) in original["redactors"].as_array().unwrap().iter().enumerate() {
        for field in ["labels", "prefixes"] {
            if redactor.get(field).is_none() {
                continue;
            }
            for member in [Value::Null, Value::from(7), Value::String(String::new())] {
                let mut changed = original.clone();
                changed["redactors"][index][field] =
                    Value::Array(vec![Value::String("a".into()), member]);
                assert!(refused(&changed), "{} {field} member", redactor["name"]);
            }
        }
        for field in [
            "min",
            "exact",
            "wordsMax",
            "fullLine",
            "minLines",
            "digitWithin",
            "minLength",
        ] {
            if redactor.get(field).is_none() {
                continue;
            }
            for value in [Value::from(-1), Value::from(0), Value::from(1.5)] {
                let mut changed = original.clone();
                changed["redactors"][index][field] = value;
                assert!(refused(&changed), "{} {field}", redactor["name"]);
            }
        }
    }
    let mut zero = original.clone();
    zero["redactors"][entropy]["minBits"] = Value::from(0.0);
    assert!(refused(&zero), "minBits 0");
    // A label of any case and script is fine; an empty one is not.
    let named = original["redactors"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["kind"] == "namedValue")
        .unwrap();
    let mut label = original.clone();
    label["redactors"][named]["labels"] = Value::Array(vec![Value::String("pa\u{df}word".into())]);
    assert!(!refused(&label));
    label["redactors"][named]["labels"] = Value::Array(vec![Value::String(String::new())]);
    assert!(refused(&label), "empty label");
    // Every kind's every text and character set, refused when empty, not ASCII or a range written
    // backwards, and taken when it is fine.
    for (index, redactor) in original["redactors"].as_array().unwrap().iter().enumerate() {
        let kind = redactor["kind"].as_str().unwrap();
        let texts: &[&str] = match kind {
            "privateKey" => &["begin", "end", "label", "close"],
            "jsonWebToken" | "addressPassword" => &["start"],
            _ => &[],
        };
        let sets: &[&str] = match kind {
            "token" => &["body"],
            "privateKey" => &["words", "body"],
            "keyLines" => &["base64"],
            "jsonWebToken" => &["part"],
            "entropy" => &["word", "separators", "hex"],
            _ => &[],
        };
        for (fields, bad, good) in [
            (texts, &["", "\u{e9}"][..], "valid"),
            (sets, &["", "\u{e9}", "z-a"][..], "A-Z0-9_-"),
        ] {
            for field in fields {
                for value in bad {
                    let mut changed = original.clone();
                    changed["redactors"][index][field] = Value::String((*value).into());
                    assert!(refused(&changed), "{kind} {field} {value:?}");
                }
                let mut changed = original.clone();
                changed["redactors"][index][field] = Value::String(good.into());
                assert!(!refused(&changed), "{kind} {field} {good}");
            }
        }
    }
    let mut name = original.clone();
    name["redactors"][0]["name"] = Value::String("redactor-17".into());
    assert!(!refused(&name));
    for value in ["17-redactor", "redactor space"] {
        name["redactors"][0]["name"] = Value::String(value.into());
        assert!(refused(&name), "{value}");
    }
    let mut duplicate = original.clone();
    let item = duplicate["redactors"][0].clone();
    duplicate["redactors"].as_array_mut().unwrap().push(item);
    assert!(refused(&duplicate));
    for value in [Value::Null, Value::Array(vec![])] {
        let mut changed = original.clone();
        changed["redactors"] = value;
        assert!(refused(&changed));
    }
    for value in [
        Value::Null,
        Value::String(String::new()),
        Value::String("[gone]".into()),
    ] {
        let mut changed = original.clone();
        changed["placeholder"] = value;
        assert!(refused(&changed));
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

/// Two matches that meet are one run with one marker; an anchor where they meet is inside it and is
/// withheld, and one after it moves past the one marker.
#[test]
fn terminal_anchor_where_two_matches_meet_is_withheld() {
    let first = format!("{}{}", "AK", "IAB2C3D4E5F6G7H8I9");
    let second = format!("{}{}", "AI", "zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4-O5p6");
    let text = format!("see {first}{second} ok");
    let meet = "see ".len() + first.len();
    let (actual, anchors) =
        redact_anchored(&vec![vec![text.clone()]], &[meet, text.len()]).unwrap();
    assert_eq!(actual[0][0], format!("see {PLACEHOLDER} ok"));
    assert_eq!(anchors, vec![None, Some(actual[0][0].len())]);
}

/// An anchor inside a match is withheld, even in the part of it that stays (the `token=` of
/// `token=<value>`); one at the match's start stays where it is.
#[test]
fn terminal_anchor_inside_a_kept_name_is_withheld() {
    let text = "token=abc123456789 x";
    let (_, anchors) = redact_anchored(&vec![vec![text.into()]], &[0, 3, 6, 7]).unwrap();
    assert_eq!(anchors, vec![Some(0), None, None, None]);
}

/// An anchor at the first character a run takes goes before its marker, one at its end after it.
#[test]
fn terminal_anchor_at_a_run_start_goes_before_the_marker() {
    let token = format!("{}{}", "gh", "p_a1B2c3D4e5F6g7H8i9J0k1L2m3");
    let text = format!("see {token} ok");
    let end = "see ".len() + token.len();
    let (actual, anchors) = redact_anchored(&vec![vec![text]], &[4, 5, end, end + 1]).unwrap();
    assert_eq!(actual[0][0], format!("see {PLACEHOLDER} ok"));
    let marker_end = "see ".len() + PLACEHOLDER.len();
    assert_eq!(
        anchors,
        vec![Some(4), None, Some(marker_end), Some(marker_end + 1)]
    );
}

/// A run that takes the line break between two lines leaves it in place, and an anchor after it
/// counts it.
#[test]
fn terminal_anchor_after_a_run_over_a_line_break_counts_the_break() {
    let line = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0".to_string();
    let lines = vec![
        vec![line.clone()],
        vec![line.clone()],
        vec!["(after it)".into()],
    ];
    let end = 2 * line.len() + 2 + "(after it)".len();
    let (actual, anchors) = redact_anchored(&lines, &[end]).unwrap();
    assert_eq!(
        actual,
        vec![
            vec![PLACEHOLDER.to_string()],
            vec![String::new()],
            vec!["(after it)".to_string()]
        ]
    );
    assert_eq!(
        anchors,
        vec![Some(PLACEHOLDER.len() + 2 + "(after it)".len())]
    );
}

/// What `taken` takes out is what `redact` replaces: putting one marker in place of each run gives
/// the redaction for every case.
#[test]
fn taken_runs_are_the_redaction() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let text = joined(&case["text"]);
        let mut rebuilt = String::new();
        let mut copied = 0;
        for run in taken(&text).unwrap() {
            assert!(copied < run.start || copied == 0, "{}", case["name"]);
            rebuilt.push_str(&text[copied..run.start]);
            rebuilt.push_str(PLACEHOLDER);
            copied = run.end;
        }
        rebuilt.push_str(&text[copied..]);
        assert_eq!(rebuilt, scalar(&text), "{}", case["name"]);
    }
}

/// Every byte some redactor takes, in order.
fn taken_bytes(text: &str, redactors: &[Redactor]) -> Vec<bool> {
    let mut taken = vec![false; text.len()];
    for run in runs(&scan::scan(text, &[], redactors)) {
        taken[run].fill(true);
    }
    taken
}

/// The redactors in another order take the same; all of them take everything each takes alone
/// (more only where a key glued to the word before it starts in text another takes).
#[test]
fn the_redaction_holds_every_redactor_alone_in_any_order() {
    let definitions: Value = serde_json::from_str(DEFINITIONS).unwrap();
    let list = definitions["redactors"].as_array().unwrap();
    let with = |redactors: Vec<Value>| {
        let mut changed = definitions.clone();
        changed["redactors"] = Value::Array(redactors);
        definitions::parse(&changed.to_string()).unwrap()
    };
    let reversed = with(list.iter().rev().cloned().collect());
    let rotated = with(
        list[list.len() / 2..]
            .iter()
            .chain(&list[..list.len() / 2])
            .cloned()
            .collect(),
    );
    let alone: Vec<_> = list.iter().map(|r| with(vec![r.clone()])).collect();
    let all = redactors().unwrap();
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let text = joined(&case["text"]);
        let taken = taken_bytes(&text, all);
        assert_eq!(taken_bytes(&text, &reversed), taken, "{}", case["name"]);
        assert_eq!(taken_bytes(&text, &rotated), taken, "{}", case["name"]);
        let mut union = vec![false; text.len()];
        for redactors in &alone {
            for (at, one) in taken_bytes(&text, redactors).into_iter().enumerate() {
                union[at] |= one;
            }
        }
        assert!(
            union.iter().zip(&taken).all(|(&one, &all)| !one || all),
            "{}",
            case["name"]
        );
        assert!(
            union == taken || case["name"].as_str().unwrap().contains("glued"),
            "{}",
            case["name"]
        );
    }
}

/// Every find takes part of what it matched, and both start and end on character boundaries.
#[test]
fn every_find_takes_part_of_its_match_on_character_boundaries() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let text = joined(&case["text"]);
        for found in scan::scan(&text, &[], redactors().unwrap()) {
            let (matched, taken) = (&found.matched, &found.taken);
            assert!(
                matched.start <= taken.start && taken.end <= matched.end && taken.start < taken.end,
                "{}",
                case["name"]
            );
            for at in [matched.start, matched.end, taken.start, taken.end] {
                assert!(text.is_char_boundary(at), "{}", case["name"]);
            }
        }
    }
}

/// A document's text around what a field shows starts and ends where a sentence does (the source
/// window). Cut there, the window still takes all that the whole text takes inside it, so a
/// secret beside the cut is never shown for want of what was cut off.
#[test]
fn a_window_cut_where_a_sentence_ends_takes_all_the_whole_text_takes_inside_it() {
    let definitions: Value = serde_json::from_str(DEFINITIONS).unwrap();
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let samples: Vec<String> = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| joined(&case["text"]))
        .collect();
    // A private key's end line takes the text before it back to the start, whatever it is: its
    // own test follows.
    for definition in definitions["redactors"].as_array().unwrap() {
        if definition["kind"] == "privateKey" {
            continue;
        }
        let mut one = definitions.clone();
        one["redactors"] = Value::Array(vec![definition.clone()]);
        let redactors = definitions::parse(&one.to_string()).unwrap();
        let sample = samples
            .iter()
            .find(|s| s.len() <= 512 && taken_bytes(s, &redactors).contains(&true))
            .unwrap_or_else(|| panic!("no witness for {}", definition["name"]));
        for cut in sample
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(sample.len()))
        {
            for marker in ['.', ',', ';', '!', '?']
                .iter()
                .flat_map(|mark| [" ", "\n", "\u{2003}"].map(|space| format!("{mark}{space}")))
            {
                let whole = format!("{}{marker}{}", &sample[..cut], &sample[cut..]);
                let taken = taken_bytes(&whole, &redactors);
                // A window keeps the punctuation and whitespace it starts or ends at; a find may
                // end on that punctuation (a token's body may hold a dot).
                let after = cut + marker.len();
                for (window, offset) in [(&whole[cut..], cut), (&whole[..after], 0)] {
                    let in_window = taken_bytes(window, &redactors);
                    for (at, &one) in in_window.iter().enumerate() {
                        assert!(
                            one || !taken[offset + at] || (cut..after).contains(&(offset + at)),
                            "{} at {cut} {marker:?}: {:?}",
                            definition["name"],
                            &whole[..]
                        );
                    }
                }
            }
        }
    }
}

/// A key's line that a sentence's end comes before is where a source window can start: what the
/// whole text takes there, a window starting at that sentence's end takes too.
/// A piece edge only lets a find start: a key glued to a key, however short, goes whether or not
/// the screen shows it as a piece of its own, and a key glued to a plain word goes only there.
#[test]
fn a_piece_edge_only_adds_to_what_a_glued_key_takes() {
    let first = ["sk_live_", "abcdefghijklmnopqrst"].concat();
    let mask = |text: &str, edges: &[usize]| {
        let mut taken = vec![false; text.len()];
        for range in taken_with_edges(text, edges).unwrap() {
            taken[range].fill(true);
        }
        taken
    };
    for prefix in ["sk-", "Bearer ", "sk_test_"] {
        for body in ["abc12", "a1B2c3D4e5F6g7H8", "abcdefghijklmnopqrst"] {
            let text = format!("{first}{prefix}{body} after");
            let without = mask(&text, &[]);
            let with = mask(&text, &[first.len()]);
            assert!(
                without.iter().zip(&with).all(|(&was, &now)| !was || now),
                "{prefix}{body}"
            );
            assert!(
                with[..text.len() - " after".len()].iter().all(|&t| t),
                "{prefix}{body}"
            );
        }
        // Alone, a short body stays; glued to a plain word, a key goes only as a piece of its own.
        assert_eq!(scalar(&format!("{prefix}abc12")), format!("{prefix}abc12"));
        let ordinary = format!("notes{prefix}abcdefghijklmnopqrst");
        assert!(
            taken_with_edges(&ordinary, &[]).unwrap().is_empty(),
            "{prefix}"
        );
        assert!(
            !taken_with_edges(&ordinary, &[5]).unwrap().is_empty(),
            "{prefix}"
        );
    }
}

#[test]
fn a_window_starting_on_a_key_line_takes_all_the_whole_text_takes_there() {
    let redactors = redactors().unwrap();
    let line = "QUJD".repeat(16);
    for whole in [
        format!("Note. {line}\nNote. {line} more"),
        format!("{line}\n{line}\nNote. {line} more"),
    ] {
        let taken = taken_bytes(&whole, redactors);
        let cut = whole.rfind(". ").unwrap();
        let window = taken_bytes(&whole[cut..], redactors);
        for (at, &one) in window.iter().enumerate() {
            assert!(one || !taken[cut + at] || at < 2, "{whole:?} at {at}");
        }
    }
}

/// A private key cut by a window anywhere, at a sentence's end: whichever side of it the window
/// holds, every character of the key's body in the window goes (the header with what follows it,
/// or the end line with the text back to the window's start).
#[test]
fn a_private_key_cut_by_a_window_loses_all_of_its_body_in_the_window() {
    let definitions: Value = serde_json::from_str(DEFINITIONS).unwrap();
    let mut one = definitions.clone();
    one["redactors"] = Value::Array(
        definitions["redactors"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["kind"] == "privateKey")
            .cloned()
            .collect(),
    );
    let redactors = definitions::parse(&one.to_string()).unwrap();
    let line = "a1B2c3D4e5".repeat(4);
    let header = "-----BEGIN OPENSSH PRIVATE KEY-----\n";
    let body = format!("{line}\n{line}\na1B2c3==\n");
    let sample = format!("before\n{header}{body}-----END OPENSSH PRIVATE KEY-----\nafter");
    let body_start = sample.find(header).unwrap() + header.len();
    let body = body_start..body_start + body.len();
    for cut in body.start - header.len()..body.end + 4 {
        for marker in [". ", "!\n"] {
            let whole = format!("{}{marker}{}", &sample[..cut], &sample[cut..]);
            let after = cut + marker.len();
            // The body's own characters, where they are in `whole`.
            let secret = |at: usize| {
                if (cut..after).contains(&at) {
                    return false;
                }
                let at = if at >= after { at - marker.len() } else { at };
                body.contains(&at) && !sample.as_bytes()[at].is_ascii_whitespace()
            };
            for (window, offset) in [(&whole[cut..], cut), (&whole[..after], 0)] {
                for (at, one) in taken_bytes(window, &redactors).into_iter().enumerate() {
                    assert!(
                        one || !secret(offset + at),
                        "{cut} {marker:?} {}",
                        offset + at
                    );
                }
            }
        }
    }
}
