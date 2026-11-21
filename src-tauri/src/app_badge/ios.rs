use std::{
    ffi::{c_char, CStr},
    sync::{Mutex, OnceLock},
};

use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static TOKEN: Mutex<Option<String>> = Mutex::new(None);

extern "C" {
    fn pax_ios_set_badge_count(count: i32);
    fn pax_ios_enable_badge_push();
}

pub(super) fn set(count: u64) {
    unsafe { pax_ios_set_badge_count(i32::try_from(count).unwrap_or(i32::MAX)) };
}

pub(crate) fn push_token(app: AppHandle) -> Option<String> {
    if APP.set(app).is_ok() {
        unsafe { pax_ios_enable_badge_push() };
    }
    TOKEN.lock().ok()?.clone()
}

#[no_mangle]
extern "C" fn pax_ios_badge_token(token: *const c_char) {
    if token.is_null() {
        return;
    }
    let Ok(token) = (unsafe { CStr::from_ptr(token) }).to_str() else {
        return;
    };
    if let Ok(mut latest) = TOKEN.lock() {
        *latest = Some(token.to_owned());
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("badge-token-changed", ());
    }
}
