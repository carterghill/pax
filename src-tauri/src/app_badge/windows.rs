use std::{
    ptr::null_mut,
    sync::atomic::{AtomicU64, Ordering},
};

use tauri::{image::Image, WebviewWindow};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW,
            GdiFlush, SelectObject, SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH,
            DIB_RGB_COLORS, DT_CENTER, DT_SINGLELINE, DT_VCENTER, FW_NORMAL, HBITMAP, HDC, HFONT,
            OUT_DEFAULT_PRECIS, TRANSPARENT,
        },
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
    let icon = (count > 0).then(|| render(count)).transpose()?;
    window.set_overlay_icon(icon)
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

const SIZE: usize = 32;
const SUPERSAMPLE: usize = 4;
const TEXT_SIZE: usize = SIZE * SUPERSAMPLE;

fn render(count: u64) -> tauri::Result<Image<'static>> {
    let label = if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    };
    let font_size = match label.len() {
        1 => 18,
        2 => 17,
        _ => 14,
    };
    let mask = render_text(&label, font_size)?;
    let mut rgba = vec![0; SIZE * SIZE * 4];
    for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() {
        let x = index % SIZE;
        let y = index / SIZE;
        let mut coverage = 0u32;
        for dy in 0..SUPERSAMPLE {
            for dx in 0..SUPERSAMPLE {
                coverage +=
                    u32::from(mask[(y * SUPERSAMPLE + dy) * TEXT_SIZE + x * SUPERSAMPLE + dx]);
            }
        }
        let text = coverage as f32 / (SUPERSAMPLE * SUPERSAMPLE * 255) as f32;
        let dx = x as f32 + 0.5 - SIZE as f32 / 2.0;
        let dy = y as f32 + 0.5 - SIZE as f32 / 2.0;
        // A little transparent padding keeps the overlay from crowding the app icon.
        let alpha = (15.0 - dx.hypot(dy)).clamp(0.0, 1.0);
        pixel.copy_from_slice(&[
            (220.0 + 35.0 * text).round() as u8,
            (38.0 + 217.0 * text).round() as u8,
            (38.0 + 217.0 * text).round() as u8,
            (alpha * 255.0).round() as u8,
        ]);
    }
    Ok(Image::new_owned(rgba, SIZE as u32, SIZE as u32))
}

struct TextCanvas {
    dc: HDC,
    bitmap: HBITMAP,
    font: HFONT,
}

impl Drop for TextCanvas {
    fn drop(&mut self) {
        unsafe {
            // Deleting the private DC first deselects its bitmap and font.
            if !self.dc.is_null() {
                DeleteDC(self.dc);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.font.is_null() {
                DeleteObject(self.font);
            }
        }
    }
}

fn render_text(label: &str, font_size: i32) -> tauri::Result<Vec<u8>> {
    let error = || std::io::Error::other("Could not render Windows notification badge");
    // Render a grayscale mask at 4x size so tiny text stays smooth without ClearType fringes.
    unsafe {
        let mut canvas = TextCanvas {
            dc: CreateCompatibleDC(null_mut()),
            bitmap: null_mut(),
            font: null_mut(),
        };
        if canvas.dc.is_null() {
            return Err(error().into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: TEXT_SIZE as i32,
                biHeight: -(TEXT_SIZE as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            },
            ..std::mem::zeroed()
        };
        let mut bits = null_mut();
        canvas.bitmap =
            CreateDIBSection(canvas.dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        canvas.font = CreateFontW(
            -(font_size * SUPERSAMPLE as i32),
            0,
            0,
            0,
            FW_NORMAL as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            ANTIALIASED_QUALITY as u32,
            DEFAULT_PITCH as u32,
            w!("Segoe UI"),
        );
        if canvas.bitmap.is_null() || bits.is_null() || canvas.font.is_null() {
            return Err(error().into());
        }
        if SelectObject(canvas.dc, canvas.bitmap).is_null()
            || SelectObject(canvas.dc, canvas.font).is_null()
        {
            return Err(error().into());
        }
        std::ptr::write_bytes(bits.cast::<u8>(), 0, TEXT_SIZE * TEXT_SIZE * 4);
        SetBkMode(canvas.dc, TRANSPARENT as i32);
        SetTextColor(canvas.dc, 0x00ff_ffff);
        let text: Vec<u16> = label.encode_utf16().collect();
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: TEXT_SIZE as i32,
            bottom: TEXT_SIZE as i32,
        };
        if DrawTextW(
            canvas.dc,
            text.as_ptr(),
            text.len() as i32,
            &mut rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        ) == 0
            || GdiFlush() == 0
        {
            return Err(error().into());
        }
        let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), TEXT_SIZE * TEXT_SIZE * 4);
        let (mut left, mut top, mut right, mut bottom) = (TEXT_SIZE, TEXT_SIZE, 0, 0);
        for (index, pixel) in pixels.chunks_exact(4).enumerate() {
            if pixel[0] > 0 {
                left = left.min(index % TEXT_SIZE);
                top = top.min(index / TEXT_SIZE);
                right = right.max(index % TEXT_SIZE);
                bottom = bottom.max(index / TEXT_SIZE);
            }
        }
        if left > right || top > bottom {
            return Err(error().into());
        }
        // Center the visible glyphs, rather than the font's ascent and side bearings.
        let offset_x = (TEXT_SIZE - (right - left + 1)) / 2;
        let offset_y = (TEXT_SIZE - (bottom - top + 1)) / 2;
        let mut mask = vec![0; TEXT_SIZE * TEXT_SIZE];
        for y in top..=bottom {
            for x in left..=right {
                mask[(offset_y + y - top) * TEXT_SIZE + offset_x + x - left] =
                    pixels[(y * TEXT_SIZE + x) * 4];
            }
        }
        Ok(mask)
    }
}
