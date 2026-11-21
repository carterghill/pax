use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{image::Image, WebviewWindow};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{RegisterWindowMessageW, WM_NCDESTROY},
        },
    },
};

static COUNT: AtomicU64 = AtomicU64::new(0);

pub(super) fn set(window: &WebviewWindow, count: u64) -> tauri::Result<()> {
    COUNT.store(count, Ordering::Relaxed);
    display(window, count)
}

fn display(window: &WebviewWindow, count: u64) -> tauri::Result<()> {
    window.set_overlay_icon((count > 0).then(|| render(count)))
}

pub(crate) fn initialize(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    // Explorer sends this again after a taskbar button is recreated.
    let message = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
    if message == 0 {
        return;
    }
    let context = Box::into_raw(Box::new(window.clone()));
    if unsafe {
        SetWindowSubclass(
            hwnd.0,
            Some(taskbar_message),
            message as usize,
            context as usize,
        )
    } == 0
    {
        unsafe { drop(Box::from_raw(context)) };
        log::warn!("[badge] could not watch for taskbar recreation");
    }
}

unsafe extern "system" fn taskbar_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    button_created: usize,
    context: usize,
) -> LRESULT {
    if message as usize == button_created {
        let window = &*(context as *const WebviewWindow);
        let _ = display(window, COUNT.load(Ordering::Relaxed));
    } else if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(taskbar_message), button_created);
        drop(Box::from_raw(context as *mut WebviewWindow));
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn render(count: u64) -> Image<'static> {
    const SIZE: usize = 32;
    const GLYPHS: [[u8; 5]; 11] = [
        [0b111, 0b101, 0b101, 0b101, 0b111],
        [0b010, 0b110, 0b010, 0b010, 0b111],
        [0b111, 0b001, 0b111, 0b100, 0b111],
        [0b111, 0b001, 0b111, 0b001, 0b111],
        [0b101, 0b101, 0b111, 0b001, 0b001],
        [0b111, 0b100, 0b111, 0b001, 0b111],
        [0b111, 0b100, 0b111, 0b101, 0b111],
        [0b111, 0b001, 0b010, 0b010, 0b010],
        [0b111, 0b101, 0b111, 0b101, 0b111],
        [0b111, 0b101, 0b111, 0b001, 0b111],
        [0b000, 0b010, 0b111, 0b010, 0b000],
    ];
    let mut rgba = vec![0; SIZE * SIZE * 4];
    let radius = SIZE as f32 / 2.0;
    for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() {
        let x = (index % SIZE) as f32 + 0.5 - radius;
        let y = (index / SIZE) as f32 + 0.5 - radius;
        let alpha = (radius - x.hypot(y)).clamp(0.0, 1.0);
        pixel.copy_from_slice(&[220, 38, 38, (alpha * 255.0).round() as u8]);
    }

    let label = if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    };
    let scale = 5 - label.len();
    let left = (SIZE - (label.len() * 4 - 1) * scale) / 2;
    let top = (SIZE - 5 * scale) / 2;
    for (digit, character) in label.bytes().enumerate() {
        let glyph = if character == b'+' {
            10
        } else {
            usize::from(character - b'0')
        };
        for (row, bits) in GLYPHS[glyph].iter().enumerate() {
            for column in 0..3 {
                if bits & (0b100 >> column) == 0 {
                    continue;
                }
                let x = left + (digit * 4 + column) * scale;
                let y = top + row * scale;
                for dy in 0..scale {
                    let start = ((y + dy) * SIZE + x) * 4;
                    rgba[start..start + scale * 4].fill(255);
                }
            }
        }
    }
    Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}
