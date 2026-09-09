mod protocol;
mod uia;
mod win32;

use std::io::{self, BufRead, Write};

use protocol::{InspectParams, MAX_REQUEST_BYTES, OperateParams, Request, Response};
use serde_json::{json, Value};
use uia::UiaEngine;

fn main() {
    let engine = match UiaEngine::new() {
        Ok(engine) => engine,
        Err(error) => {
            eprintln!("[operator-windows-uia] {error}");
            std::process::exit(2);
        }
    };

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

fn handle_line(engine: &UiaEngine, line: &str) -> Response<Value> {
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
        "health" => Response::success(request.id, json!({
            "service": "operator-windows-uia",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1,
            "capabilities": ["inspect", "invoke", "set_value", "focus", "select", "expand", "collapse", "scroll", "wait", "window_discovery", "activate_window"]
        })),
        "inspect" => {
            let params: InspectParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => return Response::failure(request.id, "INVALID_PARAMS", format!("Invalid inspect params: {error}"), false),
            };
            let include_windows = params.include_windows;
            let max_windows = params.max_windows();
            match engine.inspect(params) {
                Ok(result) => {
                    let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
                    if include_windows {
                        let discovery = match win32::discover_windows(max_windows) {
                            Ok(discovery) => discovery,
                            Err(error) => return Response::failure(request.id, "WIN32_DISCOVERY_FAILED", error, true),
                        };
                        if let Value::Object(object) = &mut value {
                            object.insert(
                                "window_discovery".into(),
                                serde_json::to_value(discovery).unwrap_or(Value::Null),
                            );
                        }
                    }
                    Response::success(request.id, value)
                }
                Err(error) => {
                    let code = classify_code(&error);
                    let retryable = is_retryable(&error);
                    Response::failure(request.id, code, error, retryable)
                }
            }
        }
        "operate" => {
            let params: OperateParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => return Response::failure(request.id, "INVALID_PARAMS", format!("Invalid operate params: {error}"), false),
            };
            if let Err(error) = params.validate() {
                return Response::failure(request.id, "INVALID_PARAMS", error, false);
            }

            if params.operation == "activate_window" {
                let wait_ms = params.wait_ms();
                let inspect_params = InspectParams {
                    selector: Some(params.selector.clone()),
                    max_nodes: Some(1),
                    max_depth: Some(1),
                    observe_ms: Some(0),
                    wait_ms: Some(wait_ms),
                    include_windows: false,
                    max_windows: None,
                };
                let resolved = match engine.inspect(inspect_params) {
                    Ok(result) => result,
                    Err(error) => {
                        let code = classify_code(&error);
                        let retryable = is_retryable(&error);
                        return Response::failure(request.id, code, error, retryable);
                    }
                };
                let Some(element) = resolved.elements.first() else {
                    return Response::failure(
                        request.id,
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
                    Ok((before, after)) => Response::success(request.id, json!({
                        "operation": "activate_window",
                        "waited_ms": resolved.waited_ms,
                        "before": before,
                        "after": after,
                        "postcondition": { "foreground": true, "verified": true }
                    })),
                    Err(error) => Response::failure(request.id, "WIN32_ACTIVATION_FAILED", error, true),
                };
            }

            match engine.operate(params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => {
                    let code = classify_code(&error);
                    let retryable = is_retryable(&error);
                    Response::failure(request.id, code, error, retryable)
                }
            }
        }
        _ => Response::failure(request.id, "METHOD_NOT_ALLOWED", "method must be health, inspect, or operate", false),
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
    use super::{classify_code, is_retryable};

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
}
