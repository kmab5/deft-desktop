// SPDX-License-Identifier: GPL-3.0-only
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod operations;
mod publication;
use anyhow::{anyhow, Context, Result};
use desktop::Desktop;
use serde_json::Value;
use tauri::{ipc::Response, Emitter, Manager, WebviewWindowBuilder};

#[tauri::command]
async fn deft(window: tauri::WebviewWindow, op: String, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operations::run(&window, &op, args).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn publication_asset(
    app: tauri::AppHandle,
    book_id: String,
    index: Option<usize>,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let book = desktop.source(&book_id)?;
        publication::asset(&book, index).map(Response::new)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn publication_cache(
    app: tauri::AppHandle,
    book_id: String,
    publication: deft_core::formats::Publication,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let book = desktop.source(&book_id)?;
        publication::cache_kindle(&desktop, &book, publication)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("{error:#}"))
}

#[cfg(windows)]
fn portable_data_directory() -> Result<Option<std::path::PathBuf>> {
    let executable = std::env::current_exe().context("Finding Deft's executable")?;
    let folder = executable.parent().context("Finding Deft's folder")?;
    Ok(folder
        .join("portable.flag")
        .is_file()
        .then(|| folder.join("DeftData")))
}

#[cfg(not(windows))]
fn portable_data_directory() -> Result<Option<std::path::PathBuf>> {
    Ok(None)
}

fn run() -> Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let portable = portable_data_directory()?;
            let data = match &portable {
                Some(folder) => folder.clone(),
                None => app.path().app_local_data_dir()?,
            };
            app.manage(Desktop::new(data).context("Opening Deft's data directory")?);
            let mut window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .context("Finding the main window configuration")?
                .clone();
            if let Some(folder) = portable {
                let profile = folder.join("WebView2");
                std::fs::create_dir_all(&profile)
                    .context("Creating Deft's portable WebView2 profile")?;
                window.data_directory = Some(profile);
            }
            WebviewWindowBuilder::from_config(app, &window)?.build()?;
            let handle = app.handle().clone();
            let worker = handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let desktop = worker.state::<Desktop>();
                if let Ok(report) = desktop.scan(false) {
                    if !report.skipped {
                        let _ = worker.emit("deft:scan", &report);
                        publication::prewarm(&desktop);
                    }
                }
                loop {
                    if let Err(error) = desktop.weekly_backup() {
                        let _ = worker.emit(
                            "deft:background-error",
                            format!("Automatic backup: {error:#}"),
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed
            ) {
                desktop::keep_awake(false);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Desktop>().request_close_flush() {
                    api.prevent_close();
                    let _ = window.emit("deft:flush-and-close", ());
                    let window = window.clone();
                    // The WebView normally acknowledges immediately after its final checkpoint.
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(4));
                        let _ = window.destroy();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            deft,
            publication_asset,
            publication_cache
        ])
        .run(tauri::generate_context!())
        .map_err(|error| anyhow!(error))
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Deft could not start: {error:#}");
        let _ = native_startup_error(&format!("{error:#}"));
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn native_startup_error(message: &str) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, style: u32) -> i32;
    }
    let caption: Vec<u16> = "Deft could not start\0".encode_utf16().collect();
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    // SAFETY: Both UTF-16 strings are terminated and live through the call.
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10) != 0 }
}
#[cfg(not(windows))]
fn native_startup_error(_: &str) -> bool {
    false
}
