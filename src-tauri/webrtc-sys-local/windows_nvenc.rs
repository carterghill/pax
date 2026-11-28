use std::{env, path::PathBuf};

/// Release packaging passes "off" or the absolute directory containing cuda.h.
/// Ordinary Cargo/Tauri builds keep auto-detecting the installed toolkit.
pub fn include_dir() -> Option<PathBuf> {
    println!("cargo:rerun-if-env-changed=PAX_WINDOWS_NVENC_INCLUDE");
    println!("cargo:rerun-if-env-changed=CUDA_PATH");
    let include = match env::var_os("PAX_WINDOWS_NVENC_INCLUDE") {
        Some(value) if value == "off" => return None,
        Some(value) => PathBuf::from(value),
        None => {
            let root = env::var_os("CUDA_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2"));
            let include = root.join("include");
            if !include.join("cuda.h").is_file() {
                return None;
            }
            include
        }
    };
    let header = include.join("cuda.h");
    assert!(header.is_file(), "Missing NVIDIA CUDA driver header: {}", header.display());
    println!("cargo:rerun-if-changed={}", header.display());
    Some(include)
}
