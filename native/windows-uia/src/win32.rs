use std::collections::HashMap;
use std::io;

use serde::Serialize;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const PROCESS_PATH_CAPACITY: usize = 1024;
const CLASS_NAME_CAPACITY: usize = 256;

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
    let max_windows = max_windows.clamp(1, 200);
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

pub fn activate_matching_window(
    process_id: u32,
    title: &str,
    class_name: &str,
) -> Result<(WindowSummary, WindowSummary), String> {
    if process_id == 0 {
        return Err("Window activation requires a resolved nonzero process id".into());
    }

    let discovery = discover_windows(200)?;
    let mut matches: Vec<WindowSummary> = discovery
        .windows
        .into_iter()
        .filter(|window| {
            window.process_id == process_id
                && (title.is_empty() || window.title == title)
                && (class_name.is_empty() || window.class_name == class_name)
        })
        .collect();

    if matches.is_empty() {
        return Err("No top-level Win32 window matched the resolved UI Automation element".into());
    }
    if matches.len() > 1 {
        return Err("Resolved UI Automation element maps to multiple Win32 windows; narrow the selector".into());
    }

    let before = matches.pop().expect("length checked");
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
    Ok((before, after))
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
    use super::{basename, parse_window_id};

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
}
