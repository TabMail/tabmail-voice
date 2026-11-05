// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{MADE_UP, dictionaries, known};
use serde_json::{Value, json};
use std::path::PathBuf;

/// The made-up Hunspell dictionaries of the cases.
fn fixtures() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../dictionary/hunspell")
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn cases(kind: &str) -> Vec<Value> {
    let cases: Value =
        serde_json::from_str(include_str!("../../../dictionary/known-words-cases.json")).unwrap();
    let cases = cases[kind].as_array().unwrap().clone();
    assert!(!cases.is_empty());
    cases
}

#[test]
fn dictionaries_cases() {
    for case in cases("dictionaries") {
        let reply =
            dictionaries(&json!({"languages": case["languages"], "available": case["available"]}))
                .unwrap();
        assert_eq!(
            reply,
            json!({"dictionaries": case["dictionaries"], "unavailable": case["unavailable"], "madeUp": MADE_UP}),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn known_cases() {
    let folder = fixtures();
    for case in cases("known") {
        let reply = known(
            &json!({"folders": [folder], "languages": case["languages"], "words": case["words"]}),
        )
        .unwrap();
        assert_eq!(
            reply,
            json!({"known": case["known"], "unavailable": case["unavailable"], "dictionaries": case["dictionaries"]}),
            "{}",
            case["name"]
        );
    }
}

/// The system keeps its dictionaries in more than one folder: a folder missing is skipped, and where
/// two have a language's, the first's is read.
#[test]
fn the_first_folder_with_a_dictionary_is_read() {
    let first = std::env::temp_dir().join(format!("tabmail-voice-words-{}", std::process::id()));
    std::fs::create_dir_all(&first).unwrap();
    std::fs::write(first.join("en_US.aff"), "SET UTF-8\n").unwrap();
    std::fs::write(first.join("en_US.dic"), "1\nzorvek\n").unwrap();
    let missing = std::env::temp_dir().join("tabmail-voice-no-such-folder");
    let folders = json!([
        missing.to_str().unwrap(),
        first.to_str().unwrap(),
        fixtures()
    ]);
    let reply = known(&json!({"folders": folders, "languages": ["en-US", "ko"], "words": ["zorvek", "today", "회의"]})).unwrap();
    std::fs::remove_dir_all(&first).unwrap();
    assert_eq!(
        reply,
        json!({"known": ["zorvek", "회의"], "unavailable": [], "dictionaries": 2})
    );
}

/// A dictionary that can't be read serves no language, and its language's next dictionary serves it
/// instead: a regional one the loader refuses leaves the language to another of the same language.
#[test]
fn an_unreadable_dictionary_leaves_its_language_to_the_next() {
    let unreadable =
        std::env::temp_dir().join(format!("tabmail-voice-unreadable-{}", std::process::id()));
    std::fs::create_dir_all(&unreadable).unwrap();
    std::fs::write(unreadable.join("en_CA.aff"), "SET NO-SUCH-ENCODING\n").unwrap();
    std::fs::write(unreadable.join("en_CA.dic"), "1\ntoday\n").unwrap();
    let folders = json!([unreadable.to_str().unwrap(), fixtures()]);
    let reply =
        known(&json!({"folders": folders, "languages": ["en-CA"], "words": ["today", "xyvora"]}))
            .unwrap();
    std::fs::remove_dir_all(&unreadable).unwrap();
    assert_eq!(
        reply,
        json!({"known": ["today"], "unavailable": [], "dictionaries": 1})
    );
}

#[test]
fn a_request_out_of_shape_is_refused() {
    let folder = fixtures();
    for request in [
        json!({"languages": ["en"], "words": []}),
        json!({"folders": [folder], "words": []}),
        json!({"folders": [folder], "languages": ["en"]}),
        json!({"folders": [folder], "languages": "en", "words": []}),
        json!({"folders": [folder], "languages": ["en"], "words": [1]}),
        json!({"folders": ["relative/hunspell"], "languages": ["en"], "words": []}),
    ] {
        assert_eq!(known(&request), Err(1), "{request}");
    }
    for request in [
        json!({"available": ["en"]}),
        json!({"languages": ["en"]}),
        json!({"languages": [null], "available": []}),
        json!({"languages": [], "available": {"en": true}}),
    ] {
        assert_eq!(dictionaries(&request), Err(1), "{request}");
    }
}
