// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{Catalog, frequencies, listed_form};
use serde_json::{Value, json};
use std::path::PathBuf;

/// The word list the app ships.
fn lists() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../dictionary")
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn cases() -> Value {
    serde_json::from_str(include_str!("../../../dictionary/cases.json")).unwrap()
}

/// Every case's words are seen as often as the case says.
#[test]
fn frequency_cases() {
    let cases = cases()["frequencies"].as_array().unwrap().clone();
    assert!(!cases.is_empty());
    for case in cases {
        let reply = frequencies(&json!({"folder": lists(), "words": case["words"]})).unwrap();
        assert_eq!(reply, json!({"zipf": case["zipf"]}), "{}", case["name"]);
    }
}

/// Every list shipped has a case named for it, written in its script, so each list's form is
/// checked against the word list.
#[test]
fn every_list_has_a_frequency_case() {
    let catalog = Catalog::read(std::path::Path::new(&lists())).unwrap();
    let cases = cases()["frequencies"].as_array().unwrap().clone();
    let named: std::collections::HashSet<&str> = cases
        .iter()
        .filter_map(|case| case["list"].as_str())
        .collect();
    let mut missing: Vec<&String> = catalog
        .lists
        .keys()
        .filter(|name| !named.contains(name.as_str()))
        .collect();
    missing.sort();
    assert!(missing.is_empty(), "lists without a case: {missing:?}");
}

/// The term cases' words are seen as often as each case says, so the rule's cases (run by the app's
/// tests with those answers) hold against the real lists.
#[test]
fn term_cases_answers() {
    let cases = cases()["terms"].as_array().unwrap().clone();
    assert!(!cases.is_empty());
    for case in cases {
        let asked = case["zipf"].as_object().unwrap();
        let words: Vec<&String> = asked.keys().collect();
        let reply = frequencies(&json!({"folder": lists(), "words": words})).unwrap();
        let answers: Vec<&Value> = asked.values().collect();
        assert_eq!(
            reply["zipf"].as_array().unwrap().iter().collect::<Vec<_>>(),
            answers,
            "{}",
            case["name"]
        );
    }
}

#[test]
fn a_request_out_of_shape_or_with_a_relative_folder_is_refused() {
    for request in [
        json!({}),
        json!({"folder": lists()}),
        json!({"folder": lists(), "words": "today"}),
        json!({"folder": lists(), "words": [1]}),
        json!({"folder": 1, "words": []}),
        json!({"words": []}),
        json!({"folder": "relative/dictionary", "words": []}),
    ] {
        assert_eq!(frequencies(&request), Err(1), "{request}");
    }
}

/// A catalog of an English and a Russian list, each in NFC with no other step.
const TWO_LISTS: &str = r#"{"lists":{
 "en":{"writings":[["Latn"]],"normal":"NFC","letters":null,"marks":false,"dotless_i":false,"under":null},
 "ru":{"writings":[["Cyrl"]],"normal":"NFC","letters":null,"marks":false,"dotless_i":false,"under":null}
},"letters":{}}"#;

/// A folder without the lists' description answers nothing, so the app sends no screen terms.
#[test]
fn a_folder_without_lists_is_refused() {
    let empty =
        std::env::temp_dir().join(format!("voice-core-no-word-lists-{}", std::process::id()));
    std::fs::create_dir_all(&empty).unwrap();
    let request = json!({"folder": empty.to_string_lossy(), "words": ["Xyvora"]});
    assert_eq!(frequencies(&request), Err(2));
}

/// A word list that can't be read refuses the asks it would answer, rather than calling every word
/// unseen; a word no list is written in still gets its answer.
#[test]
fn a_word_list_that_cant_be_read_refuses_the_ask() {
    let folder = std::env::temp_dir().join(format!(
        "voice-core-broken-word-list-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("languages.json"), TWO_LISTS).unwrap();
    std::fs::write(folder.join("words.txt"), "today\tfifty\n").unwrap();
    let ask =
        |words: &[&str]| frequencies(&json!({"folder": folder.to_string_lossy(), "words": words}));
    assert_eq!(ask(&["Today"]), Err(2));
    assert_eq!(ask(&["Ελλάδα"]), Ok(json!({"zipf": [null]})));
    std::fs::remove_dir_all(&folder).unwrap();
}

/// A word gets the most any list's form of it is seen, and no answer in a script no list is written
/// in or mixing scripts no list mixes.
#[test]
fn a_word_gets_the_most_its_forms_are_seen() {
    let folder = std::env::temp_dir().join(format!("voice-core-word-forms-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("languages.json"),
        r#"{"lists":{
 "de":{"writings":[["Latn"]],"normal":"NFC","letters":null,"marks":false,"dotless_i":false,"under":null},
 "sh":{"writings":[["Cyrl"],["Latn"]],"normal":"NFC","letters":"sr-Latn","marks":false,"dotless_i":false,"under":null},
 "ru":{"writings":[["Cyrl"]],"normal":"NFC","letters":null,"marks":false,"dotless_i":false,"under":null}
},"letters":{"sr-Latn":{"в":"v","е":"e","ћ":"ć","В":"V"}}}"#,
    )
    .unwrap();
    std::fs::write(folder.join("words.txt"), "već\t50\nвећ\t30\n").unwrap();
    let ask =
        |words: &[&str]| frequencies(&json!({"folder": folder.to_string_lossy(), "words": words}));
    assert_eq!(
        ask(&["Већ", "već", "Xyvora", "Ελλάδα", "Tabмail"]),
        Ok(json!({"zipf": [50, 50, 0, null, null]}))
    );
    std::fs::remove_dir_all(&folder).unwrap();
}

/// The first ask, with no word (the app's warm-up at launch), has the word list read in the
/// background, so a dictation's ask doesn't wait for it; an ask then reuses what was read.
#[test]
fn the_first_ask_reads_the_word_list_in_the_background() {
    let folder = std::env::temp_dir().join(format!("voice-core-warm-up-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("languages.json"), TWO_LISTS).unwrap();
    std::fs::write(folder.join("words.txt"), "today\t56\nмосква\t54\n").unwrap();
    let ask =
        |words: &[&str]| frequencies(&json!({"folder": folder.to_string_lossy(), "words": words}));
    assert_eq!(ask(&[]), Ok(json!({"zipf": []})));
    let catalog = super::catalog(&folder).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while catalog.words.get().is_none() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        catalog.words.get().is_some(),
        "the word list was not read after the first ask"
    );
    // The list read is the one answering: removing the file now changes nothing.
    std::fs::remove_file(folder.join("words.txt")).unwrap();
    assert_eq!(ask(&["Today", "Москва"]), Ok(json!({"zipf": [56, 54]})));
    std::fs::remove_dir_all(&folder).unwrap();
}

/// The form a word is looked up under in a list matches how that list writes its words (wordfreq's
/// own steps for the list's language).
#[test]
fn listed_forms() {
    let catalog = Catalog::read(std::path::Path::new(&lists())).unwrap();
    let form = |word: &str, list: &str| listed_form(word, &catalog.lists[list].form);
    assert_eq!(form("Straße", "de"), "strasse");
    assert_eq!(form("STRASSE", "de"), "strasse");
    assert_eq!(form("Diﬀerent ofﬁce", "en"), "different office");
    assert_eq!(form("ΛΌΓΟΣ", "el"), "λόγοσ");
    assert_eq!(form("Λόγος", "el"), "λόγοσ");
    assert_eq!(form("Isparta", "tr"), "ısparta");
    assert_eq!(form("İstanbul", "tr"), "istanbul");
    assert_eq!(form("İstanbul", "en"), "istanbul");
    assert_eq!(form("Don’t", "en"), "don't");
    assert_eq!(form("Cafe\u{301}", "fr"), "café");
    assert_eq!(form("Љубав", "sh"), "ljubav");
    assert_eq!(form("Ljubav", "sh"), "ljubav");
    assert_eq!(form("電腦", "zh"), "电脑");
    assert_eq!(form("ﾃｽﾄ", "ja"), "テスト");
    assert_eq!(form("شكراً", "ar"), "شكرا");
    assert_eq!(form("ـشكرا", "ar"), "شكرا");
    assert_eq!(form("שָׁלוֹם", "he"), "שלום");
    assert_eq!(form("می‌شود", "fa"), "می‌شود");
    assert_eq!(form("Şi ţară", "ro"), "și țară");
    assert_eq!(form("Și", "tr"), "şi");
    // Marks stay where the language keeps them.
    assert_eq!(form("Cafe\u{301}", "en"), "café");
}

/// A catalog out of shape (a list's form missing or unknown, a table of letters that aren't single
/// letters) is not read, so its lists answer nothing.
#[test]
fn a_catalog_out_of_shape_is_refused() {
    let list = |fields: &str| {
        format!(r#"{{"lists":{{"en":{{{fields}}}}},"letters":{{"t":{{"a":"b"}}}}}}"#)
    };
    let good = r#""writings":[["Latn"]],"normal":"NFC","letters":null,"marks":false,"dotless_i":false,"under":null"#;
    let folder =
        std::env::temp_dir().join(format!("voice-core-catalog-shape-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let reads = |text: &str| {
        std::fs::write(folder.join("languages.json"), text).unwrap();
        Catalog::read(&folder).is_some()
    };
    assert!(reads(&list(good)));
    assert!(reads(&list(
        &good.replace(r#""letters":null"#, r#""letters":"t""#)
    )));
    assert!(reads(&list(
        &good.replace(r#""under":null"#, r#""under":"commas""#)
    )));
    for broken in [
        list(&good.replace(r#""normal":"NFC""#, r#""normal":"NFD""#)),
        list(&good.replace(r#""normal":"NFC","#, "")),
        list(&good.replace(r#""letters":null"#, r#""letters":"u""#)),
        list(&good.replace(r#""marks":false"#, r#""marks":"no""#)),
        list(&good.replace(r#""dotless_i":false,"#, "")),
        list(&good.replace(r#""under":null"#, r#""under":"dots""#)),
        list(&good.replace(r#""writings":[["Latn"]]"#, r#""writings":[[]]"#)),
        list(good).replace(r#""a":"b""#, r#""ab":"b""#),
    ] {
        assert!(!reads(&broken), "{broken}");
    }
    std::fs::remove_dir_all(&folder).unwrap();
}
