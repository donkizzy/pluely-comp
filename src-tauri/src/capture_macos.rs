//! macOS screen capture via ScreenCaptureKit.
//!
//! The legacy `xcap` / `CGWindowListCreateImage` path silently returns empty
//! (black / wallpaper-only) frames when Screen Recording (TCC) access is missing.
//! ScreenCaptureKit instead fails loudly, which lets us surface a clear
//! permission error to the user.

use cidre::{arc, cg, ns, sc};
use image::RgbaImage;
use std::future::Future;

/// Error text used whenever a capture fails because Screen Recording access is
/// missing. The frontend matches on "Screen Recording permission".
pub const PERMISSION_ERROR: &str = "Screen Recording permission denied. Enable it in System Settings > Privacy & Security > Screen & System Audio Recording (when running `tauri dev`, enable the app that launched it, e.g. Cursor, Terminal or iTerm), then restart.";

/// SCStreamErrorUserDeclined
const SC_ERROR_USER_DECLINED: ns::Integer = -3801;

/// A single captured display.
pub struct CapturedDisplay {
    /// Display frame in global points (top-left origin): x, y, width, height.
    pub frame: (f64, f64, f64, f64),
    /// Captured pixels at native (physical) resolution.
    pub image: RgbaImage,
}

/// Runs a non-`Send` future to completion on a fresh current-thread Tokio
/// runtime. Call this from inside `spawn_blocking` so the caller's future
/// stays `Send` (required by Tauri async commands).
pub fn block_on_local<F: Future>(future: F) -> Result<F::Output, String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Failed to start capture runtime: {}", e))?;
    Ok(rt.block_on(future))
}

/// Ask macOS for Screen Recording access. `CGPreflightScreenCaptureAccess` can
/// false-negative (notably under `tauri dev`, where TCC attributes access to
/// the launching terminal/editor), so this never blocks capture on its own.
fn request_access() {
    if !cg::screen_capture_access::preflight() {
        let granted = cg::screen_capture_access::request();
        eprintln!(
            "[ScreenRecording] preflight=false, request returned {}; attempting capture anyway",
            granted
        );
    }
}

fn map_sc_error(context: &str, err: &ns::Error) -> String {
    let code = err.code();
    if code == SC_ERROR_USER_DECLINED || !cg::screen_capture_access::preflight() {
        eprintln!(
            "[ScreenRecording] {} failed (code {}): {}",
            context,
            code,
            err.localized_desc()
        );
        return PERMISSION_ERROR.to_string();
    }
    format!("{} failed ({}): {}", context, code, err.localized_desc())
}

/// Returns true when a frame is (almost) entirely black / transparent, which
/// is what macOS hands back when capture access is silently denied.
pub fn is_blank_capture(image: &RgbaImage) -> bool {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return true;
    }
    let raw = image.as_raw();
    let pixels = raw.len() / 4;
    // Sample up to ~10k pixels spread across the frame.
    let step = (pixels / 10_000).max(1);
    let mut idx = 0usize;
    while idx < pixels {
        let p = &raw[idx * 4..idx * 4 + 4];
        if p[3] > 0 && (p[0] > 8 || p[1] > 8 || p[2] > 8) {
            return false;
        }
        idx += step;
    }
    true
}

fn cg_image_to_rgba(image: &cg::Image) -> Result<RgbaImage, String> {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Err("Captured image is empty".to_string());
    }
    let bytes_per_row = width * 4;
    let mut buf = vec![0u8; bytes_per_row * height];
    let space = cg::ColorSpace::device_rgb().ok_or("Failed to create RGB color space")?;
    let mut ctx = cg::Context::new_bitmap(
        buf.as_mut_ptr().cast(),
        width,
        height,
        8,
        bytes_per_row,
        &space,
        cg::BitmapInfo::with_alpha(cg::ImageAlphaInfo::PremultipliedLast),
    )
    .ok_or("Failed to create bitmap context")?;
    ctx.draw_image(
        cg::Rect {
            origin: cg::Point { x: 0.0, y: 0.0 },
            size: cg::Size {
                width: width as f64,
                height: height as f64,
            },
        },
        image,
    );
    drop(ctx);
    RgbaImage::from_raw(width as u32, height as u32, buf)
        .ok_or_else(|| "Failed to build RGBA image".to_string())
}

async fn capture_display(display: &sc::Display) -> Result<CapturedDisplay, String> {
    let empty = ns::Array::<sc::Window>::new();
    let filter = sc::ContentFilter::with_display_excluding_windows(display, &empty);
    let scale = sc::ShareableContent::info_for_filter(&filter).point_pixel_scale() as f64;
    let scale = if scale > 0.0 { scale } else { 1.0 };

    let frame = display.frame();
    let mut cfg = sc::StreamCfg::new();
    cfg.set_width((frame.size.width * scale).round() as usize);
    cfg.set_height((frame.size.height * scale).round() as usize);
    cfg.set_shows_cursor(false);

    let cg_image: arc::R<cg::Image> = sc::ScreenshotManager::capture_image(&filter, &cfg)
        .await
        .map_err(|e| map_sc_error("Screen capture", &e))?;
    let image = cg_image_to_rgba(&cg_image)?;

    if is_blank_capture(&image) {
        return Err(PERMISSION_ERROR.to_string());
    }

    Ok(CapturedDisplay {
        frame: (
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height,
        ),
        image,
    })
}

async fn shareable_displays() -> Result<arc::R<ns::Array<sc::Display>>, String> {
    let content = sc::ShareableContent::current()
        .await
        .map_err(|e| map_sc_error("Listing displays", &e))?;
    let displays = content.displays();
    if displays.is_empty() {
        return Err("No displays found".to_string());
    }
    Ok(displays)
}

/// Captures every display. Used by the selection-mode overlay.
/// Must be called off the async runtime (e.g. inside `spawn_blocking`).
pub fn capture_all_displays() -> Result<Vec<CapturedDisplay>, String> {
    request_access();
    block_on_local(async {
        let displays = shareable_displays().await?;
        let mut out = Vec::with_capacity(displays.len());
        for display in displays.iter() {
            out.push(capture_display(display).await?);
        }
        Ok(out)
    })?
}

/// Captures the display that best overlaps `window_rect` (global points:
/// x, y, width, height) and returns it as PNG bytes. Falls back to the closest
/// display, or the first one when no rect is given.
/// Must be called off the async runtime (e.g. inside `spawn_blocking`).
pub fn capture_best_display_png(
    window_rect: Option<(f64, f64, f64, f64)>,
) -> Result<Vec<u8>, String> {
    request_access();
    let captured = block_on_local(async {
        let displays = shareable_displays().await?;
        let mut best: Option<usize> = None;

        if let Some((wx, wy, ww, wh)) = window_rect {
            let mut best_area = 0.0f64;
            let mut closest = f64::MAX;
            let (cx, cy) = (wx + ww / 2.0, wy + wh / 2.0);
            let mut closest_idx = 0usize;

            for (idx, display) in displays.iter().enumerate() {
                let f = display.frame();
                let (dx, dy, dw, dh) = (f.origin.x, f.origin.y, f.size.width, f.size.height);
                let ow = ((wx + ww).min(dx + dw) - wx.max(dx)).max(0.0);
                let oh = ((wy + wh).min(dy + dh) - wy.max(dy)).max(0.0);
                let area = ow * oh;
                if area > best_area {
                    best_area = area;
                    best = Some(idx);
                }
                let (ex, ey) = (cx - (dx + dw / 2.0), cy - (dy + dh / 2.0));
                let dist = ex * ex + ey * ey;
                if dist < closest {
                    closest = dist;
                    closest_idx = idx;
                }
            }
            if best.is_none() {
                best = Some(closest_idx);
            }
        }

        let idx = best.unwrap_or(0);
        let display = displays
            .iter()
            .nth(idx)
            .ok_or_else(|| "Failed to determine target display".to_string())?;
        capture_display(display).await
    })??;

    let mut png = Vec::new();
    {
        use image::codecs::png::PngEncoder;
        use image::{ColorType, ImageEncoder};
        PngEncoder::new(&mut png)
            .write_image(
                captured.image.as_raw(),
                captured.image.width(),
                captured.image.height(),
                ColorType::Rgba8.into(),
            )
            .map_err(|e| format!("Failed to encode to PNG: {}", e))?;
    }
    Ok(png)
}
