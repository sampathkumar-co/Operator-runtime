use std::collections::HashMap;
use std::io;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const PROCESS_PATH_CAPACITY: usize = 1024;
const CLASS_NAME_CAPACITY: usize = 256;
const MAX_WINDOWS: usize = 200;

#[link(name = "user32")]
unsafe extern "system" {
    fn EnumWindows(callback: Option<unsafe extern "system" fn(isize, isize) -> i32>, lparam: isize) -> i32;
    fn GetWindowTextLengthW(hwnd: isize) -> i32;
    fn GetWindowTextW(hwnd: isize, buffer: *mut u16, max_count: i32) -> i32;
    fn GetClassNameW(hwnd: isize, buffer: *mut u16, max_count: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, process_id: *mut u32) -> u32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetForegroundWindow() -> isize;
    fn SetForegroundWindow(hwnd: isize) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> isize;
    fn QueryFullProcessImageNameW(process: isize, flags: u32, buffer: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowSummary {
    pub window_id: String,
    pub process_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    pub title: String,
    pub class_name: String,
    pub visible: bool,
    pub foreground: bool,
}

#[derive(Debug, Serialize)]
pub struct WindowDiscovery {
    pub windows: Vec<WindowSummary>,
    pub truncated: bool,
    pub max_windows: usize,
}

struct EnumState {
    windows: Vec<WindowSummary>,
    process_names: HashMap<u32, Option<String>>,
    foreground: isize,
    max_windows: usize,
    truncated: bool,
}

pub fn discover_windows(max_windows: usize) -> Result<WindowDiscovery, String> {
    let max_windows = max_windows.clamp(1, MAX_WINDOWS);
    let foreground = unsafe { GetForegroundWindow() };
    let mut state = EnumState {
        windows: Vec::new(),
        process_names: HashMap::new(),
        foreground,
        max_windows,
        truncated: false,
    };

    let result = unsafe { EnumWindows(Some(enum_window), (&mut state as *mut EnumState) as isize) };
    if result == 0 && !state.truncated {
        return Err(format!("Win32 EnumWindows failed: {}", io::Error::last_os_error()));
    }

    Ok(WindowDiscovery {
        windows: state.windows,
        truncated: state.truncated,
        max_windows,
    })
}

pub fn wait_for_unique_window(
    process_id: Option<u32>,
    title: Option<&str>,
    class_name: Option<&str>,
    wait_ms: u64,
) -> Result<(WindowSummary, u64), String> {
    validate_fallback_selector(process_id, title, class_name)?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(wait_ms);

    loop {
        let discovery = discover_windows(MAX_WINDOWS)?;
        let mut matches = filter_windows(discovery.windows, process_id, title, class_name);
        match matches.len() {
            1 => {
                let waited_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                return Ok((matches.pop().expect("length checked"), waited_ms));
            }
            count if count > 1 => {
                return Err("Win32 fallback selector is ambiguous; add process_id, name/title, or class_name".into());
            }
            _ if wait_ms == 0 || Instant::now() >= deadline => {
                if wait_ms > 0 {
                    return Err(format!("Timed out waiting {wait_ms} ms for a unique top-level Win32 window matching the semantic selector"));
                }
                return Err("No top-level Win32 window matched the semantic selector".into());
            }
            _ => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(remaining.min(Duration::from_millis(100)));
            }
        }
    }
}

pub fn activate_matching_window(
    process_id: u32,
    title: &str,
    class_name: &str,
) -> Result<(WindowSummary, WindowSummary), String> {
    activate_unique_window(
        Some(process_id),
        (!title.is_empty()).then_some(title),
        (!class_name.is_empty()).then_some(class_name),
        0,
    )
    .map(|(before, after, _)| (before, after))
}

pub fn activate_unique_window(
    process_id: Option<u32>,
    title: Option<&str>,
    class_name: Option<&str>,
    wait_ms: u64,
) -> Result<(WindowSummary, WindowSummary, u64), String> {
    let (before, waited_ms) = wait_for_unique_window(process_id, title, class_name, wait_ms)?;
    let hwnd = parse_window_id(&before.window_id)?;
    let accepted = unsafe { SetForegroundWindow(hwnd) };
    if accepted == 0 {
        return Err("Win32 SetForegroundWindow rejected activation".into());
    }
    let foreground = unsafe { GetForegroundWindow() };
    if foreground != hwnd {
        return Err("Window activation postcondition failed: requested window is not foreground".into());
    }

    let mut after = before.clone();
    after.foreground = true;
    Ok((before, after, waited_ms))
}

fn validate_fallback_selector(
    process_id: Option<u32>,
    title: Option<&str>,
    class_name: Option<&str>,
) -> Result<(), String> {
    if process_id.unwrap_or(0) == 0
        && title.is_none_or(str::is_empty)
        && class_name.is_none_or(str::is_empty)
    {
        return Err("Win32 fallback requires process_id, name/title, or class_name".into());
    }
    Ok(())
}

fn filter_windows(
    windows: Vec<WindowSummary>,
    process_id: Option<u32>,
    title: Option<&str>,
    class_name: Option<&str>,
) -> Vec<WindowSummary> {
    windows
        .into_iter()
        .filter(|window| {
            process_id.is_none_or(|expected| window.process_id == expected)
                && title.is_none_or(|expected| window.title == expected)
                && class_name.is_none_or(|expected| window.class_name == expected)
        })
        .collect()
}

unsafe extern "system" fn enum_window(hwnd: isize, lparam: isize) -> i32 {
    let state = unsafe { &mut *(lparam as *mut EnumState) };
    if state.windows.len() >= state.max_windows {
        state.truncated = true;
        return 0;
    }

    if unsafe { IsWindowVisible(hwnd) } == 0 {
        return 1;
    }

    let title = read_window_text(hwnd);
    let is_foreground = hwnd == state.foreground;
    if title.trim().is_empty() && !is_foreground {
        return 1;
    }

    let class_name = read_class_name(hwnd);
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
    let process_name = if process_id == 0 {
        None
    } else if let Some(cached) = state.process_names.get(&process_id) {
        cached.clone()
    } else {
        let resolved = process_basename(process_id);
        state.process_names.insert(process_id, resolved.clone());
        resolved
    };

    state.windows.push(WindowSummary {
        window_id: format!("0x{:X}", hwnd as usize),
        process_id,
        process_name,
        title: truncate(title, 512),
        class_name: truncate(class_name, 256),
        visible: true,
        foreground: is_foreground,
    });

    if state.windows.len() >= state.max_windows {
        state.truncated = true;
        0
    } else {
        1
    }
}

fn read_window_text(hwnd: isize) -> String {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return String::new();
    }
    let capacity = (length as usize + 1).min(4096);
    let mut buffer = vec![0u16; capacity];
    let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), capacity as i32) };
    if copied <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..copied as usize])
}

fn read_class_name(hwnd: isize) -> String {
    let mut buffer = [0u16; CLASS_NAME_CAPACITY];
    let copied = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if copied <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..copied as usize])
}

fn process_basename(process_id: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle == 0 {
        return None;
    }

    let mut buffer = [0u16; PROCESS_PATH_CAPACITY];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(handle) };
    if ok == 0 || size == 0 || size as usize > buffer.len() {
        return None;
    }

    let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
    basename(&full_path).map(|name| truncate(name.to_string(), 260))
}

fn parse_window_id(value: &str) -> Result<isize, String> {
    let hex = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .ok_or_else(|| "Internal Win32 window id is not hexadecimal".to_string())?;
    let raw = usize::from_str_radix(hex, 16)
        .map_err(|_| "Internal Win32 window id could not be parsed".to_string())?;
    Ok(raw as isize)
}

fn basename(path: &str) -> Option<&str> {
    path.rsplit(['\\', '/']).find(|part| !part.is_empty())
}

fn truncate(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::{basename, filter_windows, parse_window_id, validate_fallback_selector, WindowSummary};

    fn window(pid: u32, title: &str, class_name: &str) -> WindowSummary {
        WindowSummary {
            window_id: "0x2A".into(),
            process_id: pid,
            process_name: Some("app.exe".into()),
            title: title.into(),
            class_name: class_name.into(),
            visible: true,
            foreground: false,
        }
    }

    #[test]
    fn process_path_is_reduced_to_basename() {
        assert_eq!(basename(r"C:\Program Files\Example\example.exe"), Some("example.exe"));
        assert_eq!(basename("C:/Apps/tool.exe"), Some("tool.exe"));
        assert_eq!(basename(""), None);
    }

    #[test]
    fn internal_window_ids_are_strict_hex() {
        assert_eq!(parse_window_id("0x2A").unwrap(), 42);
        assert!(parse_window_id("42").is_err());
        assert!(parse_window_id("0xnothex").is_err());
    }

    #[test]
    fn fallback_matching_is_exact_and_semantic() {
        let windows = vec![window(10, "Editor", "Main"), window(20, "Editor", "Other")];
        let matched = filter_windows(windows, Some(10), Some("Editor"), Some("Main"));
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].process_id, 10);
    }

    #[test]
    fn fallback_requires_a_win32_verifiable_selector() {
        assert!(validate_fallback_selector(None, None, None).is_err());
        assert!(validate_fallback_selector(Some(42), None, None).is_ok());
        assert!(validate_fallback_selector(None, Some("Editor"), None).is_ok());
    }
}
