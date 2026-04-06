/// Read .env at compile time and bake the values into the binary via
/// `cargo:rustc-env`. The source code then reads them with `option_env!()`.
fn main() {
    tauri_build::build();

    // Declare custom cfg flags so rustc doesn't warn about them.
    println!("cargo:rustc-check-cfg=cfg(has_nvenc)");
    println!("cargo:rustc-check-cfg=cfg(has_vaapi)");
    println!("cargo:rustc-check-cfg=cfg(has_videotoolbox)");

    // Tell Cargo to re-run this script if .env changes.
    println!("cargo:rerun-if-changed=.env");

    // Load .env into the process environment (silently ignored if missing).
    dotenvy::dotenv().ok();

    // Every var we want compiled in. If the var is set (in .env or the shell
    // environment), emit it so `option_env!("VAR")` returns `Some(value)`.
    // If unset, we emit nothing and `option_env!` returns `None`.
    let vars = [
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "LIVEKIT_URL",
        "GIPHY_API_KEY",
        "PAX_HOMESERVER",
        "PAX_REGISTRATION_TOKEN",
        "PAX_HIDE_SERVER_CONFIG",
    ];

    for var in vars {
        println!("cargo:rerun-if-env-changed={var}");
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                println!("cargo:rustc-env={var}={val}");
            }
        }
    }

    // ── Hardware encoder availability flags ─────────────────────────────
    //
    // These mirror the detection logic in webrtc-sys-local/build.rs so that
    // codec.rs can make honest fallback decisions at compile time.
    // The cfg flags emitted here are:
    //   has_nvenc         — NVIDIA NVENC (CUDA found at build time)
    //   has_vaapi         — VA-API (Linux x86 only)
    //   has_videotoolbox  — Apple VideoToolbox (macOS / iOS)

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    match target_os.as_str() {
        "windows" => {
            println!("cargo:rerun-if-env-changed=CUDA_PATH");
            let cuda_home =
                std::path::PathBuf::from(std::env::var("CUDA_PATH").unwrap_or_else(|_| {
                    r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2".into()
                }));
            if cuda_home.join("include").join("cuda.h").exists() {
                println!("cargo:rustc-cfg=has_nvenc");
                println!("cargo:warning=Pax: NVENC hardware encoding enabled");
            } else {
                println!("cargo:warning=Pax: CUDA not found — NVENC unavailable, non-NVIDIA GPUs will use VP9");
            }
        }
        "linux" => {
            let x86 = target_arch == "x86_64" || target_arch == "i686";
            let arm = target_arch == "aarch64" || target_arch.contains("arm");

            if x86 {
                // VA-API is always compiled on Linux x86 (libva is dlopened)
                println!("cargo:rustc-cfg=has_vaapi");
            }

            if x86 || arm {
                println!("cargo:rerun-if-env-changed=CUDA_HOME");
                let cuda_home = std::path::PathBuf::from(
                    std::env::var("CUDA_HOME").unwrap_or_else(|_| "/usr/local/cuda".into()),
                );
                if cuda_home.join("include").join("cuda.h").exists() {
                    println!("cargo:rustc-cfg=has_nvenc");
                }
            }
        }
        "macos" | "ios" => {
            println!("cargo:rustc-cfg=has_videotoolbox");
        }
        _ => {}
    }
}
