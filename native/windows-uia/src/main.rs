mod protocol;
mod uia;

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
            "capabilities": ["inspect", "invoke", "set_value", "focus"]
        })),
        "inspect" => {
            let params: InspectParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => return Response::failure(request.id, "INVALID_PARAMS", format!("Invalid inspect params: {error}"), false),
            };
            match engine.inspect(params) {
                Ok(result) => Response::success(request.id, serde_json::to_value(result).unwrap_or(Value::Null)),
                Err(error) => Response::failure(request.id, classify_code(&error), error, is_retryable(&error)),
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
            match engine.operate(params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => Response::failure(request.id, classify_code(&error), error, is_retryable(&error)),
            }
        }
        _ => Response::failure(request.id, "METHOD_NOT_ALLOWED", "method must be health, inspect, or operate", false),
    }
}

fn classify_code(message: &str) -> &'static str {
    if message.contains("ambiguous") { "UIA_AMBIGUOUS_SELECTOR" }
    else if message.contains("No UI Automation element matched") { "UIA_ELEMENT_NOT_FOUND" }
    else if message.contains("does not support") { "UIA_PATTERN_UNAVAILABLE" }
    else if message.contains("read-only") { "UIA_READ_ONLY" }
    else if message.contains("postcondition failed") { "UIA_POSTCONDITION_FAILED" }
    else if message.contains("selector") || message.contains("requires") || message.contains("operation") { "INVALID_PARAMS" }
    else { "UIA_OPERATION_FAILED" }
}

fn is_retryable(message: &str) -> bool {
    message.contains("Could not access") || message.contains("initialization") || message.contains("SetFocus failed")
}

#[cfg(test)]
mod tests {
    use super::{classify_code, is_retryable};

    #[test]
    fn semantic_failures_are_classified() {
        assert_eq!(classify_code("UIA selector is ambiguous; narrow it"), "UIA_AMBIGUOUS_SELECTOR");
        assert_eq!(classify_code("No UI Automation element matched the semantic selector"), "UIA_ELEMENT_NOT_FOUND");
        assert_eq!(classify_code("Matched element does not support InvokePattern"), "UIA_PATTERN_UNAVAILABLE");
        assert_eq!(classify_code("Value postcondition failed: x"), "UIA_POSTCONDITION_FAILED");
        assert!(!is_retryable("Matched element does not support InvokePattern"));
    }
}
