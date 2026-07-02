use crate::{next_id, AppState, Connection, Logger};
use serialport::SerialPort;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

pub struct SerialSession {
    pub writer: Arc<Mutex<Box<dyn SerialPort>>>,
    pub stop: Arc<AtomicBool>,
    pub logger: Logger,
}

#[tauri::command]
pub async fn serial_list_ports() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        serialport::available_ports()
            .map(|ports| ports.into_iter().map(|p| p.port_name).collect::<Vec<_>>())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn serial_open(
    conn: Connection,
    on_data: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let name = conn.serial_port.clone().ok_or("Missing serial port")?;
    let baud = conn.baud_rate.unwrap_or(115200);

    let (writer, mut reader) = tokio::task::spawn_blocking(move || {
        let port = serialport::new(&name, baud)
            .timeout(Duration::from_millis(20))
            .open()
            .map_err(|e| e.to_string())?;
        let reader = port.try_clone().map_err(|e| e.to_string())?;
        Ok::<_, String>((port, reader))
    })
    .await
    .map_err(|e| e.to_string())??;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_reader = stop.clone();
    let logger: Logger = crate::new_logger();
    let logger_reader = logger.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            if stop_reader.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(n) => {
                    if let Ok(mut guard) = logger_reader.lock() {
                        if let Some(file) = guard.as_mut() {
                            let _ = file.write_all(&buf[..n]);
                            let _ = file.flush();
                        }
                    }
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(ref e) if e.kind() == ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
    });

    let id = next_id("serial");
    state.serial.lock().await.insert(
        id.clone(),
        SerialSession {
            writer: Arc::new(Mutex::new(writer)),
            stop,
            logger,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn serial_write(
    id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let writer = {
        let map = state.serial.lock().await;
        map.get(&id).map(|s| s.writer.clone())
    };
    let Some(writer) = writer else {
        return Err("Serial session not found".into());
    };
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut port = writer.lock().map_err(|e| e.to_string())?;
        port.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        port.flush().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn serial_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(s) = state.serial.lock().await.remove(&id) {
        s.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}
