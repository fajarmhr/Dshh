//! VNC (RFB) viewer backend.
//!
//! A session connects straight to a VNC server, through a saved SSH session
//! (a direct-tcpip channel, so VNC's plaintext never crosses the network
//! unwrapped), or to a noVNC console proxy (OpenStack / FusionSphere links)
//! over a WebSocket. All three end up as the same byte stream, and the RFB
//! code runs over it unchanged.
//!
//! Screen updates go to the frontend as binary packets over a Tauri channel,
//! one per FramebufferUpdate, each a run of records (little-endian u16s):
//!
//! * `1` rect   — x, y, w, h, then w·h·4 bytes of RGBA
//! * `2` resize — w, h
//! * `3` cursor — hotspot x, y, w, h, then w·h·4 bytes of RGBA
//! * `4` copy   — x, y, w, h, src x, src y (CopyRect, done on the canvas)
//!
//! The frontend acknowledges each packet once drawn; at most two may be in
//! flight before we stop asking the server for more, so a slow webview
//! throttles the server instead of queueing frames without bound.

mod auth;
mod decode;
mod keys;
mod ws;

use crate::ssh::SshHandle;
use crate::{next_id, AppState, Connection};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::io::{
    AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf,
};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Any duplex byte stream a session can run over: TCP, TLS, an SSH channel,
/// or the WebSocket adapter.
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

const PKT_RECT: u8 = 1;
const PKT_RESIZE: u8 = 2;
const PKT_CURSOR: u8 = 3;
const PKT_COPY: u8 = 4;

const ENC_RAW: i32 = 0;
const ENC_COPYRECT: i32 = 1;
const ENC_RRE: i32 = 2;
const ENC_HEXTILE: i32 = 5;
const ENC_ZRLE: i32 = 16;
const ENC_CURSOR: i32 = -239;
const ENC_DESKTOP_SIZE: i32 = -223;
const ENC_LAST_RECT: i32 = -224;
const ENC_QEMU_EXT_KEY: i32 = -258;

/// Undrawn screen packets allowed before we stop requesting updates.
const MAX_IN_FLIGHT: u32 = 2;
/// A still screen sends nothing, and reverse proxies drop idle WebSockets
/// (nginx's default is 60 s), so poke the server this often when quiet.
const KEEPALIVE: Duration = Duration::from_secs(20);

const CONSOLE_TOKEN_HINT: &str = "The console proxy closed the session before VNC started. \
     Console tokens are short-lived and often single-use — get a fresh console link and try again.";

pub struct VncSession {
    tx: mpsc::UnboundedSender<VncCmd>,
    tasks: [tokio::task::AbortHandle; 2],
    /// Keeps the SSH connection under a tunnelled session alive.
    _ssh: Option<SshHandle>,
}

impl Drop for VncSession {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

enum VncCmd {
    /// `code` is an XT scancode (0xE0-prefixed when extended), 0 if unknown.
    Key { keysym: u32, code: u32, down: bool },
    Pointer { x: u16, y: u16, buttons: u8 },
    CutText(String),
    /// The reader finished a FramebufferUpdate. `sent`: a packet went to the
    /// frontend and will be acknowledged. `full`: the screen was resized, so
    /// ask for all of it.
    UpdateDone { w: u16, h: u16, sent: bool, full: bool },
    Ack,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VncEvent {
    Closed { reason: String },
    Clipboard { text: String },
    Bell,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncHello {
    id: String,
    width: u16,
    height: u16,
    name: String,
    version: String,
    security: String,
}

/// Wrap a stream in TLS. Console proxies on a bare IP and VNC servers'
/// generated X509 certificates are self-signed almost without exception, so
/// verification is opt-in per connection.
pub async fn tls_wrap(s: BoxStream, domain: &str, verify: bool) -> Result<BoxStream, String> {
    let mut builder = tokio_native_tls::native_tls::TlsConnector::builder();
    if !verify {
        builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    let connector = builder.build().map_err(|e| format!("TLS setup failed: {e}"))?;
    let tls = tokio_native_tls::TlsConnector::from(connector)
        .connect(domain, s)
        .await
        .map_err(|e| format!("TLS handshake with {domain} failed: {e}"))?;
    Ok(Box::new(tls))
}

#[tauri::command]
pub async fn vnc_connect(
    conn: Connection,
    via: Option<Connection>,
    token: Option<String>,
    on_frame: Channel<InvokeResponseBody>,
    on_event: Channel<VncEvent>,
    state: State<'_, AppState>,
) -> Result<VncHello, String> {
    let (session, hello) = start(conn, via, token, on_frame, on_event).await?;
    state.vnc.lock().await.insert(hello.id.clone(), session);
    Ok(hello)
}

/// Connect, log in, and start the reader/writer tasks.
async fn start(
    conn: Connection,
    via: Option<Connection>,
    token: Option<String>,
    on_frame: Channel<InvokeResponseBody>,
    on_event: Channel<VncEvent>,
) -> Result<(VncSession, VncHello), String> {
    let console = conn.vnc_mode.as_deref() == Some("console");
    let host = conn
        .host
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or("Missing host")?
        .to_string();
    let port = conn
        .port
        .filter(|p| *p != 0)
        .unwrap_or(if console { 8002 } else { 5900 });
    let verify = conn.vnc_verify_tls.unwrap_or(false);

    let (stream, ssh) = open_transport(&host, port, via.as_ref()).await?;
    let stream = if console {
        open_console(stream, &conn, &host, port, token.as_deref(), verify).await?
    } else {
        stream
    };

    let creds = auth::Credentials {
        username: conn.username.as_deref().unwrap_or(""),
        password: conn.password.as_deref().unwrap_or(""),
        tls_domain: &host,
        verify_tls: verify,
    };
    let (stream, init) =
        tokio::time::timeout(Duration::from_secs(20), auth::handshake(stream, &creds))
            .await
            .map_err(|_| "The VNC server stopped answering during login".to_string())?
            .map_err(|e| {
                if console && e.starts_with("Connection closed before") {
                    CONSOLE_TOKEN_HINT.to_string()
                } else {
                    e
                }
            })?;

    let (rd, mut wr) = tokio::io::split(stream);
    let (w, h) = (init.width, init.height);
    let mut hello_msgs = set_pixel_format();
    hello_msgs.extend(set_encodings());
    hello_msgs.extend(fbu_request(false, 0, 0, w, h));
    wr.write_all(&hello_msgs)
        .await
        .map_err(|e| format!("Connection error: {e}"))?;

    // Size the canvas before the first update can land: the reader starts
    // before this command returns, and the channel keeps packets in order.
    let mut first = vec![PKT_RESIZE];
    put_u16s(&mut first, &[w, h]);
    let _ = on_frame.send(InvokeResponseBody::Raw(first));

    let (tx, rx) = mpsc::unbounded_channel();
    let ext_keys = Arc::new(AtomicBool::new(false));

    let reader = {
        let tx = tx.clone();
        let ext_keys = ext_keys.clone();
        tokio::spawn(async move {
            let rd = BufReader::with_capacity(256 * 1024, rd);
            let reason = read_loop(rd, w, h, tx, &on_frame, &on_event, ext_keys).await;
            let _ = on_event.send(VncEvent::Closed { reason });
        })
    };
    let writer = tokio::spawn(write_loop(wr, rx, ext_keys, (w, h)));

    let session = VncSession {
        tx,
        tasks: [reader.abort_handle(), writer.abort_handle()],
        _ssh: ssh,
    };
    let hello = VncHello {
        id: next_id("vnc"),
        width: w,
        height: h,
        name: init.name,
        version: init.version,
        security: init.security,
    };
    Ok((session, hello))
}

/// TCP to the target, or a direct-tcpip channel opened by the SSH session
/// the connection is routed through. The returned handle must outlive the
/// stream.
async fn open_transport(
    host: &str,
    port: u16,
    via: Option<&Connection>,
) -> Result<(BoxStream, Option<SshHandle>), String> {
    if let Some(via) = via {
        let ssh = crate::ssh::connect_and_auth(via)
            .await
            .map_err(|e| format!("SSH to {}: {e}", via.name))?;
        let channel = ssh
            .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("{} can't reach {host}:{port}: {e}", via.name))?;
        return Ok((Box::new(channel.into_stream()), Some(ssh)));
    }
    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("Connection to {host}:{port} timed out"))?
        .map_err(|e| format!("Connect to {host}:{port} failed: {e}"))?;
    let _ = tcp.set_nodelay(true);
    Ok((Box::new(tcp), None))
}

/// The WebSocket a noVNC console page (`vnc_auto.html?token=…`) would open:
/// `wss://host:port/websockify?token=…`, with the token also sent as the
/// cookie older noVNC builds used.
async fn open_console(
    stream: BoxStream,
    conn: &Connection,
    host: &str,
    port: u16,
    token: Option<&str>,
    verify: bool,
) -> Result<BoxStream, String> {
    let token = token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("This console needs a token — paste the console link or its token")?;
    let tls = conn.vnc_tls.unwrap_or(true);
    let stream = if tls { tls_wrap(stream, host, verify).await? } else { stream };
    let base = conn
        .vnc_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("websockify");
    let path = path_with_token(base, token);
    let host_part = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let default_port = if tls { 443 } else { 80 };
    let host_header = if port == default_port {
        host_part
    } else {
        format!("{host_part}:{port}")
    };
    let origin = format!("{}://{host_header}", if tls { "https" } else { "http" });
    let cookie = format!("token={}", url_encode(token));
    ws::connect(
        stream,
        ws::Upgrade {
            host_header: &host_header,
            path: &path,
            origin: &origin,
            cookie: Some(&cookie),
        },
    )
    .await
    // websockify-based proxies check the token before completing the
    // upgrade and just hang up on a bad one.
    .map_err(|e| {
        if e.contains("closed the connection") {
            CONSOLE_TOKEN_HINT.to_string()
        } else {
            e
        }
    })
}

fn path_with_token(base: &str, token: &str) -> String {
    let path = if base.starts_with('/') { base.to_string() } else { format!("/{base}") };
    if path.contains("token=") {
        return path;
    }
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{path}{sep}token={}", url_encode(token))
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

// ---- Client → server messages ----

/// 32bpp true colour, depth 24, little-endian, red/green/blue at shifts
/// 0/8/16 — so pixels arrive as R,G,B,X bytes, one step from canvas RGBA.
fn set_pixel_format() -> Vec<u8> {
    vec![
        0, 0, 0, 0, // type, padding
        32, 24, 0, 1, // bpp, depth, big-endian, true colour
        0, 255, 0, 255, 0, 255, // red/green/blue max
        0, 8, 16, // shifts
        0, 0, 0, // padding
    ]
}

fn set_encodings() -> Vec<u8> {
    let list = [
        ENC_ZRLE,
        ENC_HEXTILE,
        ENC_RRE,
        ENC_COPYRECT,
        ENC_RAW,
        ENC_CURSOR,
        ENC_DESKTOP_SIZE,
        ENC_LAST_RECT,
        ENC_QEMU_EXT_KEY,
    ];
    let mut m = vec![2, 0];
    m.extend_from_slice(&(list.len() as u16).to_be_bytes());
    for e in list {
        m.extend_from_slice(&e.to_be_bytes());
    }
    m
}

fn fbu_request(incremental: bool, x: u16, y: u16, w: u16, h: u16) -> Vec<u8> {
    let mut m = vec![3, incremental as u8];
    for v in [x, y, w, h] {
        m.extend_from_slice(&v.to_be_bytes());
    }
    m
}

fn key_event(keysym: u32, down: bool) -> Vec<u8> {
    let mut m = vec![4, down as u8, 0, 0];
    m.extend_from_slice(&keysym.to_be_bytes());
    m
}

fn qemu_key_event(keysym: u32, code: u32, down: bool) -> Vec<u8> {
    let mut m = vec![255, 0];
    m.extend_from_slice(&(down as u16).to_be_bytes());
    m.extend_from_slice(&keysym.to_be_bytes());
    m.extend_from_slice(&keys::qemu_keycode(code).to_be_bytes());
    m
}

fn pointer_event(x: u16, y: u16, buttons: u8) -> Vec<u8> {
    let mut m = vec![5, buttons];
    m.extend_from_slice(&x.to_be_bytes());
    m.extend_from_slice(&y.to_be_bytes());
    m
}

/// ClientCutText is Latin-1; characters outside it become '?'.
fn cut_text(text: &str) -> Vec<u8> {
    let bytes: Vec<u8> = text
        .chars()
        .map(|c| u8::try_from(c as u32).unwrap_or(b'?'))
        .collect();
    let mut m = vec![6, 0, 0, 0];
    m.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    m.extend_from_slice(&bytes);
    m
}

// ---- Session loops ----

async fn write_loop(
    mut wr: WriteHalf<BoxStream>,
    mut rx: mpsc::UnboundedReceiver<VncCmd>,
    ext_keys: Arc<AtomicBool>,
    mut size: (u16, u16),
) {
    let mut in_flight = 0u32;
    let mut pending = false;
    let mut last_update = Instant::now();
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.tick().await; // the first tick is immediate
    loop {
        let msg = tokio::select! {
            cmd = rx.recv() => match cmd {
                None => break,
                Some(VncCmd::Key { keysym, code, down }) => {
                    if code != 0 && ext_keys.load(Ordering::Relaxed) {
                        qemu_key_event(keysym, code, down)
                    } else {
                        key_event(keysym, down)
                    }
                }
                Some(VncCmd::Pointer { x, y, buttons }) => pointer_event(x, y, buttons),
                Some(VncCmd::CutText(text)) => cut_text(&text),
                Some(VncCmd::UpdateDone { w, h, sent, full }) => {
                    size = (w, h);
                    last_update = Instant::now();
                    if sent {
                        in_flight += 1;
                    }
                    if full {
                        fbu_request(false, 0, 0, w, h)
                    } else if in_flight < MAX_IN_FLIGHT {
                        fbu_request(true, 0, 0, w, h)
                    } else {
                        pending = true;
                        continue;
                    }
                }
                Some(VncCmd::Ack) => {
                    in_flight = in_flight.saturating_sub(1);
                    if !(pending && in_flight < MAX_IN_FLIGHT) {
                        continue;
                    }
                    pending = false;
                    fbu_request(true, 0, 0, size.0, size.1)
                }
            },
            _ = keepalive.tick() => {
                if last_update.elapsed() < KEEPALIVE {
                    continue;
                }
                // A non-incremental request for one pixel always gets an
                // answer, which is all an idle-timeout needs to see.
                fbu_request(false, 0, 0, 1, 1)
            }
        };
        if wr.write_all(&msg).await.is_err() {
            break;
        }
    }
    let _ = wr.shutdown().await;
}

type Reader = BufReader<ReadHalf<BoxStream>>;

/// Read server messages until the connection ends; returns why it ended.
async fn read_loop(
    mut rd: Reader,
    mut w: u16,
    mut h: u16,
    tx: mpsc::UnboundedSender<VncCmd>,
    on_frame: &Channel<InvokeResponseBody>,
    on_event: &Channel<VncEvent>,
    ext_keys: Arc<AtomicBool>,
) -> String {
    let mut zrle = decode::Zrle::new();
    loop {
        let kind = match rd.read_u8().await {
            Ok(k) => k,
            Err(_) => return "connection closed".into(),
        };
        let result = match kind {
            0 => {
                framebuffer_update(&mut rd, &mut zrle, &mut w, &mut h, &tx, on_frame, &ext_keys)
                    .await
            }
            1 => skip_colour_map(&mut rd).await,
            2 => {
                let _ = on_event.send(VncEvent::Bell);
                Ok(())
            }
            3 => read_cut_text(&mut rd).await.map(|text| {
                if let Some(text) = text {
                    let _ = on_event.send(VncEvent::Clipboard { text });
                }
            }),
            other => Err(format!("Server sent an unexpected message ({other})")),
        };
        if let Err(e) = result {
            return e;
        }
    }
}

fn put_u16s(pkt: &mut Vec<u8>, vals: &[u16]) {
    for v in vals {
        pkt.extend_from_slice(&v.to_le_bytes());
    }
}

async fn framebuffer_update(
    rd: &mut Reader,
    zrle: &mut decode::Zrle,
    w: &mut u16,
    h: &mut u16,
    tx: &mpsc::UnboundedSender<VncCmd>,
    on_frame: &Channel<InvokeResponseBody>,
    ext_keys: &AtomicBool,
) -> Result<(), String> {
    let e = |e: std::io::Error| format!("Connection error: {e}");
    let _pad = rd.read_u8().await.map_err(e)?;
    let count = rd.read_u16().await.map_err(e)?;
    let mut pkt = Vec::new();
    let mut resized = false;
    for _ in 0..count {
        let x = rd.read_u16().await.map_err(e)?;
        let y = rd.read_u16().await.map_err(e)?;
        let rw = rd.read_u16().await.map_err(e)?;
        let rh = rd.read_u16().await.map_err(e)?;
        let enc = rd.read_i32().await.map_err(e)?;
        match enc {
            ENC_RAW | ENC_RRE | ENC_HEXTILE | ENC_ZRLE => {
                if x as u32 + rw as u32 > *w as u32 || y as u32 + rh as u32 > *h as u32 {
                    return Err(format!(
                        "Server sent a {rw}×{rh} rectangle at {x},{y} outside the {}×{} screen",
                        w, h
                    ));
                }
                pkt.push(PKT_RECT);
                put_u16s(&mut pkt, &[x, y, rw, rh]);
                let start = pkt.len();
                let (uw, uh) = (rw as usize, rh as usize);
                pkt.resize(start + uw * uh * 4, 0);
                let px = &mut pkt[start..];
                match enc {
                    ENC_RAW => decode::raw(rd, px).await?,
                    ENC_RRE => decode::rre(rd, px, uw).await?,
                    ENC_HEXTILE => decode::hextile(rd, px, uw, uh).await?,
                    _ => {
                        let len = rd.read_u32().await.map_err(e)? as usize;
                        if len > 64 * 1024 * 1024 {
                            return Err("Server sent an implausibly large ZRLE rectangle".into());
                        }
                        let mut compressed = vec![0u8; len];
                        rd.read_exact(&mut compressed).await.map_err(e)?;
                        let data = zrle.inflate(&compressed)?;
                        decode::zrle_tiles(&data, px, uw, uh)?;
                    }
                }
            }
            ENC_COPYRECT => {
                let sx = rd.read_u16().await.map_err(e)?;
                let sy = rd.read_u16().await.map_err(e)?;
                pkt.push(PKT_COPY);
                put_u16s(&mut pkt, &[x, y, rw, rh, sx, sy]);
            }
            ENC_CURSOR => {
                if rw > 512 || rh > 512 {
                    return Err("Server sent an oversized cursor".into());
                }
                let rgba = decode::cursor(rd, rw as usize, rh as usize).await?;
                pkt.push(PKT_CURSOR);
                put_u16s(&mut pkt, &[x, y, rw, rh]);
                pkt.extend_from_slice(&rgba);
            }
            ENC_DESKTOP_SIZE => {
                *w = rw;
                *h = rh;
                resized = true;
                pkt.push(PKT_RESIZE);
                put_u16s(&mut pkt, &[rw, rh]);
            }
            ENC_LAST_RECT => break,
            ENC_QEMU_EXT_KEY => ext_keys.store(true, Ordering::Relaxed),
            other => return Err(format!("Server used an encoding Dshh didn't ask for ({other})")),
        }
    }
    let sent = !pkt.is_empty();
    if sent && on_frame.send(InvokeResponseBody::Raw(pkt)).is_err() {
        return Err("viewer closed".into());
    }
    let _ = tx.send(VncCmd::UpdateDone { w: *w, h: *h, sent, full: resized });
    Ok(())
}

async fn skip_colour_map(rd: &mut Reader) -> Result<(), String> {
    let mut head = [0u8; 5];
    rd.read_exact(&mut head).await.map_err(|e| format!("Connection error: {e}"))?;
    let n = u16::from_be_bytes([head[3], head[4]]) as usize;
    let mut skip = vec![0u8; n * 6];
    rd.read_exact(&mut skip).await.map_err(|e| format!("Connection error: {e}"))?;
    Ok(())
}

/// ServerCutText, decoded as Latin-1. Oversized text is skipped.
async fn read_cut_text(rd: &mut Reader) -> Result<Option<String>, String> {
    let e = |e: std::io::Error| format!("Connection error: {e}");
    let mut pad = [0u8; 3];
    rd.read_exact(&mut pad).await.map_err(e)?;
    let len = rd.read_u32().await.map_err(e)? as usize;
    let mut left = len;
    let mut text = Vec::with_capacity(len.min(1 << 20));
    let mut buf = [0u8; 8192];
    while left > 0 {
        let take = left.min(buf.len());
        rd.read_exact(&mut buf[..take]).await.map_err(e)?;
        if len <= 16 * 1024 * 1024 {
            text.extend_from_slice(&buf[..take]);
        }
        left -= take;
    }
    if len > 16 * 1024 * 1024 {
        return Ok(None);
    }
    Ok(Some(text.iter().map(|&b| b as char).collect()))
}

// ---- Commands ----
//
// The input commands are deliberately synchronous: Tauri runs those on the
// main thread in the order they were invoked, whereas async commands race on
// the runtime's worker threads — and a key-up overtaking its key-down leaves
// the remote with a stuck key.

fn send(state: &State<'_, AppState>, id: &str, cmd: VncCmd) {
    if let Some(s) = state.vnc.blocking_lock().get(id) {
        let _ = s.tx.send(cmd);
    }
}

#[tauri::command]
pub fn vnc_key(id: String, keysym: u32, code: u32, down: bool, state: State<'_, AppState>) {
    send(&state, &id, VncCmd::Key { keysym, code, down });
}

#[tauri::command]
pub fn vnc_pointer(id: String, x: u16, y: u16, buttons: u8, state: State<'_, AppState>) {
    send(&state, &id, VncCmd::Pointer { x, y, buttons });
}

#[tauri::command]
pub fn vnc_clipboard(id: String, text: String, state: State<'_, AppState>) {
    send(&state, &id, VncCmd::CutText(text));
}

#[tauri::command]
pub fn vnc_ack(id: String, state: State<'_, AppState>) {
    send(&state, &id, VncCmd::Ack);
}

/// Longest text "Type clipboard" will key in; beyond this it is almost
/// certainly a mistaken copy, and would take minutes to type.
const MAX_TYPED: usize = 10_000;

/// Type `text` as key presses, paced so a guest's keyboard buffer keeps up.
#[tauri::command]
pub async fn vnc_type(id: String, text: String, state: State<'_, AppState>) -> Result<(), String> {
    let count = text.chars().count();
    if count > MAX_TYPED {
        return Err(format!(
            "That's {count} characters — too long to type (limit {MAX_TYPED})"
        ));
    }
    let Some(tx) = state.vnc.lock().await.get(&id).map(|s| s.tx.clone()) else {
        return Ok(());
    };
    tokio::spawn(async move {
        let mut after_cr = false;
        for c in text.chars() {
            // CRLF is one Enter, not two.
            if c == '\n' && after_cr {
                after_cr = false;
                continue;
            }
            after_cr = c == '\r';
            let (keysym, code, shift) = keys::char_key(c);
            let mut seq = Vec::with_capacity(4);
            if shift {
                seq.push((keys::SHIFT_KEYSYM, keys::SHIFT_SCANCODE, true));
            }
            seq.push((keysym, code, true));
            seq.push((keysym, code, false));
            if shift {
                seq.push((keys::SHIFT_KEYSYM, keys::SHIFT_SCANCODE, false));
            }
            for (keysym, code, down) in seq {
                if tx.send(VncCmd::Key { keysym, code, down }).is_err() {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(12)).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn vnc_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.vnc.lock().await.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_goes_into_the_path_once() {
        assert_eq!(path_with_token("websockify", "abc"), "/websockify?token=abc");
        assert_eq!(path_with_token("/ws?x=1", "a b"), "/ws?x=1&token=a%20b");
        assert_eq!(path_with_token("/websockify?token=zzz", "abc"), "/websockify?token=zzz");
    }

    // ---- Live tests: need the Docker fixtures (x11vnc on 5900, TigerVNC
    // X509Vnc on 5901, websockify wss+token on 6080, sshd on 2222 sharing a
    // network with the x11vnc container as `dshh-vnc`). Run with
    // `cargo test vnc_live -- --ignored`.

    fn live_conn(mode: &str, host: &str, port: u16, password: &str) -> Connection {
        Connection {
            id: "live".into(),
            name: "live".into(),
            protocol: "vnc".into(),
            host: Some(host.into()),
            port: Some(port),
            password: Some(password.into()),
            vnc_mode: Some(mode.into()),
            ..Default::default()
        }
    }

    /// Frame channel that forwards raw packets to a test receiver.
    fn capture() -> (
        Channel<InvokeResponseBody>,
        mpsc::UnboundedReceiver<Vec<u8>>,
        Channel<VncEvent>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let frames = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = tx.send(bytes);
            }
            Ok(())
        });
        (frames, rx, Channel::new(|_| Ok(())))
    }

    /// Total rectangle area in one packet, walking its records.
    fn rect_area(pkt: &[u8]) -> usize {
        let u16_at = |p: usize| u16::from_le_bytes([pkt[p], pkt[p + 1]]) as usize;
        let (mut p, mut area) = (0, 0);
        while p < pkt.len() {
            let tag = pkt[p];
            p += 1;
            match tag {
                PKT_RECT | PKT_CURSOR => {
                    let (w, h) = (u16_at(p + 4), u16_at(p + 6));
                    if tag == PKT_RECT {
                        area += w * h;
                    }
                    p += 8 + w * h * 4;
                }
                PKT_RESIZE => p += 4,
                PKT_COPY => p += 12,
                other => panic!("unknown packet record {other}"),
            }
        }
        area
    }

    /// Wait (acknowledging as the frontend would) until rectangles covering
    /// at least `area` pixels have arrived.
    async fn expect_area(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, s: &VncSession, area: usize) {
        let mut seen = 0;
        while seen < area {
            let pkt = tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .expect("timed out waiting for screen updates")
                .expect("frame channel closed");
            seen += rect_area(&pkt);
            let _ = s.tx.send(VncCmd::Ack);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_live_password_screen_and_typing() {
        let (frames, mut rx, events) = capture();
        let conn = live_conn("direct", "127.0.0.1", 5900, "test123");
        let (s, hello) = start(conn, None, None, frames, events).await.expect("connect");
        assert_eq!((hello.width, hello.height), (800, 600));
        assert_eq!(hello.security, "vnc password");
        expect_area(&mut rx, &s, 800 * 600).await;

        // Point at the xterm and type: the echoed text must come back as a
        // screen update, proving keys reach the remote.
        s.tx.send(VncCmd::Pointer { x: 120, y: 80, buttons: 0 }).unwrap();
        for c in "echo dshh-vnc-ok\r".chars() {
            let (keysym, code, shift) = keys::char_key(c);
            if shift {
                s.tx.send(VncCmd::Key { keysym: keys::SHIFT_KEYSYM, code: 0, down: true }).unwrap();
            }
            s.tx.send(VncCmd::Key { keysym, code, down: true }).unwrap();
            s.tx.send(VncCmd::Key { keysym, code, down: false }).unwrap();
            if shift {
                s.tx.send(VncCmd::Key { keysym: keys::SHIFT_KEYSYM, code: 0, down: false }).unwrap();
            }
        }
        expect_area(&mut rx, &s, 1).await;
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_live_wrong_password_is_auth_failure() {
        let (frames, _rx, events) = capture();
        let conn = live_conn("direct", "127.0.0.1", 5900, "wrong");
        let err = start(conn, None, None, frames, events).await.err().expect("must fail");
        assert!(err.starts_with("Authentication failed"), "{err}");
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_live_console_websocket_with_token() {
        let (frames, mut rx, events) = capture();
        let conn = live_conn("console", "127.0.0.1", 6080, "test123");
        let (s, hello) = start(conn, None, Some("abc123".into()), frames, events)
            .await
            .expect("console connect");
        assert_eq!((hello.width, hello.height), (800, 600));
        expect_area(&mut rx, &s, 800 * 600).await;
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_live_console_bad_token_explains_itself() {
        let (frames, _rx, events) = capture();
        let conn = live_conn("console", "127.0.0.1", 6080, "test123");
        let err = start(conn, None, Some("expired".into()), frames, events)
            .await
            .err()
            .expect("must fail");
        assert_eq!(err, CONSOLE_TOKEN_HINT);
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_live_vencrypt_x509_tls() {
        let (frames, mut rx, events) = capture();
        let conn = live_conn("direct", "127.0.0.1", 5901, "test123");
        let (s, hello) = start(conn, None, None, frames, events).await.expect("connect");
        assert_eq!(hello.security, "vencrypt · tls · vnc password");
        expect_area(&mut rx, &s, hello.width as usize * hello.height as usize).await;
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_live_through_ssh() {
        let via = Connection {
            id: "ssh".into(),
            name: "sshd".into(),
            protocol: "ssh".into(),
            host: Some("127.0.0.1".into()),
            port: Some(2222),
            username: Some("test".into()),
            auth_method: Some("password".into()),
            password: Some("test123".into()),
            ..Default::default()
        };
        let (frames, mut rx, events) = capture();
        // Resolved by the SSH server, on the Docker network.
        let conn = live_conn("direct", "dshh-vnc", 5900, "test123");
        let (s, hello) = start(conn, Some(via), None, frames, events).await.expect("connect");
        assert_eq!((hello.width, hello.height), (800, 600));
        expect_area(&mut rx, &s, 800 * 600).await;
    }

    #[test]
    fn client_messages_have_spec_lengths() {
        assert_eq!(set_pixel_format().len(), 20);
        assert_eq!(fbu_request(true, 0, 0, 10, 10).len(), 10);
        assert_eq!(key_event(0x61, true).len(), 8);
        assert_eq!(qemu_key_event(0x61, 0x1e, true).len(), 12);
        assert_eq!(pointer_event(1, 2, 1).len(), 6);
        assert_eq!(cut_text("hé€"), vec![6, 0, 0, 0, 0, 0, 0, 3, b'h', 0xe9, b'?']);
    }
}
