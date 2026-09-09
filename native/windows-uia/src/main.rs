mod protocol;
mod uia;
mod win32;

use std::io::{self, BufRead, Write};

use protocol::{InspectParams, MAX_REQUEST_BYTES, OperateParams, Request, Response, Selector};
use serde_json::{json, Value};
use uia::UiaEngine;
use win32::WindowDiscovery;

struct Win32SelectorParts<'a> {
    process_id: Option<u32>,
    title: Option<&'a str>,
    class_name: Option<&'a str>,
}

fn main() {
    let engine = UiaEngine::new();
    if let Err(error) = &engine {
        eprintln!("[operator-windows-uia] UIA unavailable; bounded Win32 fallback remains available: {error}");
    }

    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("[operator-windows-uia] stdin error: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = handle_line(&engine, &line);
        if serde_json::to_writer(&mut stdout, &response).is_err() {
            break;
        }
        if stdout.write_all(b"\n").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

fn handle_line(engine: &Result<UiaEngine, String>, line: &str) -> Response<Value> {
    if line.len() > MAX_REQUEST_BYTES {
        return Response::failure("unknown", "REQUEST_TOO_LARGE", "UIA sidecar request exceeds 256 KiB", false);
    }

    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return Response::failure("unknown", "INVALID_JSON", format!("Invalid JSON request: {error}"), false),
    };
    if request.id.trim().is_empty() || request.id.len() > 128 {
        return Response::failure(request.id, "INVALID_REQUEST_ID", "request id must contain 1-128 characters", false);
    }

    match request.method.as_str() {
        "health" => {
            let (uia_available, uia_error) = match engine {
                Ok(_) => (true, None),
                Err(error) => (false, Some(error.as_str())),
            };
            Response::success(request.id, json!({
                "service": "operator-windows-uia",
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": 1,
                "uia_available": uia_available,
                "uia_error": uia_error,
                "capabilities": ["inspect", "invoke", "set_value", "focus", "select", "expand", "collapse", "scroll", "wait", "window_discovery", "activate_window", "win32_fallback"]
            }))
        }
        "inspect" => {
            let params: InspectParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => return Response::failure(request.id, "INVALID_PARAMS", format!("Invalid inspect params: {error}"), false),
            };
            inspect_request(engine, request.id, params)
        }
        "operate" => {
            let params: OperateParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => return Response::failure(request.id, "INVALID_PARAMS", format!("Invalid operate params: {error}"), false),
            };
            if let Err(error) = params.validate() {
                return Response::failure(request.id, "INVALID_PARAMS", error, false);
            }
            operate_request(engine, request.id, params)
        }
        _ => Response::failure(request.id, "METHOD_NOT_ALLOWED", "method must be health, inspect, or operate", false),
    }
}

fn inspect_request(engine: &Result<UiaEngine, String>, id: String, params: InspectParams) -> Response<Value> {
    let include_windows = params.include_windows;
    let max_windows = params.max_windows();

    match engine {
        Ok(engine) => match engine.inspect(params.clone()) {
            Ok(result) => {
                let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
                if let Value::Object(object) = &mut value {
                    object.insert("uia_available".into(), Value::Bool(true));
                }
                if include_windows {
                    let discovery = match win32::discover_windows(max_windows) {
                        Ok(discovery) => discovery,
                        Err(error) => return Response::failure(id, "WIN32_DISCOVERY_FAILED", error, true),
                    };
                    attach_window_discovery(&mut value, discovery);
                }
                Response::success(id, value)
            }
            Err(error) if include_windows && should_try_win32_fallback(&error) => {
                match win32_fallback_inspect(&params, true, &error) {
                    Ok(value) => Response::success(id, value),
                    Err(fallback_error) => Response::failure(
                        id,
                        classify_win32_fallback_code(&fallback_error),
                        fallback_error,
                        true,
                    ),
                }
            }
            Err(error) => {
                let code = classify_code(&error);
                let retryable = is_retryable(&error);
                Response::failure(id, code, error, retryable)
            }
        },
        Err(uia_error) => {
            if !include_windows {
                return Response::failure(
                    id,
                    "UIA_UNAVAILABLE",
                    format!("Microsoft UI Automation is unavailable: {uia_error}"),
                    true,
                );
            }
            match win32_fallback_inspect(&params, false, uia_error) {
                Ok(value) => Response::success(id, value),
                Err(error) => Response::failure(
                    id,
                    classify_win32_fallback_code(&error),
                    error,
                    true,
                ),
            }
        }
    }
}

fn operate_request(engine: &Result<UiaEngine, String>, id: String, params: OperateParams) -> Response<Value> {
    if params.operation == "activate_window" {
        return activate_window_request(engine, id, params);
    }

    let Ok(engine) = engine else {
        let error = engine.as_ref().err().map(String::as_str).unwrap_or("unknown UIA initialization failure");
        return Response::failure(
            id,
            "UIA_UNAVAILABLE",
            format!("Microsoft UI Automation is unavailable; operation {} has no verified Win32 fallback: {error}", params.operation),
            true,
        );
    };

    match engine.operate(params) {
        Ok(result) => Response::success(id, result),
        Err(error) => {
            let code = classify_code(&error);
            let retryable = is_retryable(&error);
            Response::failure(id, code, error, retryable)
        }
    }
}

fn activate_window_request(
    engine: &Result<UiaEngine, String>,
    id: String,
    params: OperateParams,
) -> Response<Value> {
    let wait_ms = params.wait_ms();

    if let Ok(engine) = engine {
        let inspect_params = InspectParams {
            selector: Some(params.selector.clone()),
            max_nodes: Some(1),
            max_depth: Some(1),
            observe_ms: Some(0),
            wait_ms: Some(wait_ms),
            include_windows: false,
            max_windows: None,
        };
        match engine.inspect(inspect_params) {
            Ok(resolved) => {
                let Some(element) = resolved.elements.first() else {
                    return Response::failure(
                        id,
                        "UIA_ELEMENT_NOT_FOUND",
                        "Resolved UI Automation selector returned no element summary",
                        true,
                    );
                };
                return match win32::activate_matching_window(
                    element.process_id,
                    &element.name,
                    &element.class_name,
                ) {
                    Ok((before, after)) => Response::success(id, json!({
                        "operation": "activate_window",
                        "waited_ms": resolved.waited_ms,
                        "fallback": false,
                        "uia_available": true,
                        "before": before,
                        "after": after,
                        "postcondition": { "foreground": true, "verified": true }
                    })),
                    Err(error) => Response::failure(id, "WIN32_ACTIVATION_FAILED", error, true),
                };
            }
            Err(error) if should_try_win32_fallback(&error) => {
                return activate_via_win32_selector(id, &params.selector, 0, true, &error);
            }
            Err(error) => {
                let code = classify_code(&error);
                let retryable = is_retryable(&error);
                return Response::failure(id, code, error, retryable);
            }
        }
    }

    let uia_error = engine.as_ref().err().map(String::as_str).unwrap_or("UIA unavailable");
    activate_via_win32_selector(id, &params.selector, wait_ms, false, uia_error)
}

fn activate_via_win32_selector(
    id: String,
    selector: &Selector,
    wait_ms: u64,
    uia_available: bool,
    reason: &str,
) -> Response<Value> {
    let parts = match win32_selector(selector) {
        Ok(parts) => parts,
        Err(error) => return Response::failure(id, "WIN32_FALLBACK_UNSUPPORTED_SELECTOR", error, false),
    };

    match win32::activate_unique_window(parts.process_id, parts.title, parts.class_name, wait_ms) {
        Ok((before, after, waited_ms)) => Response::success(id, json!({
            "operation": "activate_window",
            "waited_ms": waited_ms,
            "fallback": true,
            "fallback_provider": "win32",
            "fallback_reason": reason,
            "uia_available": uia_available,
            "before": before,
            "after": after,
            "postcondition": { "foreground": true, "verified": true }
        })),
        Err(error) => Response::failure(id, classify_win32_fallback_code(&error), error, true),
    }
}

fn win32_fallback_inspect(
    params: &InspectParams,
    uia_available: bool,
    reason: &str,
) -> Result<Value, String> {
    if params.observe_ms() > 0 {
        return Err("Win32 fallback cannot provide requested UI Automation event observation".into());
    }

    let max_windows = params.max_windows();
    let (discovery, waited_ms) = if let Some(selector) = params.selector.as_ref() {
        let parts = win32_selector(selector)?;
        let (window, waited_ms) = win32::wait_for_unique_window(
            parts.process_id,
            parts.title,
            parts.class_name,
            params.wait_ms(),
        )?;
        (
            WindowDiscovery {
                windows: vec![window],
                truncated: false,
                max_windows,
            },
            waited_ms,
        )
    } else {
        (win32::discover_windows(max_windows)?, 0)
    };

    Ok(json!({
        "elements": [],
        "truncated": false,
        "max_nodes": params.limits().0,
        "max_depth": params.limits().1,
        "waited_ms": waited_ms,
        "observed_ms": 0,
        "events": [],
        "events_truncated": false,
        "uia_available": uia_available,
        "fallback": true,
        "fallback_provider": "win32",
        "fallback_reason": reason,
        "window_discovery": discovery
    }))
}

fn win32_selector(selector: &Selector) -> Result<Win32SelectorParts<'_>, String> {
    if selector.automation_id.is_some() || selector.control_type.is_some() {
        return Err("Win32 fallback cannot verify automation_id or control_type; use process_id, name/title, and/or class_name".into());
    }
    Ok(Win32SelectorParts {
        process_id: selector.process_id,
        title: selector.name.as_deref(),
        class_name: selector.class_name.as_deref(),
    })
}

fn attach_window_discovery(value: &mut Value, discovery: WindowDiscovery) {
    if let Value::Object(object) = value {
        object.insert(
            "window_discovery".into(),
            serde_json::to_value(discovery).unwrap_or(Value::Null),
        );
    }
}

fn should_try_win32_fallback(message: &str) -> bool {
    message.contains("No UI Automation element matched")
        || message.contains("Timed out waiting")
        || message.contains("Could not access UI Automation")
}

fn classify_win32_fallback_code(message: &str) -> &'static str {
    if message.contains("cannot provide requested") || message.contains("cannot verify") {
        "WIN32_FALLBACK_UNSUPPORTED"
    } else if message.contains("ambiguous") {
        "WIN32_FALLBACK_AMBIGUOUS"
    } else if message.contains("Timed out waiting") {
        "WIN32_FALLBACK_WAIT_TIMEOUT"
    } else if message.contains("No top-level Win32 window matched") {
        "WIN32_FALLBACK_NOT_FOUND"
    } else if message.contains("activation") || message.contains("SetForegroundWindow") {
        "WIN32_ACTIVATION_FAILED"
    } else {
        "WIN32_FALLBACK_FAILED"
    }
}

fn classify_code(message: &str) -> &'static str {
    if message.contains("Timed out waiting") { "UIA_WAIT_TIMEOUT" }
    else if message.contains("ambiguous") { "UIA_AMBIGUOUS_SELECTOR" }
    else if message.contains("No UI Automation element matched") { "UIA_ELEMENT_NOT_FOUND" }
    else if message.contains("does not support") { "UIA_PATTERN_UNAVAILABLE" }
    else if message.contains("read-only") { "UIA_READ_ONLY" }
    else if message.contains("postcondition failed") { "UIA_POSTCONDITION_FAILED" }
    else if message.contains("selector") || message.contains("requires") || message.contains("operation") { "INVALID_PARAMS" }
    else { "UIA_OPERATION_FAILED" }
}

fn is_retryable(message: &str) -> bool {
    message.contains("Timed out waiting")
        || message.contains("Could not access")
        || message.contains("initialization")
        || message.contains("SetFocus failed")
}

#[cfg(test)]
mod tests {
    use super::{classify_code, classify_win32_fallback_code, is_retryable, win32_selector};
    use crate::protocol::Selector;

    #[test]
    fn semantic_failures_are_classified() {
        assert_eq!(classify_code("UIA selector is ambiguous; narrow it"), "UIA_AMBIGUOUS_SELECTOR");
        assert_eq!(classify_code("No UI Automation element matched the semantic selector"), "UIA_ELEMENT_NOT_FOUND");
        assert_eq!(classify_code("Timed out waiting 5000 ms for a unique UI Automation element"), "UIA_WAIT_TIMEOUT");
        assert_eq!(classify_code("Matched element does not support InvokePattern"), "UIA_PATTERN_UNAVAILABLE");
        assert_eq!(classify_code("Value postcondition failed: x"), "UIA_POSTCONDITION_FAILED");
        assert!(is_retryable("Timed out waiting 5000 ms for a unique UI Automation element"));
        assert!(!is_retryable("Matched element does not support InvokePattern"));
    }

    #[test]
    fn fallback_selector_never_approximates_uia_only_fields() {
        let selector = Selector {
            automation_id: Some("save".into()),
            ..Default::default()
        };
        assert!(win32_selector(&selector).is_err());

        let selector = Selector {
            process_id: Some(42),
            name: Some("Editor".into()),
            class_name: Some("MainWindow".into()),
            ..Default::default()
        };
        let parts = win32_selector(&selector).unwrap();
        assert_eq!(parts.process_id, Some(42));
        assert_eq!(parts.title, Some("Editor"));
        assert_eq!(parts.class_name, Some("MainWindow"));
    }

    #[test]
    fn fallback_errors_have_distinct_codes() {
        assert_eq!(classify_win32_fallback_code("Win32 fallback selector is ambiguous"), "WIN32_FALLBACK_AMBIGUOUS");
        assert_eq!(classify_win32_fallback_code("No top-level Win32 window matched the semantic selector"), "WIN32_FALLBACK_NOT_FOUND");
        assert_eq!(classify_win32_fallback_code("Win32 fallback cannot verify automation_id"), "WIN32_FALLBACK_UNSUPPORTED");
    }
}
