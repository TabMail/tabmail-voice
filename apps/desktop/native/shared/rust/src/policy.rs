// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use icu_casemap::CaseMapper;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

// Match Linux's stricter full case folding on every platform. This is Rust
// Unicode data, not an OS matcher or a callback into native ICU.
fn folded(value: &Value) -> Result<String, u32> {
    let text = value.as_str().ok_or(1u32)?;
    if text.len() > 32768 || text.contains('\0') {
        return Err(1);
    }
    // Canonical equivalence preserves Swift String equality as well as Linux full folding.
    let decomposed: String = text.nfd().collect();
    Ok(CaseMapper::new().fold_string(&decomposed).nfd().collect())
}

fn strings(input: &Value, key: &str) -> Result<Vec<String>, u32> {
    input
        .get(key)
        .and_then(Value::as_array)
        .ok_or(1u32)?
        .iter()
        .map(folded)
        .collect()
}

fn host_names(value: &Value) -> Result<Vec<String>, u32> {
    let mut names = vec![folded(value)?];
    // IDNA must see the original spelling: full case folding would turn ß into
    // ss before the URL standard can map it to its distinct ASCII hostname.
    let raw = value.as_str().ok_or(1u32)?;
    if let Ok(host) = url::Host::parse(raw) {
        let canonical = folded(&json!(host.to_string()))?;
        if !names.contains(&canonical) {
            names.push(canonical);
        }
    }
    Ok(names)
}

fn host_matches(value: &Value, sites: &[String]) -> Result<bool, u32> {
    Ok(host_names(value)?.iter().any(|name| {
        let name = name.strip_suffix('.').unwrap_or(name);
        !name.is_empty()
            && sites.iter().any(|site| {
                let site = site.strip_suffix('.').unwrap_or(site);
                !site.is_empty()
                    && (name == site
                        || name
                            .strip_suffix(site)
                            .is_some_and(|prefix| prefix.ends_with('.')))
            })
    }))
}

/// Both arrays are mandatory even for validation-only calls. Native adapters
/// validate before touching provider metadata/text; query errors must refuse.
pub(crate) fn process(bytes: &[u8]) -> Result<Vec<u8>, u32> {
    let input: Value = serde_json::from_slice(bytes).map_err(|_| 1u32)?;
    let apps = strings(&input, "excludedAppIDs")?;
    let hosts = input
        .get("excludedHosts")
        .and_then(Value::as_array)
        .ok_or(1u32)?
        .iter()
        .map(host_names)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut result = json!({});
    if let Some(app) = input.get("app") {
        result["app"] = json!(if app.is_null() {
            false
        } else {
            apps.contains(&folded(app)?)
        });
    }
    if let Some(host) = input.get("host") {
        result["host"] = json!(if host.is_null() {
            false
        } else {
            host_matches(host, &hosts)?
        });
    }
    if let Some(page) = input.get("page") {
        result["page"] = json!(match page.as_str() {
            Some("unknown") => true,
            Some("noHost") => false,
            Some("host") => host_matches(input.get("host").ok_or(1u32)?, &hosts)?,
            _ => return Err(1),
        });
    }
    serde_json::to_vec(&result).map_err(|_| 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_host_contract() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../privacy/host-exclusion-cases.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let input = json!({"excludedAppIDs": [], "excludedHosts": [case["site"]], "host": case["host"]});
            let output: Value =
                serde_json::from_slice(&process(&serde_json::to_vec(&input).unwrap()).unwrap())
                    .unwrap();
            assert_eq!(output["host"], case["excluded"], "{}", case["name"]);
        }
    }
    #[test]
    fn shared_policy_contract() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../privacy/policy-cases.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let result = process(&serde_json::to_vec(&case["input"]).unwrap());
            if case["refused"] == true {
                assert_eq!(result, Err(1), "{}", case["name"]);
            } else {
                let output: Value = serde_json::from_slice(&result.unwrap()).unwrap();
                assert_eq!(output, case["output"], "{}", case["name"]);
            }
        }
    }
    #[test]
    fn bounded_strings_and_invalid_utf8_refuse() {
        for key in ["excludedAppIDs", "excludedHosts"] {
            let mut input = json!({"excludedAppIDs": [], "excludedHosts": []});
            input[key] = json!(["x".repeat(32769)]);
            assert_eq!(process(&serde_json::to_vec(&input).unwrap()), Err(1));
        }
        assert_eq!(process(&[0xff]), Err(1));
    }
}
