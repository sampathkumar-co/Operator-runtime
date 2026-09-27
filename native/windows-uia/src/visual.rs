use std::io;
use std::mem::size_of;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::protocol::Selector;
use crate::win32;

const DEFAULT_MAX_WIDTH: u32 = 960;
const DEFAULT_MAX_HEIGHT: u32 = 540;
const HARD_MAX_WIDTH: u32 = 1280;
const HARD_MAX_HEIGHT: u32 = 720;
const MAX_WAIT_MS: u64 = 10_000;
const MAX_TEXT_UTF16_UNITS: usize = 4096;
const MAX_HOTKEY_KEYS: usize = 4;

fn default_source() -> String { "screen".into() }

const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

const SRCCOPY: u32 = 0x00CC_0020;
const COLORONCOLOR: i32 = 3;
const DIB_RGB_COLORS: u32 = 0;
const BI_RGB: u32 = 0;

const INPUT_MOUSE: u32 = 0;
const INPUT_KEYBOARD: u32 = 1;
const MOUSEEVENTF_MOVE: u32 = 0x0001;
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_WHEEL: u32 = 0x0800;
const MOUSEEVENTF_HWHEEL: u32 = 0x1000;
const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const KEYEVENTF_UNICODE: u32 = 0x0004;

#[link(name = "user32")]
unsafe extern "system" {
    fn GetDC(hwnd: isize) -> isize;
    fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
    fn CreateCompatibleBitmap(hdc: isize, width: i32, height: i32) -> isize;
    fn SelectObject(hdc: isize, object: isize) -> isize;
    fn DeleteObject(object: isize) -> i32;
    fn SetStretchBltMode(hdc: isize, mode: i32) -> i32;
    fn StretchBlt(
        dest: isize,
        x_dest: i32,
        y_dest: i32,
        width_dest: i32,
        height_dest: i32,
        src: isize,
        x_src: i32,
        y_src: i32,
        width_src: i32,
        height_src: i32,
        rop: u32,
    ) -> i32;
    fn GetDIBits(
        hdc: isize,
        bitmap: isize,
        start: u32,
        lines: u32,
        bits: *mut core::ffi::c_void,
        info: *mut BitmapInfo,
        usage: u32,
    ) -> i32;
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CaptureParams {
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub selector: Option<Selector>,
    #[serde(default)]
    pub region: Option<Region>,
    #[serde(default)]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub max_height: Option<u32>,
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureResult {
    pub source: String,
    pub origin_x: i32,
    pub origin_y: i32,
    pub source_width: u32,
    pub source_height: u32,
    pub returned_width: u32,
    pub returned_height: u32,
    pub scale_x: f64,
    pub scale_y: f64,
    pub mime_type: &'static str,
    pub png_base64: String,
    pub waited_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputParams {
    pub operation: String,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub to_x: Option<i32>,
    #[serde(default)]
    pub to_y: Option<i32>,
    #[serde(default)]
    pub delta_x: Option<i32>,
    #[serde(default)]
    pub delta_y: Option<i32>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
    #[serde(default)]
    pub expected_window_id: Option<String>,
}

impl CaptureParams {
    fn limits(&self) -> (u32, u32) {
        (
            self.max_width.unwrap_or(DEFAULT_MAX_WIDTH).clamp(1, HARD_MAX_WIDTH),
            self.max_height.unwrap_or(DEFAULT_MAX_HEIGHT).clamp(1, HARD_MAX_HEIGHT),
        )
    }

    fn wait_ms(&self) -> u64 {
        self.wait_ms.unwrap_or(0).min(MAX_WAIT_MS)
    }
}

impl InputParams {
    pub fn validate(&self) -> Result<(), String> {
        match self.operation.as_str() {
            "move" | "click" | "double_click" => {
                require_xy(self.x, self.y)?;
                reject_non_pointer_payload(self, false)?;
            }
            "drag" => {
                require_xy(self.x, self.y)?;
                require_xy(self.to_x, self.to_y)?;
                reject_non_pointer_payload(self, false)?;
            }
            "scroll" => {
                require_xy(self.x, self.y)?;
                if self.delta_x.unwrap_or(0) == 0 && self.delta_y.unwrap_or(0) == 0 {
                    return Err("scroll requires non-zero delta_x or delta_y".into());
                }
                for value in [self.delta_x.unwrap_or(0), self.delta_y.unwrap_or(0)] {
                    if !(-1200..=1200).contains(&value) {
                        return Err("scroll delta must be between -1200 and 1200".into());
                    }
                }
                if self.text.is_some() || self.key.is_some() || self.keys.is_some() || self.to_x.is_some() || self.to_y.is_some() {
                    return Err("scroll does not accept text, key, hotkey, or drag destination fields".into());
                }
            }
            "type_text" => {
                let text = self.text.as_deref().ok_or("type_text requires text")?;
                if text.encode_utf16().count() > MAX_TEXT_UTF16_UNITS {
                    return Err(format!("type_text exceeds {MAX_TEXT_UTF16_UNITS} UTF-16 units"));
                }
                require_window(self)?;
                reject_pointer_payload(self)?;
                if self.key.is_some() || self.keys.is_some() {
                    return Err("type_text does not accept key or keys".into());
                }
            }
            "key_press" => {
                let key = self.key.as_deref().ok_or("key_press requires key")?;
                virtual_key(key)?;
                require_window(self)?;
                reject_pointer_payload(self)?;
                if self.text.is_some() || self.keys.is_some() {
                    return Err("key_press does not accept text or keys".into());
                }
            }
            "hotkey" => {
                let keys = self.keys.as_deref().ok_or("hotkey requires keys")?;
                if keys.is_empty() || keys.len() > MAX_HOTKEY_KEYS {
                    return Err(format!("hotkey requires 1-{MAX_HOTKEY_KEYS} keys"));
                }
                for key in keys {
                    virtual_key(key)?;
                }
                require_window(self)?;
                reject_pointer_payload(self)?;
                if self.text.is_some() || self.key.is_some() {
                    return Err("hotkey does not accept text or key".into());
                }
            }
            _ => return Err("operation must be move, click, double_click, drag, scroll, type_text, key_press, or hotkey".into()),
        }
        Ok(())
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct BitmapInfoHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pels_per_meter: i32,
    y_pels_per_meter: i32,
    clr_used: u32,
    clr_important: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RgbQuad {
    blue: u8,
    green: u8,
    red: u8,
    reserved: u8,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [RgbQuad; 1],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KeyboardInput {
    virtual_key: u16,
    scan: u16,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
union InputUnion {
    mouse: MouseInput,
    keyboard: KeyboardInput,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    kind: u32,
    value: InputUnion,
}

pub fn capture(params: CaptureParams) -> Result<CaptureResult, String> {
    let (max_width, max_height) = params.limits();
    let virtual_rect = virtual_desktop()?;
    let (source, rect, window_id, waited_ms) = match params.source.as_str() {
        "screen" => {
            if params.selector.is_some() || params.region.is_some() {
                return Err("screen capture does not accept selector or region".into());
            }
            ("screen".to_string(), virtual_rect, None, 0)
        }
        "region" => {
            if params.selector.is_some() {
                return Err("region capture does not accept selector".into());
            }
            let region = params.region.ok_or("region capture requires region")?;
            let rect = rect_from_region(region)?;
            assert_inside(rect, virtual_rect)?;
            ("region".to_string(), rect, None, 0)
        }
        "window" => {
            if params.region.is_some() {
                return Err("window capture does not accept region".into());
            }
            let selector = params.selector.as_ref().ok_or("window capture requires selector")?;
            if selector.automation_id.is_some() || selector.control_type.is_some() {
                return Err("window visual capture requires process_id, name/title, and/or class_name; UIA-only selector fields cannot be approximated".into());
            }
            selector.validate()?;
            let (window, waited_ms) = win32::wait_for_unique_window(
                selector.process_id,
                selector.name.as_deref(),
                selector.class_name.as_deref(),
                params.wait_ms(),
            )?;
            if !window.foreground {
                return Err("Window visual capture requires the uniquely matched window to be foreground".into());
            }
            let hwnd = win32::parse_window_id(&window.window_id)?;
            let rect = window_rect(hwnd)?;
            assert_inside(rect, virtual_rect)?;
            ("window".to_string(), rect, Some(window.window_id), waited_ms)
        }
        _ => return Err("capture source must be screen, window, or region".into()),
    };

    let source_width = rect_width(rect)?;
    let source_height = rect_height(rect)?;
    let (returned_width, returned_height) = fit_dimensions(source_width, source_height, max_width, max_height);
    let rgb = capture_rgb(rect, returned_width, returned_height)?;
    let png = encode_png(returned_width, returned_height, &rgb)?;
    let png_base64 = base64_encode(&png);
    Ok(CaptureResult {
        source,
        origin_x: rect.left,
        origin_y: rect.top,
        source_width,
        source_height,
        returned_width,
        returned_height,
        scale_x: f64::from(source_width) / f64::from(returned_width),
        scale_y: f64::from(source_height) / f64::from(returned_height),
        mime_type: "image/png",
        png_base64,
        waited_ms,
        window_id,
    })
}

pub fn operate(params: InputParams) -> Result<serde_json::Value, String> {
    params.validate()?;
    let foreground = if let Some(window_id) = params.expected_window_id.as_deref() {
        Some(win32::ensure_foreground_window_id(window_id)?)
    } else {
        None
    };

    match params.operation.as_str() {
        "move" => move_pointer(params.x.expect("validated"), params.y.expect("validated"))?,
        "click" => {
            move_pointer(params.x.expect("validated"), params.y.expect("validated"))?;
            click_once()?;
        }
        "double_click" => {
            move_pointer(params.x.expect("validated"), params.y.expect("validated"))?;
            click_once()?;
            click_once()?;
        }
        "drag" => {
            move_pointer(params.x.expect("validated"), params.y.expect("validated"))?;
            send_mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)?;
            move_pointer(params.to_x.expect("validated"), params.to_y.expect("validated"))?;
            send_mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)?;
        }
        "scroll" => {
            move_pointer(params.x.expect("validated"), params.y.expect("validated"))?;
            if let Some(delta_y) = params.delta_y.filter(|value| *value != 0) {
                send_mouse(MOUSEEVENTF_WHEEL, 0, 0, (-delta_y) as u32)?;
            }
            if let Some(delta_x) = params.delta_x.filter(|value| *value != 0) {
                send_mouse(MOUSEEVENTF_HWHEEL, 0, 0, delta_x as u32)?;
            }
        }
        "type_text" => type_text(params.text.as_deref().expect("validated"))?,
        "key_press" => press_key(params.key.as_deref().expect("validated"))?,
        "hotkey" => hotkey(params.keys.as_deref().expect("validated"))?,
        _ => unreachable!("validated"),
    }

    Ok(json!({
        "operation": params.operation,
        "foreground_window": foreground,
        "postcondition": {
            "dispatched": true,
            "foreground": params.expected_window_id.is_some()
        }
    }))
}

fn virtual_desktop() -> Result<Rect, String> {
    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return Err("Windows virtual desktop has invalid dimensions".into());
    }
    Ok(Rect { left: x, top: y, right: x.saturating_add(width), bottom: y.saturating_add(height) })
}

fn window_rect(hwnd: isize) -> Result<Rect, String> {
    let mut rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(format!("GetWindowRect failed: {}", io::Error::last_os_error()));
    }
    rect_width(rect)?;
    rect_height(rect)?;
    Ok(rect)
}

fn rect_from_region(region: Region) -> Result<Rect, String> {
    if region.width == 0 || region.height == 0 || region.width > 16_384 || region.height > 16_384 {
        return Err("region width/height must be 1-16384".into());
    }
    let right = i64::from(region.x) + i64::from(region.width);
    let bottom = i64::from(region.y) + i64::from(region.height);
    if right > i64::from(i32::MAX) || bottom > i64::from(i32::MAX) {
        return Err("region coordinates overflow the Windows desktop coordinate range".into());
    }
    Ok(Rect { left: region.x, top: region.y, right: right as i32, bottom: bottom as i32 })
}

fn assert_inside(rect: Rect, outer: Rect) -> Result<(), String> {
    if rect.left < outer.left || rect.top < outer.top || rect.right > outer.right || rect.bottom > outer.bottom {
        return Err("capture rectangle must remain fully inside the current virtual desktop".into());
    }
    Ok(())
}

fn rect_width(rect: Rect) -> Result<u32, String> {
    let value = i64::from(rect.right) - i64::from(rect.left);
    if value <= 0 || value > i64::from(u32::MAX) {
        return Err("capture rectangle width is invalid".into());
    }
    Ok(value as u32)
}

fn rect_height(rect: Rect) -> Result<u32, String> {
    let value = i64::from(rect.bottom) - i64::from(rect.top);
    if value <= 0 || value > i64::from(u32::MAX) {
        return Err("capture rectangle height is invalid".into());
    }
    Ok(value as u32)
}

fn fit_dimensions(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    if width <= max_width && height <= max_height {
        return (width, height);
    }
    let width_scale = f64::from(max_width) / f64::from(width);
    let height_scale = f64::from(max_height) / f64::from(height);
    let scale = width_scale.min(height_scale);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn capture_rgb(rect: Rect, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let screen_dc = unsafe { GetDC(0) };
    if screen_dc == 0 {
        return Err(format!("GetDC failed: {}", io::Error::last_os_error()));
    }
    let memory_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if memory_dc == 0 {
        unsafe { ReleaseDC(0, screen_dc) };
        return Err(format!("CreateCompatibleDC failed: {}", io::Error::last_os_error()));
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width as i32, height as i32) };
    if bitmap == 0 {
        unsafe {
            DeleteDC(memory_dc);
            ReleaseDC(0, screen_dc);
        }
        return Err(format!("CreateCompatibleBitmap failed: {}", io::Error::last_os_error()));
    }
    let previous = unsafe { SelectObject(memory_dc, bitmap) };
    if previous == 0 || previous == -1 {
        unsafe {
            DeleteObject(bitmap);
            DeleteDC(memory_dc);
            ReleaseDC(0, screen_dc);
        }
        return Err("SelectObject failed for capture bitmap".into());
    }

    unsafe { SetStretchBltMode(memory_dc, COLORONCOLOR) };
    let copied = unsafe {
        StretchBlt(
            memory_dc,
            0,
            0,
            width as i32,
            height as i32,
            screen_dc,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SRCCOPY,
        )
    };

    let stride = (usize::try_from(width).map_err(|_| "capture width overflow")? * 3).div_ceil(4) * 4;
    let mut bgr = vec![0u8; stride * usize::try_from(height).map_err(|_| "capture height overflow")?];
    let mut info = BitmapInfo {
        header: BitmapInfoHeader {
            size: size_of::<BitmapInfoHeader>() as u32,
            width: width as i32,
            height: -(height as i32),
            planes: 1,
            bit_count: 24,
            compression: BI_RGB,
            size_image: 0,
            x_pels_per_meter: 0,
            y_pels_per_meter: 0,
            clr_used: 0,
            clr_important: 0,
        },
        colors: [RgbQuad { blue: 0, green: 0, red: 0, reserved: 0 }],
    };
    let read_lines = if copied != 0 {
        unsafe {
            GetDIBits(
                memory_dc,
                bitmap,
                0,
                height,
                bgr.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        }
    } else {
        0
    };

    unsafe {
        SelectObject(memory_dc, previous);
        DeleteObject(bitmap);
        DeleteDC(memory_dc);
        ReleaseDC(0, screen_dc);
    }

    if copied == 0 {
        return Err(format!("StretchBlt failed: {}", io::Error::last_os_error()));
    }
    if read_lines != height as i32 {
        return Err(format!("GetDIBits returned {read_lines} lines; expected {height}"));
    }

    let pixel_count = usize::try_from(width).map_err(|_| "capture width overflow")?
        .checked_mul(usize::try_from(height).map_err(|_| "capture height overflow")?)
        .ok_or("capture pixel count overflow")?;
    let mut rgb = Vec::with_capacity(pixel_count.checked_mul(3).ok_or("capture byte count overflow")?);
    let row_bytes = usize::try_from(width).map_err(|_| "capture width overflow")? * 3;
    for row in bgr.chunks_exact(stride) {
        for offset in (0..row_bytes).step_by(3) {
            rgb.push(row[offset + 2]);
            rgb.push(row[offset + 1]);
            rgb.push(row[offset]);
        }
    }
    Ok(rgb)
}

fn encode_png(width: u32, height: u32, rgb: &[u8]) -> Result<Vec<u8>, String> {
    let row_bytes = usize::try_from(width).map_err(|_| "PNG width overflow")?
        .checked_mul(3)
        .ok_or("PNG row overflow")?;
    let expected = row_bytes
        .checked_mul(usize::try_from(height).map_err(|_| "PNG height overflow")?)
        .ok_or("PNG image overflow")?;
    if rgb.len() != expected {
        return Err("RGB buffer length does not match capture dimensions".into());
    }

    let mut scanlines = Vec::with_capacity(expected + usize::try_from(height).unwrap_or(0));
    for row in rgb.chunks_exact(row_bytes) {
        scanlines.push(0);
        scanlines.extend_from_slice(row);
    }
    let compressed = zlib_store(&scanlines);

    let mut png = Vec::with_capacity(compressed.len() + 128);
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    push_png_chunk(&mut png, b"IHDR", &ihdr);
    push_png_chunk(&mut png, b"IDAT", &compressed);
    push_png_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 65_535 * 5 + 16);
    out.extend_from_slice(&[0x78, 0x01]);
    let mut offset = 0usize;
    while offset < data.len() {
        let remaining = data.len() - offset;
        let block_len = remaining.min(65_535);
        let final_block = offset + block_len == data.len();
        out.push(if final_block { 0x01 } else { 0x00 });
        let len = block_len as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + block_len]);
        offset += block_len;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn push_png_chunk(target: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    target.extend_from_slice(&(data.len() as u32).to_be_bytes());
    target.extend_from_slice(kind);
    target.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    target.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65_521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in data {
        a = (a + u32::from(byte)) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        let combined = (u32::from(a) << 16) | (u32::from(b) << 8) | u32::from(c);
        out.push(TABLE[((combined >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((combined >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((combined >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(combined & 0x3f) as usize] as char } else { '=' });
    }
    out
}

fn require_xy(x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    if x.is_none() || y.is_none() {
        return Err("pointer operation requires x and y".into());
    }
    Ok(())
}

fn require_window(params: &InputParams) -> Result<(), String> {
    if params.expected_window_id.as_deref().is_none_or(str::is_empty) {
        return Err("keyboard input requires a capture-leased window".into());
    }
    Ok(())
}

fn reject_pointer_payload(params: &InputParams) -> Result<(), String> {
    if params.x.is_some() || params.y.is_some() || params.to_x.is_some() || params.to_y.is_some()
        || params.delta_x.is_some() || params.delta_y.is_some()
    {
        return Err("keyboard input does not accept pointer fields".into());
    }
    Ok(())
}

fn reject_non_pointer_payload(params: &InputParams, allow_drag: bool) -> Result<(), String> {
    if params.text.is_some() || params.key.is_some() || params.keys.is_some()
        || params.delta_x.is_some() || params.delta_y.is_some()
        || (!allow_drag && (params.to_x.is_some() || params.to_y.is_some()))
    {
        return Err("pointer operation contains unsupported fields".into());
    }
    Ok(())
}

fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    let desktop = virtual_desktop()?;
    if x < desktop.left || x >= desktop.right || y < desktop.top || y >= desktop.bottom {
        return Err("pointer coordinates are outside the current virtual desktop".into());
    }
    let width = i64::from(desktop.right - desktop.left).max(2);
    let height = i64::from(desktop.bottom - desktop.top).max(2);
    let dx = (((i64::from(x - desktop.left)) * 65_535) / (width - 1)) as i32;
    let dy = (((i64::from(y - desktop.top)) * 65_535) / (height - 1)) as i32;
    send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy, 0)
}

fn click_once() -> Result<(), String> {
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)?;
    send_mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)
}

fn send_mouse(flags: u32, dx: i32, dy: i32, data: u32) -> Result<(), String> {
    let input = Input {
        kind: INPUT_MOUSE,
        value: InputUnion {
            mouse: MouseInput { dx, dy, mouse_data: data, flags, time: 0, extra_info: 0 },
        },
    };
    send_inputs(&[input])
}

fn type_text(text: &str) -> Result<(), String> {
    let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    send_inputs(&inputs)
}

fn press_key(name: &str) -> Result<(), String> {
    let key = virtual_key(name)?;
    send_inputs(&[keyboard_input(key, 0, 0), keyboard_input(key, 0, KEYEVENTF_KEYUP)])
}

fn hotkey(keys: &[String]) -> Result<(), String> {
    let mapped = keys.iter().map(|key| virtual_key(key)).collect::<Result<Vec<_>, _>>()?;
    let mut inputs = Vec::with_capacity(mapped.len() * 2);
    for &key in &mapped {
        inputs.push(keyboard_input(key, 0, 0));
    }
    for &key in mapped.iter().rev() {
        inputs.push(keyboard_input(key, 0, KEYEVENTF_KEYUP));
    }
    send_inputs(&inputs)
}

fn keyboard_input(virtual_key: u16, scan: u16, flags: u32) -> Input {
    Input {
        kind: INPUT_KEYBOARD,
        value: InputUnion {
            keyboard: KeyboardInput { virtual_key, scan, flags, time: 0, extra_info: 0 },
        },
    }
}

fn send_inputs(inputs: &[Input]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let count = u32::try_from(inputs.len()).map_err(|_| "input batch is too large")?;
    let sent = unsafe { SendInput(count, inputs.as_ptr(), size_of::<Input>() as i32) };
    if sent != count {
        return Err(format!("SendInput dispatched {sent} of {count} events: {}", io::Error::last_os_error()));
    }
    Ok(())
}

fn virtual_key(name: &str) -> Result<u16, String> {
    let upper = name.trim().to_ascii_uppercase();
    let value = match upper.as_str() {
        "ENTER" => 0x0D,
        "TAB" => 0x09,
        "ESC" | "ESCAPE" => 0x1B,
        "SPACE" => 0x20,
        "BACKSPACE" => 0x08,
        "DELETE" => 0x2E,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "LEFT" => 0x25,
        "UP" => 0x26,
        "RIGHT" => 0x27,
        "DOWN" => 0x28,
        "CTRL" | "CONTROL" => 0x11,
        "ALT" => 0x12,
        "SHIFT" => 0x10,
        "WIN" | "META" => 0x5B,
        "F1" => 0x70,
        "F2" => 0x71,
        "F3" => 0x72,
        "F4" => 0x73,
        "F5" => 0x74,
        "F6" => 0x75,
        "F7" => 0x76,
        "F8" => 0x77,
        "F9" => 0x78,
        "F10" => 0x79,
        "F11" => 0x7A,
        "F12" => 0x7B,
        _ if upper.len() == 1 => {
            let byte = upper.as_bytes()[0];
            if byte.is_ascii_alphanumeric() { u16::from(byte) } else { return Err("key must be an allowed named key or one ASCII letter/digit".into()); }
        }
        _ => return Err("key must be an allowed named key or one ASCII letter/digit".into()),
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{base64_encode, crc32, encode_png, fit_dimensions, virtual_key};

    #[test]
    fn image_resize_preserves_aspect_ratio_and_bounds() {
        assert_eq!(fit_dimensions(1920, 1080, 960, 540), (960, 540));
        assert_eq!(fit_dimensions(800, 600, 960, 540), (720, 540));
        assert_eq!(fit_dimensions(320, 200, 960, 540), (320, 200));
    }

    #[test]
    fn png_encoder_emits_valid_signature_and_chunks() {
        let png = encode_png(1, 1, &[255, 0, 0]).unwrap();
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert!(png.windows(4).any(|part| part == b"IHDR"));
        assert!(png.windows(4).any(|part| part == b"IDAT"));
        assert!(png.windows(4).any(|part| part == b"IEND"));
    }

    #[test]
    fn crc_and_base64_match_known_vectors() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn keyboard_surface_is_closed_and_named() {
        assert_eq!(virtual_key("Enter").unwrap(), 0x0D);
        assert_eq!(virtual_key("A").unwrap(), 0x41);
        assert!(virtual_key("VK_0x41").is_err());
    }
}
