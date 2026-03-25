/// Read .env at compile time and bake the values into the binary via
/// `cargo:rustc-env`. The source code then reads them with `option_env!()`.
fn main() {
    tauri_build::build();

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
}