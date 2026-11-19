use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::State;

#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "flv", "webm", "avi"];
const SOCKET_WAIT: Duration = Duration::from_secs(3);
const IPC_TIMEOUT: Duration = Duration::from_secs(60);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(15);

static IPC_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct GsrState {
    inner: Arc<Mutex<Option<GsrSession>>>,
}

struct GsrSession {
    child: Child,
    pid: u32,
    game: String,
    replay_dir: PathBuf,
    recording_dir: PathBuf,
    ipc_path: Option<PathBuf>,
    recording_active: bool,
    reader: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GsrOptions {
    #[serde(default = "default_capture_target")]
    capture_target: String,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default = "default_codec")]
    codec: String,
    #[serde(default)]
    audio_devices: Vec<String>,
    #[serde(default = "default_replay_seconds")]
    replay_seconds: u32,
    #[serde(default)]
    record: bool,
}

fn default_capture_target() -> String {
    "portal".to_string()
}

fn default_fps() -> u32 {
    60
}

fn default_codec() -> String {
    "auto".to_string()
}

fn default_replay_seconds() -> u32 {
    120
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    name: String,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GsrStatus {
    available: bool,
    version: Option<String>,
    supports_ipc: bool,
    capture_options: Vec<String>,
    audio_devices: Vec<AudioDevice>,
    is_wayland: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn gsr_supported() -> bool {
    cfg!(target_os = "linux")
}

#[tauri::command]
pub async fn gsr_check() -> Result<GsrStatus, String> {
    tauri::async_runtime::spawn_blocking(gsr_check_internal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gsr_check_internal() -> GsrStatus {
    if !cfg!(target_os = "linux") {
        return GsrStatus {
            available: false,
            version: None,
            supports_ipc: false,
            audio_devices: Vec::new(),
            is_wayland: false,
            capture_options: Vec::new(),
            error: Some("GPU Screen Recorder is only supported on Linux".to_string()),
        };
    }

    let help_output = match Command::new("gpu-screen-recorder").arg("--help").output() {
        Ok(output) => output,
        Err(error) => {
            return GsrStatus {
                available: false,
                version: None,
                supports_ipc: false,

                is_wayland: false,
                audio_devices: Vec::new(),
                capture_options: Vec::new(),
                error: Some(format!("Could not run gpu-screen-recorder: {}", error)),
            };
        }
    };

    let help_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&help_output.stdout),
        String::from_utf8_lossy(&help_output.stderr)
    );

    let supports_ipc = help_text.contains("-ipc");
    let version = detect_version(&help_text);

    let capture_options = Command::new("gpu-screen-recorder")
        .arg("--list-capture-options")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let audio_devices = Command::new("gpu-screen-recorder")
        .arg("--list-audio-devices")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let (name, description) = line.split_once('|')?;

                    Some(AudioDevice {
                        name: name.trim().to_string(),
                        description: description.trim().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    GsrStatus {
        available: true,
        version,
        supports_ipc,
        capture_options,
        is_wayland: is_wayland(),
        audio_devices,
        error: None,
    }
}

fn detect_version(help_text: &str) -> Option<String> {
    if let Ok(output) = Command::new("gpu-screen-recorder")
        .arg("--version")
        .output()
    {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !version.is_empty() {
            return Some(version);
        }
    }

    help_text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn supports_ipc() -> bool {
    Command::new("gpu-screen-recorder")
        .arg("--help")
        .output()
        .map(|output| {
            let help_text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            help_text.contains("-ipc")
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn gsr_start_session(
    state: State<'_, GsrState>,
    game_name: String,
    games_dir: String,
    options: GsrOptions,
) -> Result<(), String> {
    if game_name.trim().is_empty() {
        return Err("Game name is required".to_string());
    }

    let game = sanitize_component(&game_name);
    let game_dir = PathBuf::from(&games_dir).join(&game);
    let replay_dir = game_dir.join("replays");
    let recording_dir = game_dir.join("recordings");

    fs::create_dir_all(&replay_dir)
        .map_err(|error| format!("Failed to create replay directory: {}", error))?;
    fs::create_dir_all(&recording_dir)
        .map_err(|error| format!("Failed to create recording directory: {}", error))?;

    {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "GPU Screen Recorder state is locked".to_string())?;
        if guard.is_some() {
            return Err("A GPU Screen Recorder session is already running".to_string());
        }
    }

    let ipc_supported = supports_ipc();
    let socket_path = ipc_supported.then(socket_path);

    let args = build_args(
        &options,
        &replay_dir,
        &recording_dir,
        socket_path.as_deref(),
    );

    let mut child = Command::new("gpu-screen-recorder")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to start gpu-screen-recorder: {}", error))?;

    let pid = child.id();
    let reader = child.stdout.take().map(|stdout| {
        let game = game.clone();
        let replay_dir = replay_dir.clone();
        let recording_dir = recording_dir.clone();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                rename_saved_file(&line, &game, &[&replay_dir, &recording_dir]);
            }
        })
    });

    let session = GsrSession {
        child,
        pid,
        game: game.clone(),
        replay_dir,
        recording_dir,
        ipc_path: socket_path,
        recording_active: false,
        reader,
    };

    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "GPU Screen Recorder state is locked".to_string())?;
        *guard = Some(session);
    }

    if options.record {
        let wait = if ipc_supported {
            Duration::from_millis(250)
        } else {
            Duration::from_millis(1500)
        };
        tokio::time::sleep(wait).await;

        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "GPU Screen Recorder state is locked".to_string())?;

        if let Some(session) = guard.as_mut() {
            if session.pid == pid {
                if let Err(error) = session.start_recording() {
                    if let Some(session) = guard.take() {
                        let _ = session.stop();
                    }
                    return Err(format!("Failed to start full-session recording: {}", error));
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn gsr_stop_session(state: State<'_, GsrState>) -> Result<(), String> {
    let session = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "GPU Screen Recorder state is locked".to_string())?;
        guard.take()
    };

    match session {
        Some(session) => tokio::task::spawn_blocking(move || session.stop())
            .await
            .map_err(|error| format!("Failed to join stop task: {}", error))?,
        None => Ok(()),
    }
}

#[tauri::command]
pub fn gsr_save_replay(state: State<'_, GsrState>) -> Result<(), String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| "GPU Screen Recorder state is locked".to_string())?;

    match guard.as_ref() {
        Some(session) => session.save_replay(),
        None => Err("No GPU Screen Recorder session is running".to_string()),
    }
}

pub fn save_replay_from_state(state: &GsrState) {
    if let Ok(guard) = state.inner.lock() {
        if let Some(session) = guard.as_ref() {
            if let Err(error) = session.save_replay() {
                eprintln!("Failed to save GPU Screen Recorder replay: {}", error);
            }
        }
    }
}

pub fn shutdown(state: &GsrState) {
    let session = state.inner.lock().ok().and_then(|mut guard| guard.take());

    if let Some(session) = session {
        if let Err(error) = session.stop() {
            eprintln!("Failed to stop GPU Screen Recorder: {}", error);
        }
    }
}

fn build_args(
    options: &GsrOptions,
    replay_dir: &Path,
    recording_dir: &Path,
    socket_path: Option<&Path>,
) -> Vec<String> {
    let mut args = Vec::new();

    let capture_target = if is_wayland() || options.capture_target.trim().is_empty() {
        "portal"
    } else {
        options.capture_target.trim()
    };

    args.push("-w".to_string());
    args.push(capture_target.to_string());
    args.push("-c".to_string());
    args.push("mp4".to_string());
    args.push("-f".to_string());
    args.push(options.fps.max(1).to_string());

    if options.codec != "auto" {
        args.push("-k".to_string());
        args.push(options.codec.clone());
    }

    let audio_devices = if options.audio_devices.is_empty() {
        vec!["default_output".to_string()]
    } else {
        options.audio_devices.clone()
    };

    for audio_device in audio_devices {
        if !audio_device.trim().is_empty() {
            args.push("-a".to_string());
            args.push(audio_device.trim().to_string());
        }
    }

    args.push("-r".to_string());
    args.push(options.replay_seconds.clamp(2, 86400).to_string());
    args.push("-o".to_string());
    args.push(replay_dir.to_string_lossy().to_string());
    args.push("-ro".to_string());
    args.push(recording_dir.to_string_lossy().to_string());
    args.push("-fallback-cpu-encoding".to_string());
    args.push("yes".to_string());

    if let Some(socket_path) = socket_path {
        args.push("-ipc".to_string());
        args.push(socket_path.to_string_lossy().to_string());
    }

    args
}

impl GsrSession {
    fn start_recording(&mut self) -> Result<(), String> {
        if self.recording_active {
            return Ok(());
        }

        if let Some(socket_path) = &self.ipc_path {
            if send_ipc(socket_path, "start-replay-recording", None).is_ok() {
                self.recording_active = true;
                return Ok(());
            }
        }

        signal(self.pid, signal_rtmin())?;
        self.recording_active = true;
        Ok(())
    }

    fn ipc_available(&self) -> bool {
        self.ipc_path
            .as_ref()
            .map(|socket_path| socket_path.exists())
            .unwrap_or(false)
    }

    fn stop_recording(&mut self) -> Result<(), String> {
        if !self.recording_active {
            return Ok(());
        }

        self.recording_active = false;

        if self.ipc_available() {
            return send_ipc(
                self.ipc_path.as_ref().unwrap(),
                "stop-replay-recording",
                None,
            )
            .map(|_| ());
        }

        signal(self.pid, signal_rtmin())
    }

    fn save_replay(&self) -> Result<(), String> {
        if self.ipc_available() {
            if let Ok(_) = send_ipc(self.ipc_path.as_ref().unwrap(), "save-replay", None) {
                return Ok(());
            }
        }

        signal(self.pid, signal_usr1())
    }

    fn stop(mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        let already_exited = matches!(self.child.try_wait(), Ok(Some(_)));

        if !already_exited {
            let used_ipc = self.ipc_available();

            if self.recording_active {
                if let Err(error) = self.stop_recording() {
                    errors.push(error);
                }

                if !used_ipc {
                    thread::sleep(Duration::from_millis(800));
                }
            }

            let stop_result = if used_ipc {
                send_ipc(self.ipc_path.as_ref().unwrap(), "stop", None).map(|_| ())
            } else {
                signal(self.pid, signal_int())
            };

            if let Err(error) = stop_result {
                if used_ipc {
                    if let Err(signal_error) = signal(self.pid, signal_int()) {
                        errors.push(format!("{}; {}", error, signal_error));
                    }
                } else {
                    errors.push(error);
                }
            }
        }

        self.wait_for_exit();

        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }

        self.sweep_directory(&self.replay_dir);
        self.sweep_directory(&self.recording_dir);

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn wait_for_exit(&mut self) {
        let started = Instant::now();

        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if started.elapsed() >= CHILD_EXIT_TIMEOUT {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
    }

    fn sweep_directory(&self, directory: &Path) {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && is_video_file(&path) {
                rename_file(&path, &self.game);
            }
        }
    }
}

fn socket_path() -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    base.join(format!("gaming-viewer-gsr-{}.sock", std::process::id()))
}

fn sanitize_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| match character {
            '/' | '\\' | '\0' => '-',
            _ => character,
        })
        .collect();

    let sanitized = sanitized.trim().trim_matches('.').to_string();

    if sanitized.is_empty() {
        "Unknown Game".to_string()
    } else {
        sanitized
    }
}

fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
        .unwrap_or(false)
}

fn is_managed_file(path: &Path, game: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(&format!("{}_", game)))
        .unwrap_or(false)
}

fn rename_saved_file(line: &str, game: &str, directories: &[&Path]) {
    let trimmed = line.trim().trim_matches('"');
    if trimmed.is_empty() {
        return;
    }

    let path = PathBuf::from(trimmed);

    if !is_video_file(&path) || !path.is_file() {
        return;
    }

    if !directories
        .iter()
        .any(|directory| path.starts_with(directory))
    {
        return;
    }

    rename_file(&path, game);
}

fn rename_file(path: &Path, game: &str) {
    if is_managed_file(path, game) {
        return;
    }

    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("mp4");
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return,
    };

    for offset in 0..120 {
        let timestamp = Local::now() + chrono::Duration::seconds(offset);
        let file_name = format!(
            "{}_{}.{}",
            game,
            timestamp.format("%d-%m-%Y_%H-%M-%S"),
            extension
        );
        let target = parent.join(file_name);

        if target.exists() {
            continue;
        }

        if let Err(error) = fs::rename(path, &target) {
            eprintln!(
                "Failed to rename GPU Screen Recorder clip {}: {}",
                path.display(),
                error
            );
        }
        return;
    }
}

#[cfg(target_os = "linux")]
fn signal(pid: u32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, signal) };

    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(target_os = "linux"))]
fn signal(_pid: u32, _signal: i32) -> Result<(), String> {
    Err("GPU Screen Recorder is only supported on Linux".to_string())
}

#[cfg(target_os = "linux")]
fn signal_int() -> i32 {
    libc::SIGINT
}

#[cfg(not(target_os = "linux"))]
fn signal_int() -> i32 {
    2
}

#[cfg(target_os = "linux")]
fn signal_usr1() -> i32 {
    libc::SIGUSR1
}

#[cfg(not(target_os = "linux"))]
fn signal_usr1() -> i32 {
    10
}

#[cfg(target_os = "linux")]
fn signal_rtmin() -> i32 {
    libc::SIGRTMIN()
}

#[cfg(not(target_os = "linux"))]
fn signal_rtmin() -> i32 {
    34
}

#[cfg(target_os = "linux")]
fn send_ipc(socket_path: &Path, name: &str, data: Option<Value>) -> Result<Option<Value>, String> {
    let deadline = Instant::now() + SOCKET_WAIT;

    let stream = loop {
        match UnixStream::connect(socket_path) {
            Ok(stream) => break stream,
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Could not connect to GPU Screen Recorder IPC socket: {}",
                        error
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    };

    stream
        .set_read_timeout(Some(IPC_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(IPC_TIMEOUT))
        .map_err(|error| error.to_string())?;

    let id = IPC_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let mut request = serde_json::json!({
        "id": id,
        "name": name,
    });

    if let Some(data) = data {
        request["data"] = data;
    }

    let mut writer = &stream;
    writer
        .write_all(format!("{}\n", request).as_bytes())
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;

    let mut reader = BufReader::new(&stream);
    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .map_err(|error| error.to_string())?;

    if response_line.trim().is_empty() {
        return Err("GPU Screen Recorder returned an empty IPC response".to_string());
    }

    let response: Value =
        serde_json::from_str(&response_line).map_err(|error| error.to_string())?;

    if response["result"].as_str() != Some("ok") {
        let message = response["data"]
            .as_str()
            .unwrap_or("GPU Screen Recorder IPC request failed");
        return Err(message.to_string());
    }

    Ok(response.get("data").cloned())
}

#[cfg(not(target_os = "linux"))]
fn send_ipc(
    _socket_path: &Path,
    _name: &str,
    _data: Option<Value>,
) -> Result<Option<Value>, String> {
    Err("GPU Screen Recorder is only supported on Linux".to_string())
}
