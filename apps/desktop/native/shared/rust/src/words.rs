// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which words are everyday words of the user's languages: the screen terms' test (ADR-DESK-038,
//! amended 2026-11-04). The app asks the main helper (`knownWords`) with the user's languages and
//! the words, and each helper answers with the system's own spelling dictionaries: the macOS and
//! Windows spell checkers, and on Linux the Hunspell dictionaries the system has installed. What
//! does not depend on the OS is here: which of a system's dictionaries serves a language
//! (`dictionaries`, for the spell checkers' lists), and on Linux the whole answer (`known`), the
//! system's Hunspell files read with `spellbook`, each loaded once for the life of the process.

use serde_json::{Value, json};
use spellbook::Dictionary;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, PoisonError},
};

/// A language tag ("en-US", "zh-Hant-TW", a POSIX locale "pt_BR.UTF-8") or a dictionary's name
/// ("en_GB", "fr", "pt_BR") as its language and region, both lowercase; `None` when it names no
/// language (two or three letters first), as "C" does.
fn language_and_region(tag: &str) -> Option<(String, Option<String>)> {
    let tag = tag.split(['.', '@']).next().unwrap_or_default();
    let mut subtags = tag.split(['-', '_']);
    let language = subtags.next().unwrap_or_default().to_ascii_lowercase();
    if !(2..=3).contains(&language.len()) || !language.bytes().all(|byte| byte.is_ascii_lowercase())
    {
        return None;
    }
    let region = subtags.find(|subtag| {
        (subtag.len() == 2 && subtag.bytes().all(|byte| byte.is_ascii_alphabetic()))
            || (subtag.len() == 3 && subtag.bytes().all(|byte| byte.is_ascii_digit()))
    });
    Some((language, region.map(str::to_ascii_lowercase)))
}

/// The dictionary of `available` that serves each of `languages`: the one of its language and region,
/// else the one of its language alone, else the first (by name) of its language; `None` when there is
/// none.
fn choose<'a>(languages: &[&str], available: &[&'a str]) -> Vec<Option<&'a str>> {
    let mut names: Vec<(&'a str, (String, Option<String>))> = available
        .iter()
        .filter_map(|name| Some((*name, language_and_region(name)?)))
        .collect();
    names.sort_by(|a, b| a.0.cmp(b.0));
    languages
        .iter()
        .map(|tag| {
            let (language, region) = language_and_region(tag)?;
            let same = || names.iter().filter(|(_, parts)| parts.0 == language);
            same()
                .find(|(_, parts)| region.is_some() && parts.1 == region)
                .or_else(|| same().find(|(_, parts)| parts.1.is_none()))
                .or_else(|| same().next())
                .map(|(name, _)| *name)
        })
        .collect()
}

/// The request's list `name`, of strings.
fn strings<'a>(request: &'a Value, name: &str) -> Result<Vec<&'a str>, u32> {
    request
        .get(name)
        .and_then(Value::as_array)
        .ok_or(1u32)?
        .iter()
        .map(|value| value.as_str().ok_or(1u32))
        .collect()
}

/// The request's languages that name one: a tag such as the POSIX locale "C" is no language the user
/// lacks a dictionary for.
fn languages(request: &Value) -> Result<Vec<&str>, u32> {
    Ok(strings(request, "languages")?
        .into_iter()
        .filter(|tag| language_and_region(tag).is_some())
        .collect())
}

/// `{"languages":[tag…],"available":[name…]}` gives `{"dictionaries":[name…],"unavailable":[tag…]}`:
/// the system's dictionaries that serve the user's languages, each once, in the languages' order, and
/// the languages none serves (a tag naming no language is neither).
pub fn dictionaries(request: &Value) -> Result<Value, u32> {
    let languages = languages(request)?;
    let available = strings(request, "available")?;
    let mut dictionaries = Vec::new();
    let mut unavailable = Vec::new();
    for (language, chosen) in languages.iter().zip(choose(&languages, &available)) {
        match chosen {
            Some(name) if !dictionaries.contains(&name) => dictionaries.push(name),
            Some(_) => {}
            None => unavailable.push(*language),
        }
    }
    Ok(json!({"dictionaries": dictionaries, "unavailable": unavailable}))
}

/// The Hunspell dictionaries in `folders`: each `<name>.dic` beside a `<name>.aff`, by name, the first
/// folder's where two have one.
fn installed(folders: &[&str]) -> HashMap<String, PathBuf> {
    let mut found = HashMap::new();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(folder) else {
            continue;
        };
        for path in entries.filter_map(|entry| Some(entry.ok()?.path())) {
            if path.extension().is_none_or(|extension| extension != "dic")
                || !path.with_extension("aff").is_file()
            {
                continue;
            }
            if let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) {
                found
                    .entry(name.to_owned())
                    .or_insert_with(|| path.with_extension(""));
            }
        }
    }
    found
}

/// The dictionaries loaded, by their `.dic` file's real path (a regional name is often a link to the
/// language's file); `None` for one that could not be read or parsed, so a file is tried once.
fn loaded() -> &'static Mutex<HashMap<PathBuf, Option<Arc<Dictionary>>>> {
    static LOADED: OnceLock<Mutex<HashMap<PathBuf, Option<Arc<Dictionary>>>>> = OnceLock::new();
    LOADED.get_or_init(Mutex::default)
}

/// The text of a dictionary's file in the encoding its `.aff` names (`SET`), ISO 8859-1 when it names
/// none, as Hunspell reads it: `spellbook` reads UTF-8 only, and some systems' files are not
/// (Greek's in ISO 8859-7, Polish's in ISO 8859-2). `None` for an encoding not known.
fn decoded(bytes: &[u8], set: Option<&str>) -> Option<String> {
    let label = match set.map(str::to_ascii_lowercase) {
        None => "iso-8859-1".to_owned(),
        Some(label) => match label.as_str() {
            "microsoft-cp1251" => "windows-1251".to_owned(),
            "tis620-2533" => "tis-620".to_owned(),
            _ => label,
        },
    };
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())?;
    Some(encoding.decode_with_bom_removal(bytes).0.into_owned())
}

fn load(base: &Path) -> Option<Arc<Dictionary>> {
    let aff = std::fs::read(base.with_extension("aff")).ok()?;
    let dic = std::fs::read(base.with_extension("dic")).ok()?;
    // `SET` and its encoding's name are ASCII in every encoding a dictionary may be in.
    let set = String::from_utf8_lossy(&aff).lines().find_map(|line| {
        line.trim_start_matches('\u{feff}')
            .strip_prefix("SET")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map(|rest| rest.trim().to_owned())
    });
    let aff = decoded(&aff, set.as_deref())?;
    let dic = decoded(&dic, set.as_deref())?;
    Dictionary::new(&aff, &dic).ok().map(Arc::new)
}

fn dictionary(base: &Path) -> Option<Arc<Dictionary>> {
    let key = base
        .with_extension("dic")
        .canonicalize()
        .unwrap_or_else(|_| base.to_owned());
    let mut loaded = loaded().lock().unwrap_or_else(PoisonError::into_inner);
    loaded.entry(key).or_insert_with(|| load(base)).clone()
}

/// `{"folders":[folder…],"languages":[tag…],"words":[word…]}` gives
/// `{"known":[word…],"unavailable":[tag…]}`: the words, as given and in the order asked, that a
/// Hunspell dictionary in `folders` (absolute paths, the system's) serving one of the languages has,
/// and the languages none serves or whose dictionary could not be read.
pub fn known(request: &Value) -> Result<Value, u32> {
    let folders = strings(request, "folders")?;
    let languages = languages(request)?;
    let words = strings(request, "words")?;
    if folders
        .iter()
        .any(|folder| !Path::new(folder).is_absolute())
    {
        return Err(1);
    }
    let installed = installed(&folders);
    let names: Vec<&str> = installed.keys().map(String::as_str).collect();
    let mut dictionaries: Vec<(PathBuf, Arc<Dictionary>)> = Vec::new();
    let mut unavailable = Vec::new();
    for (language, chosen) in languages.iter().zip(choose(&languages, &names)) {
        let base = chosen.map(|name| &installed[name]);
        match base.and_then(|base| Some((base, dictionary(base)?))) {
            Some((base, _)) if dictionaries.iter().any(|(loaded, _)| loaded == base) => {}
            Some((base, dictionary)) => dictionaries.push((base.clone(), dictionary)),
            None => unavailable.push(*language),
        }
    }
    let known: Vec<&str> = words
        .into_iter()
        .filter(|word| {
            dictionaries
                .iter()
                .any(|(_, dictionary)| dictionary.check(word))
        })
        .collect();
    Ok(json!({"known": known, "unavailable": unavailable}))
}

#[cfg(test)]
mod tests;
