use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct TranscriptionServiceState {
    pub process: Mutex<Option<Child>>,
    pub token: Mutex<Option<String>>,
}

impl Default for TranscriptionServiceState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            token: Mutex::new(None),
        }
    }
}

impl TranscriptionServiceState {
    pub fn kill(&self) {
        let mut proc = self.process.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut child) = *proc {
            let _ = child.kill();
            let _ = child.wait();
        }
        *proc = None;
        *self.token.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn find_python(service_dir: &std::path::Path) -> Option<String> {
    for relative in [
        ".venv/bin/python",
        "venv/bin/python",
        ".venv/Scripts/python.exe",
        "venv/Scripts/python.exe",
    ] {
        let executable = service_dir.join(relative);
        if executable.is_file()
            && Command::new(&executable)
                .arg("-c")
                .arg("import fastapi, faster_whisper, uvicorn, multipart")
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        {
            return Some(executable.to_string_lossy().into_owned());
        }
    }
    // Try common Python executable names
    let candidates = ["python3", "python", "py"];
    for name in candidates {
        let result = Command::new(name).arg("--version").output();
        if let Ok(output) = result {
            if output.status.success() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn get_service_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Locate the service only in application-owned directories.
    let mut possible_paths = vec![
        // Bundled: next to the executable
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("transcription_service"))),
        // Resource dir
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("transcription_service")),
    ];
    // Never execute Python code from an arbitrary launch working directory.
    #[cfg(debug_assertions)]
    possible_paths.insert(
        0,
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("transcription_service")),
    );

    for path in possible_paths.into_iter().flatten() {
        if path.join("main.py").exists() {
            return Ok(path);
        }
    }

    Err("Could not find transcription_service/main.py. Make sure it exists next to the application.".to_string())
}

#[tauri::command]
pub async fn start_transcription_service(app: AppHandle) -> Result<String, String> {
    let state = app.state::<TranscriptionServiceState>();

    // Serialize startup across the main and dashboard windows.
    let mut proc = state.process.lock().unwrap_or_else(|e| e.into_inner());
    {
        if let Some(ref mut child) = *proc {
            // Check if process is still alive
            match child.try_wait() {
                Ok(None) => {
                    // Still running
                    return Ok("Transcription service is already running.".to_string());
                }
                _ => {
                    // Process exited, clean up
                    *proc = None;
                }
            }
        }
    }

    let service_dir = get_service_dir(&app)?;
    let python = find_python(&service_dir).ok_or_else(|| {
        "Python not found. Please install Python and ensure it is on your PATH.".to_string()
    })?;

    let main_py = service_dir.join("main.py");

    tracing::info!(
        "Starting transcription service: {} {} (cwd: {})",
        python,
        main_py.display(),
        service_dir.display()
    );

    let token = uuid::Uuid::new_v4().to_string();
    let child = Command::new(&python)
        .arg(main_py.to_str().unwrap())
        .current_dir(&service_dir)
        .env("TRANSCRIPTION_TOKEN", &token)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start transcription service: {}", e))?;

    let pid = child.id();

    *proc = Some(child);
    *state.token.lock().unwrap_or_else(|e| e.into_inner()) = Some(token);

    tracing::info!("Transcription service started (PID: {})", pid);
    Ok(format!("Transcription service started (PID: {})", pid))
}

#[tauri::command]
pub fn transcription_service_token(app: AppHandle) -> Result<String, String> {
    app.state::<TranscriptionServiceState>()
        .token
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "Local transcription service is not running".to_string())
}

#[tauri::command]
pub async fn stop_transcription_service(app: AppHandle) -> Result<String, String> {
    let state = app.state::<TranscriptionServiceState>();
    state.kill();
    tracing::info!("Transcription service stopped.");
    Ok("Transcription service stopped.".to_string())
}

#[tauri::command]
pub async fn transcription_service_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<TranscriptionServiceState>();
    let mut proc = state.process.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut child) = *proc {
        match child.try_wait() {
            Ok(None) => Ok(true), // Still running
            _ => {
                *proc = None;
                Ok(false)
            }
        }
    } else {
        Ok(false)
    }
}
