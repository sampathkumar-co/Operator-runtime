use std::collections::VecDeque;

use serde::Serialize;
use serde_json::{json, Value};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UIScrollPattern, UISelectionItemPattern, UIValuePattern,
};
use uiautomation::types::ScrollAmount;
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

use crate::protocol::{InspectParams, OperateParams, Selector};

#[derive(Debug, Serialize, Clone)]
pub struct PatternSupport {
    pub invoke: bool,
    pub value: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub scroll: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScrollState {
    pub horizontal_percent: f64,
    pub vertical_percent: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ElementSummary {
    pub name: String,
    pub automation_id: String,
    pub class_name: String,
    pub control_type: String,
    pub process_id: u32,
    pub depth: usize,
    pub patterns: PatternSupport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand_collapse_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<ScrollState>,
}

#[derive(Debug, Serialize)]
pub struct InspectResult {
    pub elements: Vec<ElementSummary>,
    pub truncated: bool,
    pub max_nodes: usize,
    pub max_depth: usize,
}

pub struct UiaEngine {
    automation: UIAutomation,
    walker: UITreeWalker,
}

impl UiaEngine {
    pub fn new() -> Result<Self, String> {
        let automation = UIAutomation::new().map_err(|e| format!("UIAutomation initialization failed: {e}"))?;
        let walker = automation
            .get_control_view_walker()
            .map_err(|e| format!("ControlView walker initialization failed: {e}"))?;
        Ok(Self { automation, walker })
    }

    pub fn inspect(&self, params: InspectParams) -> Result<InspectResult, String> {
        let (max_nodes, max_depth) = params.limits();
        let start = if let Some(selector) = params.selector.as_ref() {
            selector.validate()?;
            self.find_unique(selector)?
        } else {
            self.automation
                .get_root_element()
                .map_err(|e| format!("Could not access UI Automation desktop root: {e}"))?
        };

        let mut queue = VecDeque::from([(start, 0usize)]);
        let mut elements = Vec::new();
        let mut truncated = false;

        while let Some((element, depth)) = queue.pop_front() {
            if elements.len() >= max_nodes {
                truncated = true;
                break;
            }
            elements.push(self.summarize(&element, depth));
            if depth >= max_depth {
                continue;
            }
            if let Some(children) = self.walker.get_children(&element) {
                for child in children {
                    if queue.len() + elements.len() >= max_nodes * 2 {
                        truncated = true;
                        break;
                    }
                    queue.push_back((child, depth + 1));
                }
            }
        }

        Ok(InspectResult { elements, truncated, max_nodes, max_depth })
    }

    pub fn operate(&self, params: OperateParams) -> Result<Value, String> {
        params.validate()?;
        let element = self.find_unique(&params.selector)?;
        let before = self.summarize(&element, 0);

        match params.operation.as_str() {
            "invoke" => {
                let pattern: UIInvokePattern = element
                    .get_pattern()
                    .map_err(|_| "Matched element does not support InvokePattern".to_string())?;
                pattern.invoke().map_err(|e| format!("InvokePattern failed: {e}"))?;
                let after = self.summarize(&element, 0);
                Ok(json!({
                    "operation": "invoke",
                    "before": before,
                    "after": after,
                    "postcondition": { "element_reachable": true }
                }))
            }
            "set_value" => {
                let value = params.value.as_deref().ok_or("set_value requires value")?;
                let pattern: UIValuePattern = element
                    .get_pattern()
                    .map_err(|_| "Matched element does not support ValuePattern".to_string())?;
                if pattern.is_readonly().map_err(|e| format!("Could not read ValuePattern read-only state: {e}"))? {
                    return Err("Matched element ValuePattern is read-only".into());
                }
                pattern.set_value(value).map_err(|e| format!("ValuePattern SetValue failed: {e}"))?;
                let actual = pattern.get_value().map_err(|e| format!("Could not verify ValuePattern value: {e}"))?;
                if actual != value {
                    return Err(format!("Value postcondition failed: expected {:?}, observed {:?}", value, actual));
                }
                let after = self.summarize(&element, 0);
                Ok(json!({
                    "operation": "set_value",
                    "before": before,
                    "after": after,
                    "postcondition": { "expected_value": value, "actual_value": actual, "verified": true }
                }))
            }
            "focus" => {
                element.set_focus().map_err(|e| format!("SetFocus failed: {e}"))?;
                let focused = self.automation
                    .get_focused_element()
                    .map_err(|e| format!("Could not read focused UIA element after SetFocus: {e}"))?;
                let verified = self.automation
                    .compare_elements(&element, &focused)
                    .map_err(|e| format!("Could not compare focused UIA element: {e}"))?;
                if !verified {
                    return Err("Focus postcondition failed: requested element is not focused".into());
                }
                let after = self.summarize(&focused, 0);
                Ok(json!({
                    "operation": "focus",
                    "before": before,
                    "after": after,
                    "postcondition": { "focused": true, "verified": true }
                }))
            }
            "select" => {
                let pattern: UISelectionItemPattern = element
                    .get_pattern()
                    .map_err(|_| "Matched element does not support SelectionItemPattern".to_string())?;
                pattern.select().map_err(|e| format!("SelectionItemPattern Select failed: {e}"))?;
                let selected = pattern.is_selected().map_err(|e| format!("Could not verify SelectionItemPattern state: {e}"))?;
                if !selected {
                    return Err("Selection postcondition failed: requested element is not selected".into());
                }
                let after = self.summarize(&element, 0);
                Ok(json!({
                    "operation": "select",
                    "before": before,
                    "after": after,
                    "postcondition": { "selected": true, "verified": true }
                }))
            }
            "expand" | "collapse" => {
                let pattern: UIExpandCollapsePattern = element
                    .get_pattern()
                    .map_err(|_| "Matched element does not support ExpandCollapsePattern".to_string())?;
                if params.operation == "expand" {
                    pattern.expand().map_err(|e| format!("ExpandCollapsePattern Expand failed: {e}"))?;
                } else {
                    pattern.collapse().map_err(|e| format!("ExpandCollapsePattern Collapse failed: {e}"))?;
                }
                let state = pattern.get_state().map_err(|e| format!("Could not verify ExpandCollapsePattern state: {e}"))?;
                let actual = format!("{state:?}");
                let expected = if params.operation == "expand" { "Expanded" } else { "Collapsed" };
                if actual != expected {
                    return Err(format!("ExpandCollapse postcondition failed: expected {expected}, observed {actual}"));
                }
                let after = self.summarize(&element, 0);
                Ok(json!({
                    "operation": params.operation,
                    "before": before,
                    "after": after,
                    "postcondition": { "expected_state": expected, "actual_state": actual, "verified": true }
                }))
            }
            "scroll" => {
                let pattern: UIScrollPattern = element
                    .get_pattern()
                    .map_err(|_| "Matched element does not support ScrollPattern".to_string())?;
                let horizontal = parse_scroll_amount(params.horizontal_amount.as_deref())?;
                let vertical = parse_scroll_amount(params.vertical_amount.as_deref())?;
                let before_horizontal = pattern.get_horizontal_scroll_percent()
                    .map_err(|e| format!("Could not read horizontal scroll percent before Scroll: {e}"))?;
                let before_vertical = pattern.get_vertical_scroll_percent()
                    .map_err(|e| format!("Could not read vertical scroll percent before Scroll: {e}"))?;
                pattern.scroll(horizontal, vertical).map_err(|e| format!("ScrollPattern Scroll failed: {e}"))?;
                let after_horizontal = pattern.get_horizontal_scroll_percent()
                    .map_err(|e| format!("Could not verify horizontal scroll percent after Scroll: {e}"))?;
                let after_vertical = pattern.get_vertical_scroll_percent()
                    .map_err(|e| format!("Could not verify vertical scroll percent after Scroll: {e}"))?;
                if !scroll_postcondition(before_horizontal, after_horizontal, horizontal)
                    || !scroll_postcondition(before_vertical, after_vertical, vertical)
                {
                    return Err(format!(
                        "Scroll postcondition failed: horizontal {before_horizontal}->{after_horizontal}, vertical {before_vertical}->{after_vertical}"
                    ));
                }
                let after = self.summarize(&element, 0);
                Ok(json!({
                    "operation": "scroll",
                    "before": before,
                    "after": after,
                    "postcondition": {
                        "horizontal": { "before": before_horizontal, "after": after_horizontal },
                        "vertical": { "before": before_vertical, "after": after_vertical },
                        "verified": true
                    }
                }))
            }
            _ => Err("Unsupported UIA operation".into()),
        }
    }

    fn find_unique(&self, selector: &Selector) -> Result<UIElement, String> {
        let root = self.automation
            .get_root_element()
            .map_err(|e| format!("Could not access UI Automation desktop root: {e}"))?;
        let mut queue = VecDeque::from([(root, 0usize)]);
        let mut matches = Vec::new();
        let mut scanned = 0usize;
        const MAX_SCAN: usize = 10_000;
        const MAX_DEPTH: usize = 16;

        while let Some((element, depth)) = queue.pop_front() {
            if scanned >= MAX_SCAN {
                return Err("UIA selector scan exceeded 10,000 controls; narrow the selector".into());
            }
            scanned += 1;
            if self.matches_selector(&element, selector) {
                matches.push(element.clone());
                if matches.len() > 1 {
                    return Err("UIA selector is ambiguous; add automation_id, class_name, control_type, or process_id".into());
                }
            }
            if depth >= MAX_DEPTH {
                continue;
            }
            if let Some(children) = self.walker.get_children(&element) {
                for child in children {
                    queue.push_back((child, depth + 1));
                }
            }
        }

        matches.pop().ok_or_else(|| "No UI Automation element matched the semantic selector".into())
    }

    fn matches_selector(&self, element: &UIElement, selector: &Selector) -> bool {
        if let Some(expected) = selector.name.as_deref()
            && element.get_name().unwrap_or_default() != expected
        {
            return false;
        }
        if let Some(expected) = selector.automation_id.as_deref()
            && element.get_automation_id().unwrap_or_default() != expected
        {
            return false;
        }
        if let Some(expected) = selector.class_name.as_deref()
            && element.get_classname().unwrap_or_default() != expected
        {
            return false;
        }
        if let Some(expected) = selector.process_id
            && element.get_process_id().unwrap_or_default() != expected
        {
            return false;
        }
        if let Some(expected) = selector.control_type.as_deref() {
            let actual = element.get_control_type().map(|value| format!("{value:?}")).unwrap_or_default();
            if !actual.eq_ignore_ascii_case(expected) { return false; }
        }
        true
    }

    fn summarize(&self, element: &UIElement, depth: usize) -> ElementSummary {
        let invoke = element.get_pattern::<UIInvokePattern>().is_ok();
        let value_pattern = element.get_pattern::<UIValuePattern>().ok();
        let selection_pattern = element.get_pattern::<UISelectionItemPattern>().ok();
        let expand_pattern = element.get_pattern::<UIExpandCollapsePattern>().ok();
        let scroll_pattern = element.get_pattern::<UIScrollPattern>().ok();
        let value = value_pattern
            .as_ref()
            .and_then(|pattern| pattern.get_value().ok())
            .map(|value| truncate(value, 512));
        let selected = selection_pattern.as_ref().and_then(|pattern| pattern.is_selected().ok());
        let expand_collapse_state = expand_pattern
            .as_ref()
            .and_then(|pattern| pattern.get_state().ok())
            .map(|state| format!("{state:?}"));
        let scroll = scroll_pattern.as_ref().and_then(|pattern| {
            Some(ScrollState {
                horizontal_percent: pattern.get_horizontal_scroll_percent().ok()?,
                vertical_percent: pattern.get_vertical_scroll_percent().ok()?,
            })
        });
        ElementSummary {
            name: truncate(element.get_name().unwrap_or_default(), 512),
            automation_id: truncate(element.get_automation_id().unwrap_or_default(), 512),
            class_name: truncate(element.get_classname().unwrap_or_default(), 512),
            control_type: element.get_control_type().map(|value| format!("{value:?}")).unwrap_or_else(|_| "Unknown".into()),
            process_id: element.get_process_id().unwrap_or_default(),
            depth,
            patterns: PatternSupport {
                invoke,
                value: value_pattern.is_some(),
                selection_item: selection_pattern.is_some(),
                expand_collapse: expand_pattern.is_some(),
                scroll: scroll_pattern.is_some(),
            },
            value,
            selected,
            expand_collapse_state,
            scroll,
        }
    }
}

fn parse_scroll_amount(value: Option<&str>) -> Result<ScrollAmount, String> {
    match value.unwrap_or("none") {
        "large_decrement" => Ok(ScrollAmount::LargeDecrement),
        "small_decrement" => Ok(ScrollAmount::SmallDecrement),
        "none" => Ok(ScrollAmount::NoAmount),
        "large_increment" => Ok(ScrollAmount::LargeIncrement),
        "small_increment" => Ok(ScrollAmount::SmallIncrement),
        other => Err(format!("Unsupported scroll amount {other:?}")),
    }
}

fn scroll_postcondition(before: f64, after: f64, amount: ScrollAmount) -> bool {
    if before < 0.0 || after < 0.0 || amount == ScrollAmount::NoAmount {
        return true;
    }
    match amount {
        ScrollAmount::LargeDecrement | ScrollAmount::SmallDecrement => after <= before,
        ScrollAmount::LargeIncrement | ScrollAmount::SmallIncrement => after >= before,
        ScrollAmount::NoAmount => true,
    }
}

fn truncate(mut value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value = value.chars().take(max_chars).collect();
    value
}

#[cfg(test)]
mod tests {
    use super::{parse_scroll_amount, scroll_postcondition, truncate};
    use uiautomation::types::ScrollAmount;

    #[test]
    fn truncation_is_character_safe() {
        assert_eq!(truncate("abcdef".into(), 3), "abc");
        assert_eq!(truncate("नमस्ते".into(), 2).chars().count(), 2);
    }

    #[test]
    fn scroll_amounts_are_closed_and_default_missing_axis_to_none() {
        assert_eq!(parse_scroll_amount(None).unwrap(), ScrollAmount::NoAmount);
        assert_eq!(parse_scroll_amount(Some("small_increment")).unwrap(), ScrollAmount::SmallIncrement);
        assert!(parse_scroll_amount(Some("arbitrary")) .is_err());
    }

    #[test]
    fn scroll_postcondition_checks_direction_but_allows_boundaries() {
        assert!(scroll_postcondition(50.0, 60.0, ScrollAmount::SmallIncrement));
        assert!(!scroll_postcondition(60.0, 50.0, ScrollAmount::SmallIncrement));
        assert!(scroll_postcondition(0.0, 0.0, ScrollAmount::SmallDecrement));
        assert!(scroll_postcondition(-1.0, -1.0, ScrollAmount::SmallIncrement));
    }
}
