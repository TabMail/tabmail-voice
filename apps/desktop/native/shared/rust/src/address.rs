// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use serde_json::{Value, json};
use std::cell::Cell;
use url::{Host, SyntaxViolation, Url};

pub(crate) fn process(bytes: &[u8]) -> Result<Vec<u8>, u32> {
    let input: Value = serde_json::from_slice(bytes).map_err(|_| 1u32)?;
    let address = input.get("address").ok_or(1u32)?;
    let (kind, host) = if address.is_null() {
        ("unknown", String::new())
    } else {
        classify(address.as_str().ok_or(1u32)?)
    };
    serde_json::to_vec(&json!({"kind":kind,"host":host})).map_err(|_| 3)
}

fn classify(address: &str) -> (&'static str, String) {
    if address.is_empty() {
        return ("noHost", String::new());
    }
    if address.len() > 32768 || address.chars().any(char::is_control) {
        return ("unknown", String::new());
    }
    // Browser-style recovery must not turn ambiguous provider data into permission
    // to read. Credentials are valid authority syntax and do not affect the host.
    let ambiguous = Cell::new(false);
    let violation = |kind| {
        if kind != SyntaxViolation::EmbeddedCredentials {
            ambiguous.set(true);
        }
    };
    let parsed = Url::options()
        .syntax_violation_callback(Some(&violation))
        .parse(address);
    let Ok(url) = parsed else {
        return ("unknown", String::new());
    };
    if ambiguous.get() {
        return ("unknown", String::new());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return ("host", url.scheme().to_owned());
    }
    match url.host() {
        Some(Host::Domain(host)) if !host.is_empty() => ("host", host.to_owned()),
        Some(Host::Ipv4(host)) => ("host", host.to_string()),
        Some(Host::Ipv6(host)) => ("host", host.to_string()),
        _ => ("unknown", String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn shared_address_contract() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../privacy/address-cases.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let output: Value = serde_json::from_slice(
                &process(&serde_json::to_vec(&json!({"address":case["address"]})).unwrap())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                output,
                json!({"kind":case["kind"],"host":case["host"]}),
                "{}",
                case["address"]
            );
        }
    }
    #[test]
    fn oversized_and_invalid_requests_refuse() {
        for input in [json!({}), json!({"address":7})] {
            assert!(process(&serde_json::to_vec(&input).unwrap()).is_err());
        }
        let output: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(
                    &json!({"address":"https://example.com/".to_owned()+&"x".repeat(32768)}),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(output["kind"], "unknown");
    }
}
