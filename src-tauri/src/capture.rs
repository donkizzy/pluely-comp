use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{ColorType, GenericImageView, ImageEncoder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::{thread, time::Duration};
use tauri::Emitter;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use xcap::Monitor;

#[cfg(target_os = "macos")]
#[path = "capture_macos.rs"]
mod capture_macos;

#[derive(Debug, Serialize, Deserialize)]
pub struct SelectionCoords {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub image: image::RgbaImage,
}

// Store captured images from all monitors temporarily for cropping
pub struct CaptureState {
    pub captured_monitors: Arc<Mutex<HashMap<usize, MonitorInfo>>>,
    pub overlay_active: Arc<AtomicBool>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            captured_monitors: Arc::default(),
            overlay_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// One overlay to show: the captured pixels plus where to place the window.
struct OverlayTarget {
    image: image::RgbaImage,
    /// Logical (point) size and position: width, height, x, y.
    logical: (f64, f64, f64, f64),
    is_primary: bool,
}

/// macOS: pixels come from ScreenCaptureKit; overlay placement comes from the
/// Tauri monitor layout, matched to each captured display by its origin.
#[cfg(target_os = "macos")]
async fn collect_overlay_targets(app: &tauri::AppHandle) -> Result<Vec<OverlayTarget>, String> {
    let captured =
        tauri::async_runtime::spawn_blocking(capture_macos::capture_all_displays)
            .await
            .map_err(|e| format!("Task panicked: {}", e))??;

    let tauri_monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitor layout: {}", e))?;
    let primary_pos = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| *m.position());

    if tauri_monitors.len() != captured.len() {
        eprintln!(
            "Monitor count mismatch between capture ({}) and layout ({}); using capture frames",
            captured.len(),
            tauri_monitors.len()
        );
    }

    let mut targets = Vec::with_capacity(captured.len());
    for display in captured {
        let (dx, dy, dw, dh) = display.frame;
        // Find the Tauri monitor whose logical origin matches this display.
        let matched = tauri_monitors.iter().min_by(|a, b| {
            let dist = |m: &tauri::Monitor| {
                let sf = m.scale_factor();
                let px = m.position().x as f64 / sf - dx;
                let py = m.position().y as f64 / sf - dy;
                px * px + py * py
            };
            dist(a)
                .partial_cmp(&dist(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let (logical, is_primary) = match matched {
            Some(m) => {
                let sf = m.scale_factor();
                let size = m.size();
                let pos = m.position();
                (
                    (
                        size.width as f64 / sf,
                        size.height as f64 / sf,
                        pos.x as f64 / sf,
                        pos.y as f64 / sf,
                    ),
                    primary_pos.map(|p| p == *pos).unwrap_or(false),
                )
            }
            None => ((dw, dh, dx, dy), dx == 0.0 && dy == 0.0),
        };

        targets.push(OverlayTarget {
            image: display.image,
            logical,
            is_primary,
        });
    }
    Ok(targets)
}

/// Windows / Linux: keep the existing xcap path.
#[cfg(not(target_os = "macos"))]
async fn collect_overlay_targets(app: &tauri::AppHandle) -> Result<Vec<OverlayTarget>, String> {
    let capture_monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
    if capture_monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    // Get monitor layout info from Tauri for accurate sizing/positioning
    let tauri_monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitor layout: {}", e))?;

    if tauri_monitors.len() != capture_monitors.len() {
        eprintln!(
            "Monitor count mismatch between capture ({}) and layout ({}); falling back to capture dimensions",
            capture_monitors.len(),
            tauri_monitors.len()
        );
    }

    let mut targets = Vec::with_capacity(capture_monitors.len());
    for (idx, monitor) in capture_monitors.iter().enumerate() {
        let image = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture monitor {}: {}", idx, e))?;
        if is_blank_rgba(&image) {
            eprintln!("Capture of monitor {} appears blank", idx);
        }

        let logical = if let Some(display) = tauri_monitors.get(idx) {
            let scale_factor = display.scale_factor();
            let size = display.size();
            let position = display.position();
            // Size values are in physical pixels; convert to logical units for window placement
            (
                size.width as f64 / scale_factor,
                size.height as f64 / scale_factor,
                position.x as f64 / scale_factor,
                position.y as f64 / scale_factor,
            )
        } else {
            // Fallback to xcap monitor info if Tauri monitor data is unavailable/mismatched
            (
                monitor.width().map_err(|e| e.to_string())? as f64,
                monitor.height().map_err(|e| e.to_string())? as f64,
                monitor.x().map_err(|e| e.to_string())? as f64,
                monitor.y().map_err(|e| e.to_string())? as f64,
            )
        };

        targets.push(OverlayTarget {
            image,
            logical,
            is_primary: monitor.is_primary().unwrap_or(false),
        });
    }
    Ok(targets)
}

/// Near-black / empty frame check for the non-macOS path.
#[cfg(not(target_os = "macos"))]
fn is_blank_rgba(image: &image::RgbaImage) -> bool {
    let raw = image.as_raw();
    let pixels = raw.len() / 4;
    if pixels == 0 {
        return true;
    }
    let step = (pixels / 10_000).max(1);
    (0..pixels)
        .step_by(step)
        .all(|i| raw[i * 4 + 3] == 0 || raw[i * 4..i * 4 + 3].iter().all(|&c| c <= 8))
}

#[tauri::command]
pub async fn start_screen_capture(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<CaptureState>();
        if state.overlay_active.load(Ordering::SeqCst) {
            // Attempt to clean up any stale overlays before proceeding
            let _ = close_overlay_window(app.clone());
        }
        state.overlay_active.store(true, Ordering::SeqCst);
    }

    let targets = match collect_overlay_targets(&app).await {
        Ok(t) if !t.is_empty() => t,
        Ok(_) => {
            app.state::<CaptureState>()
                .overlay_active
                .store(false, Ordering::SeqCst);
            return Err("No monitors found".to_string());
        }
        Err(e) => {
            app.state::<CaptureState>()
                .overlay_active
                .store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let state = app.state::<CaptureState>();
    let mut captured_monitors = HashMap::new();
    let mut overlay_layout = Vec::with_capacity(targets.len());
    for (idx, target) in targets.into_iter().enumerate() {
        overlay_layout.push((target.logical, target.is_primary));
        captured_monitors.insert(
            idx,
            MonitorInfo {
                image: target.image,
            },
        );
    }

    // Store all captured monitors
    *state.captured_monitors.lock().unwrap() = captured_monitors;

    // Clean up any existing overlay windows before creating new ones
    for (label, window) in app.webview_windows() {
        if label.starts_with("capture-overlay-") {
            window.destroy().ok();
        }
    }

    // Create overlay windows for all monitors
    for (idx, ((logical_width, logical_height, logical_x, logical_y), is_primary)) in
        overlay_layout.iter().copied().enumerate()
    {
        let window_label = format!("capture-overlay-{}", idx);

        let overlay =
            WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App("index.html".into()))
                .title("Screen Capture")
                .inner_size(logical_width, logical_height)
                .position(logical_x, logical_y)
                .transparent(true)
                .always_on_top(true)
                .decorations(false)
                .skip_taskbar(true)
                .resizable(false)
                .closable(false)
                .minimizable(false)
                .maximizable(false)
                .visible(false)
                .focused(true)
                .accept_first_mouse(true)
                .build()
                .map_err(|e| {
                    state.overlay_active.store(false, Ordering::SeqCst);
                    format!("Failed to create overlay window {}: {}", idx, e)
                })?;

        // Wait a short moment for content to load before showing
        thread::sleep(Duration::from_millis(100));

        overlay.show().ok();
        overlay.set_always_on_top(true).ok();

        if is_primary {
            overlay.set_focus().ok();
            overlay
                .request_user_attention(Some(tauri::UserAttentionType::Critical))
                .ok();
        }
    }

    // Give a moment for all windows to settle, then focus primary again
    std::thread::sleep(std::time::Duration::from_millis(100));

    for (idx, (_, is_primary)) in overlay_layout.iter().enumerate() {
        if *is_primary {
            let window_label = format!("capture-overlay-{}", idx);
            if let Some(window) = app.get_webview_window(&window_label) {
                window.set_focus().ok();
            }
            break;
        }
    }

    Ok(())
}

// close overlay window
#[tauri::command]
pub fn close_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    // Get all webview windows and close those that are capture overlays
    let webview_windows = app.webview_windows();

    for (label, window) in webview_windows.iter() {
        if label.starts_with("capture-overlay-") {
            window.destroy().ok();
        }
    }

    // Clear captured monitors from state
    let state = app.state::<CaptureState>();
    state.captured_monitors.lock().unwrap().clear();
    state.overlay_active.store(false, Ordering::SeqCst);

    // Emit an event to the main window to signal that the overlay has been closed
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.emit("capture-closed", ()).unwrap();
    }

    Ok(())
}

#[tauri::command]
pub async fn capture_selected_area(
    app: tauri::AppHandle,
    coords: SelectionCoords,
    monitor_index: usize,
) -> Result<String, String> {
    // Get the stored captured monitors
    let state = app.state::<CaptureState>();
    let mut captured_monitors = state.captured_monitors.lock().unwrap();

    let monitor_info = captured_monitors.remove(&monitor_index).ok_or({
        state.overlay_active.store(false, Ordering::SeqCst);
        format!("No captured image found for monitor {}", monitor_index)
    })?;

    // Validate coordinates
    if coords.width == 0 || coords.height == 0 {
        return Err("Invalid selection dimensions".to_string());
    }

    let img_width = monitor_info.image.width();
    let img_height = monitor_info.image.height();

    // Ensure coordinates are within bounds
    let x = coords.x.min(img_width.saturating_sub(1));
    let y = coords.y.min(img_height.saturating_sub(1));
    let width = coords.width.min(img_width - x);
    let height = coords.height.min(img_height - y);

    // Crop the image to the selected area
    let cropped = monitor_info.image.view(x, y, width, height).to_image();

    // Encode to PNG and base64
    let mut png_buffer = Vec::new();
    PngEncoder::new(&mut png_buffer)
        .write_image(
            cropped.as_raw(),
            cropped.width(),
            cropped.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| format!("Failed to encode to PNG: {}", e))?;

    let base64_str = base64::engine::general_purpose::STANDARD.encode(png_buffer);

    captured_monitors.clear();
    drop(captured_monitors);

    // Close all overlay windows
    let webview_windows = app.webview_windows();
    for (label, window) in webview_windows.iter() {
        if label.starts_with("capture-overlay-") {
            window.destroy().ok();
        }
    }

    // Emit event with base64 data
    app.emit("captured-selection", &base64_str)
        .map_err(|e| format!("Failed to emit captured-selection event: {}", e))?;

    state.overlay_active.store(false, Ordering::SeqCst);

    Ok(base64_str)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn capture_to_base64(window: tauri::WebviewWindow) -> Result<String, String> {
    // Window geometry in global points, to pick the display it sits on.
    let scale = window.scale_factor().unwrap_or(1.0);
    let window_rect = match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) => Some((
            pos.x as f64 / scale,
            pos.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        )),
        _ => None,
    };

    let png = tauri::async_runtime::spawn_blocking(move || {
        capture_macos::capture_best_display_png(window_rect)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))??;

    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn capture_to_base64(window: tauri::WebviewWindow) -> Result<String, String> {
    let monitor_fallback = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    let geometry = match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => {
            let width = size.width.min(i32::MAX as u32) as i32;
            let height = size.height.min(i32::MAX as u32) as i32;
            let left = position.x;
            let top = position.y;
            (
                left,
                top,
                left.saturating_add(width),
                top.saturating_add(height),
                left.saturating_add(width / 2),
                top.saturating_add(height / 2),
            )
        }
        _ => {
            if let Some(monitor) = &monitor_fallback {
                let position = monitor.position();
                let size = monitor.size();
                let width = size.width.min(i32::MAX as u32) as i32;
                let height = size.height.min(i32::MAX as u32) as i32;
                let left = position.x;
                let top = position.y;
                (
                    left,
                    top,
                    left.saturating_add(width),
                    top.saturating_add(height),
                    left.saturating_add(width / 2),
                    top.saturating_add(height / 2),
                )
            } else {
                (0, 0, 0, 0, 0, 0)
            }
        }
    };

    let (window_left, window_top, window_right, window_bottom, window_center_x, window_center_y) =
        geometry;

    tauri::async_runtime::spawn_blocking(move || {
        let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
        if monitors.is_empty() {
            return Err("No monitors found".to_string());
        }

        let mut best_idx: Option<usize> = None;
        let mut best_area: i64 = 0;

        for (idx, monitor) in monitors.iter().enumerate() {
            let monitor_left = monitor.x().map_err(|e| e.to_string())?;
            let monitor_top = monitor.y().map_err(|e| e.to_string())?;
            let monitor_right =
                monitor_left.saturating_add(monitor.width().map_err(|e| e.to_string())? as i32);
            let monitor_bottom =
                monitor_top.saturating_add(monitor.height().map_err(|e| e.to_string())? as i32);

            let overlap_width =
                (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
            let overlap_height =
                (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);
            let area = (overlap_width as i64) * (overlap_height as i64);

            if area > best_area {
                best_area = area;
                best_idx = Some(idx);
            }
        }

        let target_idx = if let Some(idx) = best_idx {
            idx
        } else {
            let mut closest_idx = 0usize;
            let mut closest_distance = i128::MAX;

            for (idx, monitor) in monitors.iter().enumerate() {
                let monitor_center_x = monitor
                    .x()
                    .map_err(|e| e.to_string())?
                    .saturating_add(monitor.width().map_err(|e| e.to_string())? as i32 / 2);
                let monitor_center_y = monitor
                    .y()
                    .map_err(|e| e.to_string())?
                    .saturating_add(monitor.height().map_err(|e| e.to_string())? as i32 / 2);
                let dx = (window_center_x - monitor_center_x) as i128;
                let dy = (window_center_y - monitor_center_y) as i128;
                let distance = dx * dx + dy * dy;

                if distance < closest_distance {
                    closest_distance = distance;
                    closest_idx = idx;
                }
            }

            closest_idx
        };

        let monitor = monitors
            .into_iter()
            .enumerate()
            .find_map(|(idx, monitor)| {
                if idx == target_idx {
                    Some(monitor)
                } else {
                    None
                }
            })
            .ok_or_else(|| "Failed to determine target monitor".to_string())?;

        let image = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture image: {}", e))?;
        if is_blank_rgba(&image) {
            eprintln!("Full-screen capture appears blank");
        }
        let mut png_buffer = Vec::new();
        PngEncoder::new(&mut png_buffer)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ColorType::Rgba8.into(),
            )
            .map_err(|e| format!("Failed to encode to PNG: {}", e))?;
        let base64_str = base64::engine::general_purpose::STANDARD.encode(png_buffer);

        Ok(base64_str)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}
