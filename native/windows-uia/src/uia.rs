use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use uiautomation::events::{
    CustomPropertyChangedEventHandlerFn, CustomStructureChangedEventHandlerFn,
    UIPropertyChangedEventHandler, UIStructureChangeEventHandler,
};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UIScrollPattern, UISelectionItemPattern, UIValuePattern,
};
use uiautomation::types::{ScrollAmount, TreeScope, UIProperty};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

use crate::protocol::{InspectParams, OperateParams, Selector};

const MAX_EVENTS: usize = 200;
const NOT_FOUND: &str = "No UI Automation element matched the semantic selector";

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

#[derive(Debug, Serialize, Clone)]
pub struct UiEvent {
    pub elapsed_ms: u64,
    pub kind: String,
    pub name: String,
    pub automation_id: String,
    pub control_type: String,
    pub process_id: u32,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct InspectResult {
    pub elements: Vec<ElementSummary>,
    pub truncated: bool,
    pub max_nodes: usize,
    pub max_depth: usize,
    pub waited_ms: u64,
    pub observed_ms: u64,
    pub events: Vec<UiEvent>,
    pub events_truncated: bool,
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
        let observe_ms = params.observe_ms();
        let wait_ms = params.wait_ms();
        let (start, waited_ms) = if let Some(selector) = params.selector.as_ref() {
            selector.validate()?;
            self.find_unique_with_wait(selector, wait_ms)?
        } else {
            (
                self.automation
                    .get_root_element()
                    .map_err(|e| format!("Could not access UI Automation desktop root: {e}"))?,
                0,
            )
        };
        let event_root = start.clone();

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

        let (events, events_truncated) = if observe_ms > 0 {
            self.observe_events(&event_root, observe_ms)?
        } else {
            (Vec::new(), false)
        };

        Ok(InspectResult {
            elements,
            truncated,
            max_nodes,
            max_depth,
            waited_ms,
            observed_ms: observe_ms,
            events,
            events_truncated,
        })
    }

    pub fn operate(&self, params: OperateParams) -> Result<Value, String> {
        params.validate()?;
        let wait_ms = params.wait_ms();
        let (element, waited_ms) = self.find_unique_with_wait(&params.selector, wait_ms)?;
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
                    "waited_ms": waited_ms,
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
                    "waited_ms": waited_ms,
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
                    "waited_ms": waited_ms,
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
                    "waited_ms": waited_ms,
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
                    "waited_ms": waited_ms,
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
                    "waited_ms": waited_ms,
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

    fn observe_events(&self, root: &UIElement, observe_ms: u64) -> Result<(Vec<UiEvent>, bool), String> {
        let events = Arc::new(Mutex::new(Vec::<UiEvent>::new()));
        let truncated = Arc::new(Mutex::new(false));
        let started = Instant::now();

        let property_events = Arc::clone(&events);
        let property_truncated = Arc::clone(&truncated);
        let property_handler: Box<CustomPropertyChangedEventHandlerFn> = Box::new(move |sender, property, value| {
            push_event(
                &property_events,
                &property_truncated,
                event_from_element(
                    "property_changed",
                    sender,
                    format!("{property:?}={}", truncate(value.to_string(), 256)),
                    started,
                ),
            );
            Ok(())
        });
        let property_handler = UIPropertyChangedEventHandler::from(property_handler);

        let structure_events = Arc::clone(&events);
        let structure_truncated = Arc::clone(&truncated);
        let structure_handler: Box<CustomStructureChangedEventHandlerFn> = Box::new(move |sender, change_type, runtime_id| {
            let runtime = runtime_id
                .map(|items| items.iter().take(16).map(i32::to_string).collect::<Vec<_>>().join(","))
                .unwrap_or_default();
            push_event(
                &structure_events,
                &structure_truncated,
                event_from_element(
                    "structure_changed",
                    sender,
                    format!("{change_type:?};runtime_id={runtime}"),
                    started,
                ),
            );
            Ok(())
        });
        let structure_handler = UIStructureChangeEventHandler::from(structure_handler);

        let properties = [
            UIProperty::Name,
            UIProperty::ValueValue,
            UIProperty::HasKeyboardFocus,
            UIProperty::IsEnabled,
            UIProperty::IsOffscreen,
            UIProperty::ExpandCollapseExpandCollapseState,
            UIProperty::SelectionItemIsSelected,
            UIProperty::ScrollHorizontalScrollPercent,
            UIProperty::ScrollVerticalScrollPercent,
        ];

        self.automation
            .add_property_changed_event_handler(root, TreeScope::Subtree, None, &property_handler, &properties)
            .map_err(|e| format!("Could not register bounded UIA property observer: {e}"))?;
        if let Err(error) = self.automation
            .add_structure_changed_event_handler(root, TreeScope::Subtree, None, &structure_handler)
        {
            let _ = self.automation.remove_property_changed_event_handler(root, &property_handler);
            return Err(format!("Could not register bounded UIA structure observer: {error}"));
        }

        thread::sleep(Duration::from_millis(observe_ms));

        let remove_structure = self.automation.remove_structure_changed_event_handler(root, &structure_handler);
        let remove_property = self.automation.remove_property_changed_event_handler(root, &property_handler);
        if let Err(error) = remove_structure.and(remove_property) {
            let _ = self.automation.remove_all_event_handlers();
            return Err(format!("Could not remove bounded UIA event observers: {error}"));
        }

        let snapshot = events.lock()
            .map_err(|_| "UIA event buffer lock was poisoned".to_string())?
            .clone();
        let was_truncated = *truncated.lock()
            .map_err(|_| "UIA event truncation lock was poisoned".to_string())?;
        Ok((snapshot, was_truncated))
    }

    fn find_unique_with_wait(&self, selector: &Selector, wait_ms: u64) -> Result<(UIElement, u64), String> {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(wait_ms);
        loop {
            match self.find_unique(selector) {
                Ok(element) => {
                    let waited_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                    return Ok((element, waited_ms));
                }
                Err(error) if error == NOT_FOUND && wait_ms > 0 => {
                    let now = Instant::now();
                    if now >= deadline {
                        return Err(format!("Timed out waiting {wait_ms} ms for a unique UI Automation element matching the semantic selector"));
                    }
                    let remaining = deadline.saturating_duration_since(now);
                    thread::sleep(remaining.min(Duration::from_millis(100)));
                }
                Err(error) => return Err(error),
            }
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

        matches.pop().ok_or_else(|| NOT_FOUND.into())
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

fn push_event(events: &Arc<Mutex<Vec<UiEvent>>>, truncated: &Arc<Mutex<bool>>, event: UiEvent) {
    if let Ok(mut buffer) = events.lock() {
        if buffer.len() < MAX_EVENTS {
            buffer.push(event);
        } else if let Ok(mut flag) = truncated.lock() {
            *flag = true;
        }
    }
}

fn event_from_element(kind: &str, element: &UIElement, detail: String, started: Instant) -> UiEvent {
    UiEvent {
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        kind: kind.into(),
        name: truncate(element.get_name().unwrap_or_default(), 256),
        automation_id: truncate(element.get_automation_id().unwrap_or_default(), 256),
        control_type: element.get_control_type().map(|value| format!("{value:?}")).unwrap_or_else(|_| "Unknown".into()),
        process_id: element.get_process_id().unwrap_or_default(),
        detail: truncate(detail, 512),
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
        assert!(parse_scroll_amount(Some("arbitrary")).is_err());
    }

    #[test]
    fn scroll_postcondition_checks_direction_but_allows_boundaries() {
        assert!(scroll_postcondition(50.0, 60.0, ScrollAmount::SmallIncrement));
        assert!(!scroll_postcondition(60.0, 50.0, ScrollAmount::SmallIncrement));
        assert!(scroll_postcondition(0.0, 0.0, ScrollAmount::SmallDecrement));
        assert!(scroll_postcondition(-1.0, -1.0, ScrollAmount::SmallIncrement));
    }
}
