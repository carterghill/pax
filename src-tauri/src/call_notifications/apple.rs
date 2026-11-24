use std::{
    ffi::{c_char, CStr, CString},
    sync::OnceLock,
};

use tauri::AppHandle;

use super::{report_action, Action, IncomingCall};

static APP: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "ios")]
static VOIP_TOKEN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

extern "C" {
    fn pax_apple_call_show(id: *const c_char, caller: *const c_char, remaining: u64, video: bool);
    fn pax_apple_call_close(id: *const c_char);
    #[cfg(target_os = "macos")]
    fn pax_macos_call_enable();
    #[cfg(target_os = "ios")]
    fn pax_apple_call_update(id: *const c_char, active: bool);
    #[cfg(target_os = "ios")]
    fn pax_ios_voip_enable();
    #[cfg(target_os = "ios")]
    fn pax_ios_set_busy(busy: bool);
    #[cfg(target_os = "ios")]
    fn pax_ios_close_ringing_call(id: *const c_char);
}

#[cfg(target_os = "macos")]
pub(crate) fn initialize_macos(app: &AppHandle) {
    let _ = APP.set(app.clone());
    unsafe { pax_macos_call_enable() };
}

#[cfg(target_os = "ios")]
pub(crate) fn initialize_ios(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if crate::commands::push::push_gateway_url().is_some() {
        unsafe { pax_ios_voip_enable() };
    }
}

#[cfg(target_os = "ios")]
pub(crate) fn ios_voip_token() -> Option<String> {
    VOIP_TOKEN.lock().ok()?.clone()
}

#[cfg(target_os = "ios")]
pub(super) fn set_busy(busy: bool) {
    unsafe { pax_ios_set_busy(busy) };
}

#[cfg(target_os = "ios")]
pub(crate) fn close_ios_ringing_call(id: &str) {
    if let Ok(id) = CString::new(id) {
        unsafe { pax_ios_close_ringing_call(id.as_ptr()) };
    }
}

#[cfg(target_os = "ios")]
#[no_mangle]
extern "C" fn pax_ios_voip_token(token: *const c_char) {
    let token = (!token.is_null()).then(|| {
        unsafe { CStr::from_ptr(token) }
            .to_string_lossy()
            .into_owned()
    });
    if let Ok(mut latest) = VOIP_TOKEN.lock() {
        *latest = token;
    }
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit("voip-token-changed", ());
    }
}

#[no_mangle]
extern "C" fn pax_apple_call_action(id: *const c_char, action: u32) {
    let Some(app) = APP.get() else { return };
    let Ok(id) = (unsafe { CStr::from_ptr(id) }).to_str() else {
        return;
    };
    let Ok(id) = uuid::Uuid::parse_str(id) else {
        return;
    };
    let action = match action {
        1 => Action::Answer,
        2 => Action::Decline,
        3 => Action::Open,
        #[cfg(target_os = "ios")]
        4 => Action::End,
        _ => return,
    };
    report_action(app, id, action);
}

pub(super) struct Notification(CString);

impl Notification {
    pub(super) async fn show(
        app: &AppHandle,
        call: &IncomingCall,
        remaining: u64,
    ) -> Result<Self, String> {
        let _ = APP.set(app.clone());
        let id = CString::new(call.call_id.to_string()).map_err(|error| error.to_string())?;
        let caller =
            CString::new(call.caller.replace('\0', "")).map_err(|error| error.to_string())?;
        unsafe { pax_apple_call_show(id.as_ptr(), caller.as_ptr(), remaining, call.video) };
        Ok(Self(id))
    }

    pub(super) async fn close(self) {
        unsafe { pax_apple_call_close(self.0.as_ptr()) };
    }

    #[cfg(target_os = "ios")]
    pub(super) fn update(&self, phase: super::CallPhase) {
        if phase != super::CallPhase::Incoming {
            unsafe { pax_apple_call_update(self.0.as_ptr(), phase == super::CallPhase::Active) };
        }
    }
}
