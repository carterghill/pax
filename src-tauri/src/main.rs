// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Detect the display server and set any required environment variables
    // (e.g. WEBKIT_DISABLE_DMABUF_RENDERER on Wayland) *before* GTK/WebKit
    // are initialised by Tauri.
    pax_lib::platform::apply_env_overrides();

    pax_lib::run()
}
