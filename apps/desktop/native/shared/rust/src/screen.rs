// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The screen read's reply, built once for every helper (ADR-DESK-054): the helper sends what its
//! walk found (the app, the window's title, the page's host, the blocks and the text around the
//! caret, or a terminal's viewport request) with the read's exclusions, and gets back the reply the
//! app receives, or `{"hidden":true}` when the page the read came from is excluded.

use crate::privacy;
use serde_json::{Value, json};

fn optional_string(value: &Value, key: &str) -> Result<Option<String>, u32> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        _ => Err(1),
    }
}

fn number(value: &Value, key: &str) -> Result<u64, u32> {
    value.get(key).and_then(Value::as_u64).ok_or(1)
}

fn chars(value: &Value) -> usize {
    value.as_str().map_or(0, |text| text.chars().count())
}

/// The reply's content, one record of it for the debug log file (`log.content`).
fn log_description(reply: &Value, stopped: Option<&str>) -> String {
    let field = |key: &str| reply[key].as_str().unwrap_or("-").to_owned();
    format!(
        "app {} ({}), window title {}, host {}, terminal program {}, focused {}{}\n--- text before the caret ---\n{}\n--- selected text ---\n{}\n--- text after the caret ---\n{}\n--- visible text ---\n{}",
        field("appName"),
        field("bundleID"),
        field("windowTitle"),
        field("host"),
        field("terminalProgram"),
        field("focusedRole"),
        stopped
            .map(|stop| format!(", stopped: {stop}"))
            .unwrap_or_default(),
        reply["textBeforeCaret"].as_str().unwrap_or(""),
        reply["selectedText"].as_str().unwrap_or(""),
        reply["textAfterCaret"].as_str().unwrap_or(""),
        reply["renderedText"].as_str().unwrap_or(""),
    )
}

/// Sizes, counts and times only, safe for the debug log: no app, host, title or text.
fn summary(reply: &Value, blocks: &[Value], read: &Read, surfaces: Option<usize>) -> String {
    let count = |kind: &str| blocks.iter().filter(|block| block["kind"] == kind).count();
    let shape = match surfaces {
        Some(surfaces) => format!("terminal, {surfaces} surfaces"),
        None => format!(
            "{} blocks ({} headings, {} rows, {} links, {} fields, caret placed {})",
            blocks.len(),
            count("heading"),
            count("row"),
            count("link"),
            count("field"),
            count("caret") > 0
        ),
    };
    format!(
        "{shape}, {} chars, title {} chars, caret {}/{}/{} chars, {} nodes, {} ms{}",
        chars(&reply["renderedText"]),
        chars(&reply["windowTitle"]),
        chars(&reply["textBeforeCaret"]),
        chars(&reply["selectedText"]),
        chars(&reply["textAfterCaret"]),
        read.nodes,
        read.milliseconds,
        read.stopped
            .as_deref()
            .map(|stop| format!(", stopped: {stop}"))
            .unwrap_or_default(),
    )
}

/// How the walk went, for the summary and the log description.
struct Read {
    nodes: u64,
    milliseconds: u64,
    stopped: Option<String>,
}

fn call(operation: fn(&[u8]) -> Result<Vec<u8>, u32>, request: &Value) -> Result<Value, u32> {
    let bytes = serde_json::to_vec(request).map_err(|_| 3u32)?;
    serde_json::from_slice(&operation(&bytes)?).map_err(|_| 3)
}

pub(crate) fn process(bytes: &[u8]) -> Result<Vec<u8>, u32> {
    let input: Value = serde_json::from_slice(bytes).map_err(|_| 1u32)?;
    if !input.is_object() {
        return Err(1);
    }
    let exclusions = input
        .get("exclusions")
        .filter(|value| value.is_object())
        .ok_or(1u32)?;
    let host = optional_string(&input, "host")?;
    // The page the read came from is checked once more, whatever the walk decided (ADR-DESK-047);
    // the lists are checked even when it has none.
    let policy = json!({"excludedAppIDs": exclusions["excludedAppIDs"], "excludedHosts": exclusions["excludedHosts"], "host": host});
    if call(crate::policy::process, &policy)?["host"] != false {
        return serde_json::to_vec(&json!({"hidden": true})).map_err(|_| 3);
    }
    let app_name = input.get("appName").and_then(Value::as_str).ok_or(1u32)?;
    let title = optional_string(&input, "windowTitle")?
        .map(|title| {
            privacy::redact(&vec![vec![title]])
                .map(|lines| lines[0][0].clone())
                .map_err(|_| 3u32)
        })
        .transpose()?;
    let mut read = Read {
        nodes: number(&input, "nodes")?,
        milliseconds: number(&input, "milliseconds")?,
        stopped: optional_string(&input, "stopped")?,
    };
    let mut reply = json!({
        "appName": app_name,
        "bundleID": optional_string(&input, "bundleID")?,
        "windowTitle": title,
        "host": host,
        "terminalProgram": optional_string(&input, "terminalProgram")?,
        "focusedRole": optional_string(&input, "focusedRole")?,
    });
    let (blocks, surfaces) = if let Some(viewport) = input.get("viewport") {
        if input.get("blocks").is_some() || input.get("caret").is_some() {
            return Err(1);
        }
        let projected = call(crate::viewport::process, viewport)?;
        let surfaces = projected["surfaces"].as_array().map_or(0, Vec::len);
        reply["textBeforeCaret"] = json!("");
        reply["selectedText"] = projected["selectedText"].clone();
        reply["textAfterCaret"] = json!("");
        reply["selectionRedacted"] = json!(projected["selectionComplete"] != true);
        reply["renderedText"] = projected["renderedText"].clone();
        if projected["complete"] != true && read.stopped.is_none() {
            read.stopped = Some("terminal viewport incomplete".into());
        }
        reply["terminalViewport"] = projected;
        (Vec::new(), Some(surfaces))
    } else {
        let unavailable = input
            .get("selectionUnavailable")
            .and_then(Value::as_bool)
            .ok_or(1u32)?;
        let sent = input
            .get("caret")
            .and_then(Value::as_array)
            .filter(|parts| parts.len() == 3)
            .ok_or(1u32)?;
        let finished = call(
            crate::context::process,
            &json!({"blocks": input["blocks"], "caret": sent}),
        )?;
        let caret = finished["caret"]
            .as_array()
            .filter(|parts| parts.len() == 3)
            .ok_or(3u32)?;
        if finished["truncated"] == true && read.stopped.is_none() {
            read.stopped = Some("text budget".into());
        }
        reply["textBeforeCaret"] = caret[0].clone();
        reply["selectedText"] = caret[1].clone();
        reply["textAfterCaret"] = caret[2].clone();
        // The selection as sent is not the user's text (redacted, or cut to the budget): the app
        // must not paste a rewrite of it over the real one.
        reply["selectionRedacted"] = json!(unavailable || caret[1] != sent[1]);
        reply["renderedText"] = finished["rendered"].clone();
        (
            finished["blocks"].as_array().cloned().unwrap_or_default(),
            None,
        )
    };
    reply["summary"] = json!(summary(&reply, &blocks, &read, surfaces));
    reply["logDescription"] = json!(log_description(&reply, read.stopped.as_deref()));
    serde_json::to_vec(&reply).map_err(|_| 3)
}

#[cfg(test)]
mod tests;
