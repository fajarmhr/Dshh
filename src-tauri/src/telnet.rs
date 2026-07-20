use crate::logs::log_bytes;
use crate::{next_id, AppState, Connection, Logger};
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Minimal telnet client: a TCP byte pipe plus just enough IAC negotiation
/// to satisfy real telnetd servers — we refuse every option the server asks
/// us to enable (WONT) and accept the server echoing / suppressing go-ahead
/// (DO for ECHO and SGA, DONT otherwise). Login stays in-band, so a telnet
/// connection needs no credential fields.

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;

pub struct TelnetSession {
    pub tx: mpsc::UnboundedSender<TelnetCmd>,
    pub logger: Logger,
}

pub enum TelnetCmd {
    Data(Vec<u8>),
    Close,
}

/// Incremental IAC parser. Feeds clean application bytes to `out` and
/// pushes negotiation replies to `replies`. State survives across reads so
/// sequences split over TCP segment boundaries parse correctly.
#[derive(Default)]
struct Negotiator {
    state: NegState,
}

#[derive(Default, PartialEq)]
enum NegState {
    #[default]
    Data,
    Iac,
    Cmd(u8),
    Sub,
    SubIac,
}

impl Negotiator {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>, replies: &mut Vec<u8>) {
        for &b in input {
            match self.state {
                NegState::Data => {
                    if b == IAC {
                        self.state = NegState::Iac;
                    } else {
                        out.push(b);
                    }
                }
                NegState::Iac => match b {
                    IAC => {
                        out.push(IAC);
                        self.state = NegState::Data;
                    }
                    DO | DONT | WILL | WONT => self.state = NegState::Cmd(b),
                    SB => self.state = NegState::Sub,
                    _ => self.state = NegState::Data, // NOP/GA/etc — ignore
                },
                NegState::Cmd(cmd) => {
                    match cmd {
                        // Server asks us to enable an option: refuse them all.
                        DO => replies.extend_from_slice(&[IAC, WONT, b]),
                        // Server offers an option: accept echo + suppress-go-ahead.
                        WILL => {
                            let verb = if b == OPT_ECHO || b == OPT_SGA { DO } else { DONT };
                            replies.extend_from_slice(&[IAC, verb, b]);
                        }
                        _ => {} // DONT / WONT need no reply
                    }
                    self.state = NegState::Data;
                }
                NegState::Sub => {
                    if b == IAC {
                        self.state = NegState::SubIac;
                    }
                }
                NegState::SubIac => {
                    self.state = if b == SE { NegState::Data } else { NegState::Sub };
                }
            }
        }
    }
}

#[tauri::command]
pub async fn telnet_open(
    conn: Connection,
    on_data: Channel<Vec<u8>>,
    on_closed: Channel<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let host = conn.host.clone().ok_or("Missing host")?;
    let port = conn.port.unwrap_or(23);

    let connect_fut = TcpStream::connect((host.as_str(), port));
    let stream = tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut)
        .await
        .map_err(|_| format!("Connection to {host}:{port} timed out"))?
        .map_err(|e| format!("Connect failed: {e}"))?;
    let _ = stream.set_nodelay(true);

    let (tx, mut rx) = mpsc::unbounded_channel::<TelnetCmd>();
    let id = next_id("telnet");
    let logger: Logger = crate::new_logger();
    let logger_task = logger.clone();

    tokio::spawn(async move {
        let (mut reader, mut writer) = stream.into_split();
        let mut neg = Negotiator::default();
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                read = reader.read(&mut buf) => {
                    match read {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut clean = Vec::with_capacity(n);
                            let mut replies = Vec::new();
                            neg.feed(&buf[..n], &mut clean, &mut replies);
                            if !replies.is_empty() && writer.write_all(&replies).await.is_err() {
                                break;
                            }
                            if !clean.is_empty() {
                                log_bytes(&logger_task, &clean);
                                if on_data.send(clean).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(TelnetCmd::Data(d)) => {
                            // Escape literal 0xFF so it isn't read as IAC.
                            let mut escaped = Vec::with_capacity(d.len());
                            for b in d {
                                if b == IAC { escaped.push(IAC); }
                                escaped.push(b);
                            }
                            if writer.write_all(&escaped).await.is_err() {
                                break;
                            }
                        }
                        Some(TelnetCmd::Close) | None => break,
                    }
                }
            }
        }
        let _ = on_closed.send("closed".into());
    });

    state
        .telnet
        .lock()
        .await
        .insert(id.clone(), TelnetSession { tx, logger });
    Ok(id)
}

#[tauri::command]
pub async fn telnet_write(
    id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(s) = state.telnet.lock().await.get(&id) {
        let _ = s.tx.send(TelnetCmd::Data(data.into_bytes()));
    }
    Ok(())
}

#[tauri::command]
pub async fn telnet_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(s) = state.telnet.lock().await.remove(&id) {
        let _ = s.tx.send(TelnetCmd::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Live test against a real telnetd (busybox container on port 2323):
    /// negotiates options, runs a command, and checks the output comes back.
    #[tokio::test]
    #[ignore]
    async fn telnet_live_negotiation_and_echo() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let stream = TcpStream::connect(("127.0.0.1", 2323u16))
            .await
            .expect("connect failed");
        let (mut reader, mut writer) = stream.into_split();
        let mut neg = Negotiator::default();
        let mut collected = String::new();
        let mut sent_cmd = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        let mut buf = [0u8; 4096];
        loop {
            let read = tokio::time::timeout_at(deadline, reader.read(&mut buf)).await;
            let n = match read {
                Ok(Ok(n)) if n > 0 => n,
                _ => break,
            };
            let (mut clean, mut replies) = (Vec::new(), Vec::new());
            neg.feed(&buf[..n], &mut clean, &mut replies);
            if !replies.is_empty() {
                writer.write_all(&replies).await.unwrap();
            }
            collected.push_str(&String::from_utf8_lossy(&clean));
            if !sent_cmd {
                sent_cmd = true;
                writer.write_all(b"echo dshh-telnet-ok\n").await.unwrap();
            }
            if collected.contains("dshh-telnet-ok") {
                return; // round-trip proven
            }
        }
        panic!("telnet round-trip failed; collected: {collected:?}");
    }

    #[test]
    fn negotiation_and_data_split_across_reads() {
        let mut neg = Negotiator::default();
        let mut out = Vec::new();
        let mut replies = Vec::new();
        // "ab" + IAC DO ECHO split across two feeds + IAC IAC literal + "c"
        neg.feed(&[b'a', b'b', IAC], &mut out, &mut replies);
        neg.feed(&[DO, OPT_ECHO, IAC, IAC, b'c'], &mut out, &mut replies);
        assert_eq!(out, vec![b'a', b'b', IAC, b'c']);
        assert_eq!(replies, vec![IAC, WONT, OPT_ECHO]);
    }

    #[test]
    fn will_echo_accepted_others_refused() {
        let mut neg = Negotiator::default();
        let (mut out, mut replies) = (Vec::new(), Vec::new());
        neg.feed(&[IAC, WILL, OPT_ECHO, IAC, WILL, 42], &mut out, &mut replies);
        assert_eq!(replies, vec![IAC, DO, OPT_ECHO, IAC, DONT, 42]);
        assert!(out.is_empty());
    }

    #[test]
    fn subnegotiation_skipped() {
        let mut neg = Negotiator::default();
        let (mut out, mut replies) = (Vec::new(), Vec::new());
        neg.feed(&[IAC, SB, 24, 1, IAC, SE, b'x'], &mut out, &mut replies);
        assert_eq!(out, vec![b'x']);
        assert!(replies.is_empty());
    }
}
