use crate::ssh::connect_and_auth;
use crate::Connection;
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;

/// SCP file transfer over the existing `russh` SSH channel — no libssh2, no
/// extra native deps, so the single portable `.exe` stays intact. We open an
/// exec channel running remote `scp -t` (sink) or `scp -f` (source) and speak
/// the classic SCP wire protocol. Files only; recursive (`-r`) is rejected.

/// Buffered reader/writer over one SCP exec channel. SCP is strictly
/// request/response, so buffering stdout into a queue and consuming from it is
/// enough; stderr is collected separately to enrich error messages.
struct ScpIo {
    channel: Channel<Msg>,
    inbuf: VecDeque<u8>,
    stderr: Vec<u8>,
    eof: bool,
}

impl ScpIo {
    fn new(channel: Channel<Msg>) -> Self {
        Self { channel, inbuf: VecDeque::new(), stderr: Vec::new(), eof: false }
    }

    /// Block until at least one stdout byte is buffered or the channel ends.
    async fn pump(&mut self) -> Result<(), String> {
        while self.inbuf.is_empty() && !self.eof {
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) => self.inbuf.extend(data.iter().copied()),
                Some(ChannelMsg::ExtendedData { data, .. }) => self.stderr.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | None => self.eof = true,
                _ => {}
            }
        }
        Ok(())
    }

    async fn read_u8(&mut self) -> Result<Option<u8>, String> {
        self.pump().await?;
        Ok(self.inbuf.pop_front())
    }

    fn ctx(&self, base: &str) -> String {
        let e = String::from_utf8_lossy(&self.stderr);
        let e = e.trim();
        if e.is_empty() { base.to_string() } else { format!("{base}: {e}") }
    }

    /// Read a control-response byte: 0 = OK, 1/2 = warning/error + message line.
    async fn read_reply(&mut self) -> Result<(), String> {
        match self.read_u8().await? {
            Some(0) => Ok(()),
            Some(_) => {
                let mut msg = String::new();
                loop {
                    match self.read_u8().await? {
                        Some(b'\n') | None => break,
                        Some(b) => msg.push(b as char),
                    }
                }
                Err(if msg.trim().is_empty() { self.ctx("scp remote error") } else { msg })
            }
            None => Err(self.ctx("scp: channel closed unexpectedly")),
        }
    }

    /// Read one control line up to (not including) the newline.
    async fn read_line(&mut self) -> Result<Vec<u8>, String> {
        let mut line = Vec::new();
        loop {
            match self.read_u8().await? {
                Some(b'\n') => break,
                Some(b) => line.push(b),
                None => break,
            }
        }
        Ok(line)
    }

    async fn write_all(&mut self, data: &[u8]) -> Result<(), String> {
        self.channel.data(data).await.map_err(|e| e.to_string())
    }

    async fn ack(&mut self) -> Result<(), String> {
        self.write_all(&[0u8]).await
    }
}

/// Single-quote a remote path for the server shell (scp runs it via `sh -c`).
fn quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\''");
    format!("'{escaped}'")
}

/// Upload one local file to `remote` (a remote file path or existing directory).
#[tauri::command]
pub async fn scp_upload(conn: Connection, local: String, remote: String) -> Result<(), String> {
    let meta = std::fs::metadata(&local).map_err(|e| format!("Cannot read local file: {e}"))?;
    if meta.is_dir() {
        return Err("Recursive directory upload is not supported yet".into());
    }
    let size = meta.len();
    let name = Path::new(&local)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid local filename")?
        .to_string();

    let handle = connect_and_auth(&conn).await?;
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    let cmd = format!("scp -t {}", quote(&remote));
    channel.exec(true, cmd).await.map_err(|e| e.to_string())?;
    let mut io = ScpIo::new(channel);

    io.read_reply().await?;
    io.write_all(format!("C0644 {size} {name}\n").as_bytes()).await?;
    io.read_reply().await?;

    let mut f = std::fs::File::open(&local).map_err(|e| format!("Cannot open local file: {e}"))?;
    let mut buf = [0u8; 32768];
    let mut sent: u64 = 0;
    while sent < size {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        io.write_all(&buf[..n]).await?;
        sent += n as u64;
    }
    io.ack().await?;
    io.read_reply().await?;

    let _ = io.channel.eof().await;
    Ok(())
}

/// Download one remote file `remote` to the local path `local`.
#[tauri::command]
pub async fn scp_download(conn: Connection, remote: String, local: String) -> Result<(), String> {
    let handle = connect_and_auth(&conn).await?;
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    let cmd = format!("scp -f {}", quote(&remote));
    channel.exec(true, cmd).await.map_err(|e| e.to_string())?;
    let mut io = ScpIo::new(channel);

    io.ack().await?;
    loop {
        let line = io.read_line().await?;
        if line.is_empty() {
            return Err(io.ctx("scp: no file received"));
        }
        match line[0] {
            b'T' => {
                io.ack().await?;
                continue;
            }
            b'C' => {
                let header = String::from_utf8_lossy(&line);
                let mut parts = header[1..].splitn(3, ' ');
                let _mode = parts.next().unwrap_or("");
                let size: u64 = parts
                    .next()
                    .and_then(|s| s.trim().parse().ok())
                    .ok_or("scp: malformed size in header")?;
                io.ack().await?;

                let mut out = std::fs::File::create(&local)
                    .map_err(|e| format!("Cannot create local file: {e}"))?;
                let mut remaining = size;
                while remaining > 0 {
                    io.pump().await?;
                    if io.inbuf.is_empty() && io.eof {
                        return Err(io.ctx("scp: stream ended before file was complete"));
                    }
                    let take = std::cmp::min(remaining as usize, io.inbuf.len());
                    let chunk: Vec<u8> = io.inbuf.drain(..take).collect();
                    out.write_all(&chunk).map_err(|e| e.to_string())?;
                    remaining -= take as u64;
                }
                out.flush().map_err(|e| e.to_string())?;
                io.read_reply().await?;
                io.ack().await?;
                let _ = io.channel.eof().await;
                return Ok(());
            }
            b'D' => return Err("Recursive directory download is not supported yet".into()),
            1 | 2 => {
                let msg = String::from_utf8_lossy(&line[1..]).trim().to_string();
                return Err(if msg.is_empty() { io.ctx("scp remote error") } else { msg });
            }
            _ => {
                return Err(format!(
                    "scp: unexpected response: {}",
                    String::from_utf8_lossy(&line)
                ))
            }
        }
    }
}
