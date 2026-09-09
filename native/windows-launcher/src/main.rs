use std::env;
use std::path::Path;
use std::process::{Command, Stdio};

fn main() {
    if let Err(message) = run() {
        eprintln!("[operator-launcher] {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let exe = env::current_exe().map_err(|e| format!("cannot resolve launcher path: {e}"))?;
    let root = exe.parent().ok_or_else(|| "launcher has no parent directory".to_string())?.to_path_buf();
    let node = root.join("runtime").join("node.exe");
    let entry = root.join("app").join("apps").join("local-agent").join("src").join("main.ts");
    let uia = root.join("native").join("operator-windows-uia.exe");

    require_file(&node, "bundled Node runtime")?;
    require_file(&entry, "Operator local-agent entrypoint")?;
    require_file(&uia, "Operator Windows UIA sidecar")?;

    if env::var_os("OPERATOR_WINDOWS_UIA_PATH").is_none() {
        env::set_var("OPERATOR_WINDOWS_UIA_PATH", &uia);
    }

    let mut command = Command::new(&node);
    command
        .arg("--experimental-strip-types")
        .arg(&entry)
        .args(env::args_os().skip(1))
        .current_dir(root.join("app"))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let status = command.status().map_err(|e| format!("failed to start bundled Node runtime: {e}"))?;
    match status.code() {
        Some(code) => std::process::exit(code),
        None => Err("Operator local agent terminated without an exit code".to_string()),
    }
}

fn require_file(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{label} is missing at {}", path.display()));
    }
    Ok(())
}
