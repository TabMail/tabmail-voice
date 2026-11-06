// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! How often the words on screen are seen: the screen terms' test (ADR-DESK-038, amended
//! 2026-11-05 and 2026-11-06). The app ships one word list (`dictionary/words.txt`, 41 languages'
//! lists from FrequencyWords' counts merged, each word with the most often any of them sees it) and
//! asks the main
//! helper (`wordFrequencies`) about the words; every helper answers here, the same on every system.
//! A word is looked up in each form a list written in its script gives it (`listed_form`, as
//! `languages.json` describes), and gets the most any of those forms is seen; a word in a script no
//! list is written in, or mixing scripts no language mixes in one word, gets no answer. The list is
//! read into an `fst` map once for the life of the process; the first ask starts reading it in the
//! background.

use fst::Map;
use icu_casemap::CaseMapper;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, PoisonError},
};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use unicode_script::{Script, UnicodeScript};

/// The characters that join the parts of a word ("что-то", "don't", Catalan's "col·legi" with its
/// middle dot, Persian's "می‌شود" with its zero-width non-joiner); a word none of the lists has is as
/// often seen as its least seen part when every part is in one list. The lists split words at all of
/// them, the middle dot and the zero-width non-joiner and joiner included.
const JOINERS: [char; 7] = ['-', '\'', '’', 'ʼ', '\u{00B7}', '\u{200C}', '\u{200D}'];

/// How a word is put in the form a list has its words in: wordfreq's `preprocess_text` for the list's
/// language (and `simplify_chinese` for Chinese), as `languages.json` describes it.
struct Form {
    /// NFKC rather than NFC.
    nfkc: bool,
    /// The table each letter is replaced through (Serbian's Cyrillic to Latin, Chinese's Traditional
    /// to Simplified), if any.
    letters: Option<Arc<HashMap<char, String>>>,
    /// Marks (abjad vowel points) and the Arabic tatweel removed.
    marks: bool,
    /// Turkish's dotted and dotless i.
    dotless_i: bool,
    /// The s and t below which a cedilla becomes a comma ("commas", Romanian) or a comma a cedilla
    /// ("cedillas", Turkish), if either.
    under: Option<Under>,
}

#[derive(Clone, Copy, PartialEq)]
enum Under {
    Commas,
    Cedillas,
}

/// A language's list: its writings (each the scripts one word may mix: Serbian's Latin, or its
/// Cyrillic) and its words' form, one the lists described alike share.
struct List {
    writings: Vec<HashSet<Script>>,
    form: Arc<Form>,
}

/// The lists in a folder, by name, and the word list they were merged into, read on first use (None
/// when its file can't be read).
struct Catalog {
    lists: HashMap<String, List>,
    words: OnceLock<Option<Map<Vec<u8>>>>,
    folder: PathBuf,
}

impl Catalog {
    fn read(folder: &Path) -> Option<Catalog> {
        let text = std::fs::read_to_string(folder.join("languages.json")).ok()?;
        let described: Value = serde_json::from_str(&text).ok()?;
        let mut tables = HashMap::new();
        for (table, letters) in described.get("letters")?.as_object()? {
            let mut replaced = HashMap::new();
            for (letter, by) in letters.as_object()? {
                let mut chars = letter.chars();
                let (Some(letter), None) = (chars.next(), chars.next()) else {
                    return None;
                };
                replaced.insert(letter, by.as_str()?.to_owned());
            }
            tables.insert(table.clone(), Arc::new(replaced));
        }
        let mut lists = HashMap::new();
        let mut forms: HashMap<String, Arc<Form>> = HashMap::new();
        for (name, list) in described.get("lists")?.as_object()? {
            let writings = list
                .get("writings")?
                .as_array()?
                .iter()
                .map(|writing| {
                    writing
                        .as_array()?
                        .iter()
                        .map(|code| Script::from_short_name(code.as_str()?))
                        .collect::<Option<HashSet<_>>>()
                        .filter(|scripts| !scripts.is_empty())
                })
                .collect::<Option<Vec<_>>>()?;
            if writings.is_empty() {
                return None;
            }
            let form = Form {
                nfkc: match list.get("normal")?.as_str()? {
                    "NFC" => false,
                    "NFKC" => true,
                    _ => return None,
                },
                letters: match list.get("letters")? {
                    Value::Null => None,
                    table => Some(tables.get(table.as_str()?)?.clone()),
                },
                marks: list.get("marks")?.as_bool()?,
                dotless_i: list.get("dotless_i")?.as_bool()?,
                under: match list.get("under")? {
                    Value::Null => None,
                    under => match under.as_str()? {
                        "commas" => Some(Under::Commas),
                        "cedillas" => Some(Under::Cedillas),
                        _ => return None,
                    },
                },
            };
            let mut described = list.as_object()?.clone();
            described.remove("writings");
            let form = forms
                .entry(Value::Object(described).to_string())
                .or_insert_with(|| Arc::new(form))
                .clone();
            lists.insert(name.clone(), List { writings, form });
        }
        Some(Catalog {
            lists,
            words: OnceLock::new(),
            folder: folder.to_owned(),
        })
    }

    /// The word list's map, read on first use; None when its file can't be read.
    fn words(&self) -> Option<&Map<Vec<u8>>> {
        self.words
            .get_or_init(|| read_list(&self.folder.join("words.txt")))
            .as_ref()
    }
}

/// The word list's file as a map from word to Zipf in tenths: one `word<TAB>tenths` a line, sorted by bytes.
fn read_list(path: &Path) -> Option<Map<Vec<u8>>> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut builder = fst::MapBuilder::memory();
    for line in text.lines() {
        let (word, tenths) = line.split_once('\t')?;
        builder.insert(word, tenths.parse::<u64>().ok()?).ok()?;
    }
    Some(builder.into_map())
}

/// The catalog of each folder asked about, read once; its word list starts loading in the background.
fn catalog(folder: &Path) -> Option<Arc<Catalog>> {
    static CATALOGS: OnceLock<Mutex<HashMap<PathBuf, Arc<Catalog>>>> = OnceLock::new();
    let mut catalogs = CATALOGS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(catalog) = catalogs.get(folder) {
        return Some(catalog.clone());
    }
    let catalog = Arc::new(Catalog::read(folder)?);
    catalogs.insert(folder.to_owned(), catalog.clone());
    let loading = catalog.clone();
    std::thread::spawn(move || {
        loading.words();
    });
    Some(catalog)
}

/// The scripts of a word's letters, Common and Inherited ones aside ("ー", a combining mark).
fn scripts(word: &str) -> HashSet<Script> {
    word.chars()
        .map(|char| char.script())
        .filter(|script| !matches!(script, Script::Common | Script::Inherited | Script::Unknown))
        .collect()
}

/// The form a word is listed under in a list, in wordfreq's order: the list's normal form; its letters
/// replaced through its table ("Већ" is "Već", "電腦" is "电脑"); its marks removed where the list's
/// language drops them (wordfreq removes nonspacing marks; the abjads it does so for have no other
/// kind); case-folded as wordfreq does, not just lowercased ("Straße" is "strasse", a final sigma σ,
/// the ligature "ﬁ" of PDF text "fi"; Turkish's dotted and dotless i in its own); s and t with the mark
/// below the language writes ("şi" is "și" in Romanian); then NFC, the apostrophe straight.
fn listed_form(word: &str, form: &Form) -> String {
    let normal: String = if form.nfkc {
        word.nfkc().collect()
    } else {
        word.nfc().collect()
    };
    let replaced: String = match &form.letters {
        Some(table) => normal
            .chars()
            .map(|char| {
                table
                    .get(&char)
                    .cloned()
                    .unwrap_or_else(|| char.to_string())
            })
            .collect(),
        None => normal,
    };
    let unmarked: String = if form.marks {
        replaced
            .chars()
            .filter(|&char| char != '\u{640}' && !is_combining_mark(char))
            .collect()
    } else {
        replaced
    };
    let unmarked = if form.dotless_i {
        unmarked.replace('I', "ı").replace('İ', "i")
    } else {
        unmarked
    };
    CaseMapper::new()
        .fold_string(&unmarked)
        .replace("i\u{307}", "i")
        .nfc()
        .map(|char| match (char, form.under) {
            ('’' | 'ʼ', _) => '\'',
            ('ş', Some(Under::Commas)) => 'ș',
            ('ţ', Some(Under::Commas)) => 'ț',
            ('ș', Some(Under::Cedillas)) => 'ş',
            ('ț', Some(Under::Cedillas)) => 'ţ',
            (other, _) => other,
        })
        .collect()
}

/// How often a word in a listed form is seen, in Zipf tenths: its own entry, else its least seen
/// part when every part joined by a hyphen, an apostrophe, a middle dot or a zero-width (non-)joiner
/// has one; 0 when neither.
fn seen(map: &Map<Vec<u8>>, form: &str) -> u64 {
    if let Some(tenths) = map.get(form) {
        return tenths;
    }
    let parts: Vec<&str> = form.split(JOINERS).collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return 0;
    }
    parts
        .iter()
        .map(|part| map.get(part).unwrap_or(0))
        .min()
        .unwrap_or(0)
}

/// `{"folder":absolute folder,"words":[word…]}` gives `{"zipf":[tenths|null…]}`, one a word in the
/// order asked: the most any form a list written in its script gives it is seen (0 when none is
/// listed), or null when no list is written in its script. Refused (1) when the request is out of
/// shape or the folder not absolute, (2) when the folder's word list can't be read.
pub fn frequencies(request: &Value) -> Result<Value, u32> {
    let folder = request.get("folder").and_then(Value::as_str).ok_or(1u32)?;
    let words = request
        .get("words")
        .and_then(Value::as_array)
        .ok_or(1u32)?
        .iter()
        .map(|value| value.as_str().ok_or(1u32))
        .collect::<Result<Vec<_>, _>>()?;
    if !Path::new(folder).is_absolute() {
        return Err(1);
    }
    let catalog = catalog(Path::new(folder)).ok_or(2u32)?;
    let mut zipf = Vec::with_capacity(words.len());
    for word in words {
        let scripts = scripts(word);
        let mut written: Vec<&Arc<Form>> = Vec::new();
        for list in catalog.lists.values() {
            if !scripts.is_empty()
                && list
                    .writings
                    .iter()
                    .any(|writing| scripts.is_subset(writing))
                && !written.iter().any(|form| Arc::ptr_eq(form, &list.form))
            {
                written.push(&list.form);
            }
        }
        let forms: BTreeSet<String> = written.iter().map(|form| listed_form(word, form)).collect();
        if forms.is_empty() {
            zipf.push(Value::Null);
            continue;
        }
        let map = catalog.words().ok_or(2u32)?;
        zipf.push(json!(
            forms.iter().map(|form| seen(map, form)).max().unwrap_or(0)
        ));
    }
    Ok(json!({ "zipf": zipf }))
}

#[cfg(test)]
mod tests;
