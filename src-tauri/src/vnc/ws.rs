//! Minimal WebSocket client: just enough to reach a VNC server behind a
//! noVNC/websockify console proxy (OpenStack, Huawei FusionSphere, …).
//!
//! The proxy's own web page (`vnc_auto.html`) is never loaded: we do the same
//! upgrade request its JavaScript would, then hand back a plain byte stream so
//! the RFB code above can't tell a console link from a raw TCP socket.

use super::BoxStream;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;

/// Where the upgrade request goes and what it carries.
pub struct Upgrade<'a> {
    /// `Host` header value: the host, plus `:port` when it isn't the default.
    pub host_header: &'a str,
    /// Request path including its query, e.g. `/websockify?token=…`.
    pub path: &'a str,
    /// Sent as a browser would. nova-novncproxy compares it with `Host`.
    pub origin: &'a str,
    /// Older noVNC hands the token over as a cookie rather than in the path;
    /// sending both satisfies either kind of proxy.
    pub cookie: Option<&'a str>,
}

/// Perform the HTTP upgrade over `stream` and return a byte stream that reads
/// and writes WebSocket message payloads.
pub async fn connect(mut stream: BoxStream, req: Upgrade<'_>) -> Result<BoxStream, String> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| format!("No randomness for WebSocket key: {e}"))?;
    let key = B64.encode(nonce);

    let mut head = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Protocol: binary\r\n\
         Origin: {origin}\r\n\
         User-Agent: Dshh/{ver}\r\n\
         Cache-Control: no-cache\r\n",
        path = req.path,
        host = req.host_header,
        origin = req.origin,
        ver = env!("CARGO_PKG_VERSION"),
    );
    if let Some(cookie) = req.cookie {
        head.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("Console proxy write failed: {e}"))?;

    // Read the response head. The server may pipeline the first WebSocket
    // frame (often the RFB version) into the same segment, so anything past
    // the blank line is kept and fed to the frame parser.
    let mut buf = Vec::with_capacity(1024);
    let end = loop {
        let mut chunk = [0u8; 2048];
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("Console proxy read failed: {e}"))?;
        if n == 0 {
            return Err("Console proxy closed the connection during the WebSocket handshake".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 32 * 1024 {
            return Err("Console proxy sent an oversized HTTP response".into());
        }
    };

    let text = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = text.split("\r\n");
    let status = lines.next().unwrap_or_default().trim().to_string();
    if status.split_whitespace().nth(1) != Some("101") {
        return Err(format!(
            "Console proxy refused the WebSocket upgrade ({status}). \
             Check the console path, or get a fresh link — the token may have expired."
        ));
    }
    let mut accept = None;
    let mut protocol = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "sec-websocket-accept" => accept = Some(v.trim().to_string()),
                "sec-websocket-protocol" => protocol = Some(v.trim().to_ascii_lowercase()),
                _ => {}
            }
        }
    }
    let expected = B64.encode(Sha1::digest(format!("{key}{WS_GUID}").as_bytes()));
    if accept.as_deref() != Some(expected.as_str()) {
        return Err("Console proxy answered with an invalid WebSocket accept key".into());
    }
    // Very old websockify picks base64 text frames when it can't agree on
    // binary; everything current echoes "binary" back.
    let base64_mode = protocol.as_deref() == Some("base64");
    let leftover = buf[end..].to_vec();

    let (app, pump) = tokio::io::duplex(256 * 1024);
    let (net_rd, net_wr) = tokio::io::split(stream);
    let (pump_rd, pump_wr) = tokio::io::split(pump);
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(read_pump(net_rd, pump_wr, ctl_tx, leftover, base64_mode));
    tokio::spawn(write_pump(pump_rd, net_wr, ctl_rx, base64_mode));
    Ok(Box::new(app))
}

/// Network → frames → payload bytes for the RFB reader.
async fn read_pump(
    mut net: tokio::io::ReadHalf<BoxStream>,
    mut out: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    ctl: mpsc::UnboundedSender<Vec<u8>>,
    mut buf: Vec<u8>,
    base64_mode: bool,
) {
    // Opcode of the message a run of continuation frames belongs to.
    let mut message_op = OP_BINARY;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        while let Some((frame, used)) = parse_frame(&buf) {
            buf.drain(..used);
            let op = if frame.opcode == OP_CONT { message_op } else { frame.opcode };
            match op {
                OP_BINARY | OP_TEXT => {
                    if frame.opcode != OP_CONT {
                        message_op = frame.opcode;
                    }
                    let data = if op == OP_TEXT || base64_mode {
                        match B64.decode(frame.payload.trim_ascii()) {
                            Ok(d) => d,
                            Err(_) => return,
                        }
                    } else {
                        frame.payload
                    };
                    if out.write_all(&data).await.is_err() {
                        return;
                    }
                }
                OP_PING => {
                    let _ = ctl.send(encode_frame(0xA, &frame.payload));
                }
                OP_CLOSE => {
                    let _ = ctl.send(encode_frame(OP_CLOSE, &[]));
                    return;
                }
                _ => {} // pong and reserved opcodes
            }
        }
        match net.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// RFB writer bytes → masked frames → network, interleaved with the control
/// replies (pong, close) the read pump asks for.
async fn write_pump(
    mut src: tokio::io::ReadHalf<tokio::io::DuplexStream>,
    mut net: tokio::io::WriteHalf<BoxStream>,
    mut ctl: mpsc::UnboundedReceiver<Vec<u8>>,
    base64_mode: bool,
) {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        tokio::select! {
            read = src.read(&mut chunk) => {
                let n = match read {
                    Ok(0) | Err(_) => {
                        let _ = net.write_all(&encode_frame(OP_CLOSE, &[])).await;
                        let _ = net.shutdown().await;
                        return;
                    }
                    Ok(n) => n,
                };
                let frame = if base64_mode {
                    encode_frame(OP_TEXT, B64.encode(&chunk[..n]).as_bytes())
                } else {
                    encode_frame(OP_BINARY, &chunk[..n])
                };
                if net.write_all(&frame).await.is_err() {
                    return;
                }
            }
            frame = ctl.recv() => {
                let Some(frame) = frame else { return };
                let closing = frame.first().map(|b| b & 0x0f) == Some(OP_CLOSE);
                if net.write_all(&frame).await.is_err() || closing {
                    let _ = net.shutdown().await;
                    return;
                }
            }
        }
    }
}

struct Frame {
    opcode: u8,
    payload: Vec<u8>,
}

/// One complete frame from the front of `buf`, and how many bytes it used.
/// `None` means more bytes are needed.
fn parse_frame(buf: &[u8]) -> Option<(Frame, usize)> {
    if buf.len() < 2 {
        return None;
    }
    let opcode = buf[0] & 0x0f;
    let masked = buf[1] & 0x80 != 0;
    let mut len = (buf[1] & 0x7f) as usize;
    let mut pos = 2;
    if len == 126 {
        if buf.len() < 4 {
            return None;
        }
        len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
        pos = 4;
    } else if len == 127 {
        if buf.len() < 10 {
            return None;
        }
        len = u64::from_be_bytes(buf[2..10].try_into().ok()?) as usize;
        pos = 10;
    }
    let mut mask = [0u8; 4];
    if masked {
        if buf.len() < pos + 4 {
            return None;
        }
        mask.copy_from_slice(&buf[pos..pos + 4]);
        pos += 4;
    }
    if buf.len() < pos + len {
        return None;
    }
    let mut payload = buf[pos..pos + len].to_vec();
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i & 3];
        }
    }
    Some((Frame { opcode, payload }, pos + len))
}

/// A single final frame, masked as RFC 6455 requires of clients.
fn encode_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let len = payload.len();
    let mut out = Vec::with_capacity(len + 14);
    out.push(0x80 | opcode);
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len <= 0xffff {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    let mut mask = [0u8; 4];
    let _ = getrandom::fill(&mut mask);
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_unmasks() {
        for size in [0usize, 5, 125, 126, 300, 70_000] {
            let payload: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let wire = encode_frame(OP_BINARY, &payload);
            let (frame, used) = parse_frame(&wire).expect("complete frame");
            assert_eq!(used, wire.len());
            assert_eq!(frame.opcode, OP_BINARY);
            assert_eq!(frame.payload, payload);
        }
    }

    #[test]
    fn partial_frame_waits_for_more() {
        let wire = encode_frame(OP_BINARY, b"RFB 003.008\n");
        assert!(parse_frame(&wire[..wire.len() - 1]).is_none());
        assert!(parse_frame(&wire[..1]).is_none());
    }

    #[test]
    fn unmasked_server_frame_parses() {
        // Servers send unmasked frames; extended 16-bit length.
        let mut wire = vec![0x82, 126, 0x01, 0x00];
        wire.extend(std::iter::repeat_n(7u8, 256));
        let (frame, used) = parse_frame(&wire).unwrap();
        assert_eq!(used, wire.len());
        assert_eq!(frame.payload.len(), 256);
    }
}
