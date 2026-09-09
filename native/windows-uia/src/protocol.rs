use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_NODES: usize = 250;
pub const HARD_MAX_NODES: usize = 1500;
pub const DEFAULT_MAX_DEPTH: usize = 6;
pub const HARD_MAX_DEPTH: usize = 12;

const SCROLL_AMOUNTS: &[&str] = &[
    "large_decrement",
    "small_decrement",
    "none",
    "large_increment",
    "small_increment",
];

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct Selector {
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub control_type: Option<String>,
    pub process_id: Option<u32>,
}

impl Selector {
    pub fn validate(&self) -> Result<(), String> {
        if self.is_empty() {
            return Err("selector must include at least one semantic property".into());
        }
        for (field, value) in [
            ("name", self.name.as_deref()),
            ("automation_id", self.automation_id.as_deref()),
            ("class_name", self.class_name.as_deref()),
            ("control_type", self.control_type.as_deref()),
        ] {
            if let Some(value) = value {
                if value.trim().is_empty() {
                    return Err(format!("{field} must not be blank"));
                }
                if value.len() > 512 {
                    return Err(format!("{field} exceeds 512 characters"));
                }
            }
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.automation_id.is_none()
            && self.class_name.is_none()
            && self.control_type.is_none()
            && self.process_id.is_none()
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct InspectParams {
    #[serde(default)]
    pub selector: Option<Selector>,
    #[serde(default)]
    pub max_nodes: Option<usize>,
    #[serde(default)]
    pub max_depth: Option<usize>,
}

impl InspectParams {
    pub fn limits(&self) -> (usize, usize) {
        (
            self.max_nodes.unwrap_or(DEFAULT_MAX_NODES).clamp(1, HARD_MAX_NODES),
            self.max_depth.unwrap_or(DEFAULT_MAX_DEPTH).clamp(1, HARD_MAX_DEPTH),
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OperateParams {
    pub operation: String,
    pub selector: Selector,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub horizontal_amount: Option<String>,
    #[serde(default)]
    pub vertical_amount: Option<String>,
}

impl OperateParams {
    pub fn validate(&self) -> Result<(), String> {
        self.selector.validate()?;
        match self.operation.as_str() {
            "invoke" | "focus" | "select" | "expand" | "collapse" => {
                if self.value.is_some() || self.horizontal_amount.is_some() || self.vertical_amount.is_some() {
                    return Err(format!("{} does not accept value or scroll amounts", self.operation));
                }
            }
            "set_value" => {
                let value = self.value.as_deref().ok_or("set_value requires value")?;
                if value.len() > 64 * 1024 {
                    return Err("value exceeds 64 KiB".into());
                }
                if self.horizontal_amount.is_some() || self.vertical_amount.is_some() {
                    return Err("set_value does not accept scroll amounts".into());
                }
            }
            "scroll" => {
                if self.value.is_some() {
                    return Err("scroll does not accept value".into());
                }
                if self.horizontal_amount.is_none() && self.vertical_amount.is_none() {
                    return Err("scroll requires horizontal_amount or vertical_amount".into());
                }
                for (field, value) in [
                    ("horizontal_amount", self.horizontal_amount.as_deref()),
                    ("vertical_amount", self.vertical_amount.as_deref()),
                ] {
                    if let Some(value) = value
                        && !SCROLL_AMOUNTS.contains(&value)
                    {
                        return Err(format!("{field} must be one of {}", SCROLL_AMOUNTS.join(", ")));
                    }
                }
            }
            _ => return Err("operation must be invoke, set_value, focus, select, expand, collapse, or scroll".into()),
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct Response<T: Serialize> {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl<T: Serialize> Response<T> {
    pub fn success(id: impl Into<String>, result: T) -> Self {
        Self { id: id.into(), ok: true, result: Some(result), error: None }
    }
}

impl Response<Value> {
    pub fn failure(id: impl Into<String>, code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            id: id.into(),
            ok: false,
            result: None,
            error: Some(ErrorBody { code: code.into(), message: message.into(), retryable }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operate(operation: &str) -> OperateParams {
        OperateParams {
            operation: operation.into(),
            selector: Selector { automation_id: Some("target".into()), ..Default::default() },
            value: None,
            horizontal_amount: None,
            vertical_amount: None,
        }
    }

    #[test]
    fn selector_requires_a_semantic_property() {
        assert!(Selector::default().validate().is_err());
        assert!(Selector { name: Some("Save".into()), ..Default::default() }.validate().is_ok());
    }

    #[test]
    fn inspect_limits_are_clamped() {
        let params = InspectParams { selector: None, max_nodes: Some(50_000), max_depth: Some(99) };
        assert_eq!(params.limits(), (HARD_MAX_NODES, HARD_MAX_DEPTH));
    }

    #[test]
    fn operations_are_closed_not_scriptable() {
        assert!(operate("invoke").validate().is_ok());
        assert!(operate("select").validate().is_ok());
        assert!(operate("expand").validate().is_ok());
        assert!(operate("collapse").validate().is_ok());
        assert!(operate("run_javascript").validate().is_err());
    }

    #[test]
    fn set_value_requires_value_and_caps_payload() {
        let mut params = operate("set_value");
        assert!(params.validate().is_err());
        params.value = Some("x".repeat(70_000));
        assert!(params.validate().is_err());
        params.value = Some("hello".into());
        assert!(params.validate().is_ok());
    }

    #[test]
    fn scroll_requires_bounded_enum_amount() {
        let mut params = operate("scroll");
        assert!(params.validate().is_err());
        params.vertical_amount = Some("small_increment".into());
        assert!(params.validate().is_ok());
        params.vertical_amount = Some("999999".into());
        assert!(params.validate().is_err());
    }
}
