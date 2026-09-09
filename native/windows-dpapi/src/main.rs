use std::env;
use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::ptr::{null, null_mut};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[link(name = "Crypt32")]
unsafe extern "system" {
    #[link_name = "CryptProtectData"]
    fn crypt_protect_data(
        data_in: *const DataBlob,
        data_descr: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;

    #[link_name = "CryptUnprotectData"]
    fn crypt_unprotect_data(
        data_in: *const DataBlob,
        data_descr: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "Kernel32")]
unsafe extern "system" {
    #[link_name = "LocalFree"]
    fn local_free(memory: *mut c_void) -> *mut c_void;

    #[link_name = "GetLastError"]
    fn get_last_error() -> u32;
}

fn main() {
    if let Err(message) = run() {
        eprintln!("[operator-dpapi] {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.as_slice() == ["--self-test"] {
        return self_test();
    }
    if args.len() != 1 || !matches!(args[0].as_str(), "protect" | "unprotect") {
        return Err("usage: operator-windows-dpapi <protect|unprotect|--self-test>".to_string());
    }

    let mut input = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    if input.is_empty() {
        return Err("secret input must not be empty".to_string());
    }
    if input.len() > MAX_INPUT_BYTES {
        input.fill(0);
        return Err(format!("secret input exceeds {MAX_INPUT_BYTES} bytes"));
    }

    let mut output = if args[0] == "protect" {
        protect(input)?
    } else {
        unprotect(input)?
    };
    let write_result = io::stdout().write_all(&output);
    output.fill(0);
    write_result.map_err(|error| format!("failed to write stdout: {error}"))
}

fn protect(input: Vec<u8>) -> Result<Vec<u8>, String> {
    dpapi(input, true)
}

fn unprotect(input: Vec<u8>) -> Result<Vec<u8>, String> {
    dpapi(input, false)
}

fn dpapi(mut input: Vec<u8>, encrypt: bool) -> Result<Vec<u8>, String> {
    let input_len = u32::try_from(input.len()).map_err(|_| "secret input is too large".to_string())?;
    let input_blob = DataBlob {
        cb_data: input_len,
        pb_data: input.as_mut_ptr(),
    };
    let mut output_blob = DataBlob {
        cb_data: 0,
        pb_data: null_mut(),
    };

    let ok = unsafe {
        if encrypt {
            crypt_protect_data(
                &input_blob,
                null(),
                null(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output_blob,
            )
        } else {
            crypt_unprotect_data(
                &input_blob,
                null_mut(),
                null(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output_blob,
            )
        }
    };
    input.fill(0);

    if ok == 0 {
        let code = unsafe { get_last_error() };
        return Err(format!("DPAPI operation failed with Windows error {code}"));
    }
    if output_blob.cb_data == 0 || output_blob.pb_data.is_null() {
        if !output_blob.pb_data.is_null() {
            unsafe {
                local_free(output_blob.pb_data.cast());
            }
        }
        return Err("DPAPI returned an empty output blob".to_string());
    }

    let output = unsafe {
        std::slice::from_raw_parts(output_blob.pb_data, output_blob.cb_data as usize).to_vec()
    };
    unsafe {
        std::ptr::write_bytes(output_blob.pb_data, 0, output_blob.cb_data as usize);
        local_free(output_blob.pb_data.cast());
    }
    Ok(output)
}

fn self_test() -> Result<(), String> {
    let plaintext = b"operator-dpapi-self-test-v1".to_vec();
    let protected = protect(plaintext.clone())?;
    if protected == plaintext {
        return Err("DPAPI self-test returned plaintext bytes".to_string());
    }
    let mut roundtrip = unprotect(protected)?;
    let valid = roundtrip == plaintext;
    roundtrip.fill(0);
    if !valid {
        return Err("DPAPI self-test round trip mismatch".to_string());
    }
    println!("operator-dpapi-self-test:ok");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_user_dpapi_round_trip() {
        let plaintext = b"operator-native-dpapi-test".to_vec();
        let protected = protect(plaintext.clone()).expect("protect");
        assert_ne!(protected, plaintext);
        let mut restored = unprotect(protected).expect("unprotect");
        assert_eq!(restored, plaintext);
        restored.fill(0);
    }
}
