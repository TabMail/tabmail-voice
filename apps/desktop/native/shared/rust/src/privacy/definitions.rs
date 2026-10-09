// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `redactors.json` read into typed redactors. Every field is checked here, so the scanner never
//! meets a definition it cannot apply.

use super::{Error, PLACEHOLDER};
use serde_json::{Map, Value};

/// ASCII characters, as a bracket expression without its brackets lists them.
#[derive(Clone)]
pub(super) struct Set([bool; 128]);

impl Set {
    fn parse(source: &str) -> Result<Set, Error> {
        let bytes = source.as_bytes();
        if bytes.is_empty() || !source.is_ascii() {
            return Err(Error::InvalidDefinitions);
        }
        let mut set = [false; 128];
        let mut at = 0;
        while at < bytes.len() {
            if at + 2 < bytes.len() && bytes[at + 1] == b'-' {
                if bytes[at] > bytes[at + 2] {
                    return Err(Error::InvalidDefinitions);
                }
                for b in bytes[at]..=bytes[at + 2] {
                    set[b as usize] = true;
                }
                at += 3;
            } else {
                set[bytes[at] as usize] = true;
                at += 1;
            }
        }
        Ok(Set(set))
    }

    pub(super) fn has(&self, byte: u8) -> bool {
        self.0.get(byte as usize).copied().unwrap_or(false)
    }
}

pub(super) struct Token {
    pub prefixes: Vec<String>,
    pub ignore_case: bool,
    /// The prefix must not follow a letter, a digit or `_`.
    pub word_edge: bool,
    /// Whitespace must come between the prefix and the body.
    pub space: bool,
    /// The prefix (and the space after it) stays.
    pub keep_prefix: bool,
    pub body: Set,
    /// At least this many body characters, all of the run taken; or exactly this many taken.
    pub length: Length,
}

#[derive(Clone, Copy)]
pub(super) enum Length {
    Min(usize),
    Exact(usize),
}

pub(super) struct PrivateKey {
    pub begin: String,
    pub end: String,
    pub label: String,
    pub close: String,
    pub words: Set,
    pub words_max: usize,
    /// What a key cut off after its header goes on with.
    pub body: Set,
}

pub(super) struct KeyLines {
    pub base64: Set,
    pub padding: u8,
    pub full_line: usize,
    pub min_lines: usize,
}

pub(super) struct JsonWebToken {
    pub start: String,
    pub part: Set,
}

pub(super) struct AddressPassword {
    pub start: String,
}

pub(super) struct NamedValue {
    pub labels: Vec<String>,
    pub min: usize,
    pub digit_within: usize,
}

pub(super) struct Entropy {
    pub word: Set,
    pub padding: u8,
    pub separators: Set,
    pub hex: Set,
    pub min_length: usize,
    pub max_word_share: f64,
    pub min_bits: f64,
}

pub(super) enum Kind {
    Token(Token),
    PrivateKey(PrivateKey),
    KeyLines(KeyLines),
    JsonWebToken(JsonWebToken),
    AddressPassword(AddressPassword),
    NamedValue(NamedValue),
    Entropy(Entropy),
}

pub(super) struct Redactor {
    pub name: String,
    pub kind: Kind,
}

/// Every field a kind reads, so that a misspelt or stray field is refused rather than ignored.
fn fields(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "token" => &[
            "prefixes",
            "ignoreCase",
            "edge",
            "space",
            "keepPrefix",
            "body",
            "min",
            "exact",
        ],
        "privateKey" => &[
            "begin", "end", "label", "close", "words", "wordsMax", "body",
        ],
        "keyLines" => &["base64", "padding", "fullLine", "minLines"],
        "jsonWebToken" => &["start", "part"],
        "addressPassword" => &["start"],
        "namedValue" => &["labels", "min", "digitWithin"],
        "entropy" => &[
            "word",
            "padding",
            "separators",
            "hex",
            "minLength",
            "maxWordShare",
            "minBits",
        ],
        _ => return None,
    })
}

pub(super) fn parse(source: &str) -> Result<Vec<Redactor>, Error> {
    let invalid = || Error::InvalidDefinitions;
    let json: Value = serde_json::from_str(source).map_err(|_| invalid())?;
    if json["placeholder"].as_str() != Some(PLACEHOLDER) {
        return Err(invalid());
    }
    let mut redactors: Vec<Redactor> = Vec::new();
    for definition in json["redactors"].as_array().ok_or_else(invalid)? {
        let object = definition.as_object().ok_or_else(invalid)?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let known = fields(kind).ok_or_else(invalid)?;
        if !name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || object
                .get("description")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            || object.keys().any(|key| {
                !["name", "kind", "description"].contains(&key.as_str())
                    && !known.contains(&key.as_str())
            })
            || redactors.iter().any(|r| r.name == name)
        {
            return Err(invalid());
        }
        let kind = match kind {
            "token" => Kind::Token(token(object)?),
            "privateKey" => Kind::PrivateKey(PrivateKey {
                begin: text(object, "begin")?,
                end: text(object, "end")?,
                label: text(object, "label")?,
                close: text(object, "close")?,
                words: set(object, "words")?,
                words_max: count(object, "wordsMax")?,
                body: set(object, "body")?,
            }),
            "keyLines" => Kind::KeyLines(KeyLines {
                base64: set(object, "base64")?,
                padding: byte(object, "padding")?,
                full_line: count(object, "fullLine")?,
                min_lines: count(object, "minLines")?,
            }),
            "jsonWebToken" => Kind::JsonWebToken(JsonWebToken {
                start: text(object, "start")?,
                part: set(object, "part")?,
            }),
            "addressPassword" => Kind::AddressPassword(AddressPassword {
                start: text(object, "start")?,
            }),
            "namedValue" => Kind::NamedValue(NamedValue {
                labels: object
                    .get("labels")
                    .and_then(Value::as_array)
                    .filter(|labels| !labels.is_empty())
                    .ok_or_else(invalid)?
                    .iter()
                    .map(|label| {
                        label
                            .as_str()
                            .filter(|label| !label.is_empty())
                            .map(String::from)
                            .ok_or_else(invalid)
                    })
                    .collect::<Result<_, _>>()?,
                min: count(object, "min")?,
                digit_within: count(object, "digitWithin")?,
            }),
            "entropy" => Kind::Entropy(Entropy {
                word: set(object, "word")?,
                padding: byte(object, "padding")?,
                separators: set(object, "separators")?,
                hex: set(object, "hex")?,
                min_length: count(object, "minLength")?,
                max_word_share: fraction(object, "maxWordShare")?,
                min_bits: object
                    .get("minBits")
                    .and_then(Value::as_f64)
                    .filter(|bits| *bits > 0.0)
                    .ok_or_else(invalid)?,
            }),
            _ => return Err(invalid()),
        };
        redactors.push(Redactor {
            name: name.into(),
            kind,
        });
    }
    if redactors.is_empty() {
        return Err(invalid());
    }
    Ok(redactors)
}

fn token(object: &Map<String, Value>) -> Result<Token, Error> {
    let invalid = || Error::InvalidDefinitions;
    let flag = |key: &str| match object.get(key) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(invalid),
    };
    let prefixes: Vec<String> = object
        .get("prefixes")
        .and_then(Value::as_array)
        .filter(|prefixes| !prefixes.is_empty())
        .ok_or_else(invalid)?
        .iter()
        .map(|prefix| {
            prefix
                .as_str()
                .filter(|prefix| !prefix.is_empty() && prefix.is_ascii())
                .map(String::from)
                .ok_or_else(invalid)
        })
        .collect::<Result<_, _>>()?;
    let length = match (object.get("min"), object.get("exact")) {
        (Some(_), None) => Length::Min(count(object, "min")?),
        (None, Some(_)) => Length::Exact(count(object, "exact")?),
        _ => return Err(invalid()),
    };
    let word_edge = match object.get("edge") {
        None => false,
        Some(edge) if edge.as_str() == Some("word") => true,
        _ => return Err(invalid()),
    };
    Ok(Token {
        prefixes,
        ignore_case: flag("ignoreCase")?,
        word_edge,
        space: flag("space")?,
        keep_prefix: flag("keepPrefix")?,
        body: set(object, "body")?,
        length,
    })
}

fn text(object: &Map<String, Value>, key: &str) -> Result<String, Error> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.is_ascii())
        .map(String::from)
        .ok_or(Error::InvalidDefinitions)
}

fn set(object: &Map<String, Value>, key: &str) -> Result<Set, Error> {
    Set::parse(
        object
            .get(key)
            .and_then(Value::as_str)
            .ok_or(Error::InvalidDefinitions)?,
    )
}

fn byte(object: &Map<String, Value>, key: &str) -> Result<u8, Error> {
    match object.get(key).and_then(Value::as_str).map(str::as_bytes) {
        Some(&[byte]) if byte.is_ascii() => Ok(byte),
        _ => Err(Error::InvalidDefinitions),
    }
}

fn count(object: &Map<String, Value>, key: &str) -> Result<usize, Error> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .filter(|&n| n > 0)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(Error::InvalidDefinitions)
}

fn fraction(object: &Map<String, Value>, key: &str) -> Result<f64, Error> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|f| *f > 0.0 && *f <= 1.0)
        .ok_or(Error::InvalidDefinitions)
}
