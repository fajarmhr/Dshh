//! Server-to-server copy. With a file browser open on server A, copy files
//! between A and another saved server B *on A itself*: Dshh runs the copy on A
//! over an SSH exec channel — OpenSSH's `sftp` client when B speaks SFTP,
//! `curl` when B is FTP — so the bytes flow A ↔ B directly and never pass
//! through this PC. Dshh still lists B from here (that is the side pane) and
//! walks the selection, which is what sizes the progress bar.
//!
//! B's password reaches `sftp` through a PTY prompt and FTP credentials reach
//! `curl` over stdin, so neither shows up in A's process list or on its disk.
//! A key-based B lends its key through agent forwarding for the length of the
//! copy rather than having it copied to A. Everything variable that does go
//! into a command line is single-quoted for A's shell.

use crate::fileops::{join, Target, Tree};
use crate::progress::{Progress, Reporter};
use crate::ssh::{AgentSource, SshHandle};
use crate::{AppState, Connection};
use russh::client::Msg;
use russh::keys::ssh_encoding::Encode;
use russh::keys::ssh_key::private::KeypairData;
use russh::keys::ssh_key::Signature;
use russh::keys::{load_secret_key, HashAlg, PrivateKey};
use russh::{Channel, ChannelMsg, Sig};
use russh_sftp::client::SftpSession;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as IpcChannel;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;

const STOPPED: &str = "Stopped";

/// What a copy got through. An `sftp` batch stops at its first failure and
/// reports it as an error instead, so `failed` is only ever set for FTP, where
/// `curl` carries on to the next file.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub files: u64,
    pub failed: u64,
    pub first_error: Option<String>,
    /// Folders the walk couldn't list; their contents weren't counted.
    pub unreadable: usize,
}

/// Copy `items` between server A (the SFTP session `id`) and server B (`peer`,
/// browsed from here as `peer_id`). `push` sends A's files to B's `dest`;
/// `pull` fetches B's into A's `dest`. `route` overrides where A dials B, for
/// when A sees B at another address than this PC does.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn peer_copy(
    id: String,
    peer: Connection,
    peer_id: String,
    route: Option<String>,
    direction: String,
    items: Vec<Target>,
    dest: String,
    job: String,
    on_progress: IpcChannel<Progress>,
    state: State<'_, AppState>,
) -> Result<CopyReport, String> {
    let push = match direction.as_str() {
        "push" => true,
        "pull" => false,
        other => return Err(format!("Unknown copy direction \"{other}\"")),
    };
    let req = CopyRequest { id, peer, peer_id, route, push, items, dest, job };
    copy_between(&state, req, on_progress).await
}

/// [`peer_copy`]'s arguments, past the Tauri boundary.
struct CopyRequest {
    id: String,
    peer: Connection,
    peer_id: String,
    route: Option<String>,
    push: bool,
    items: Vec<Target>,
    dest: String,
    job: String,
}

async fn copy_between(
    state: &AppState,
    req: CopyRequest,
    on_progress: IpcChannel<Progress>,
) -> Result<CopyReport, String> {
    let CopyRequest { id, peer, peer_id, route, push, items, dest, job } = req;
    if items.is_empty() {
        return Ok(CopyReport::default());
    }
    let (a_sftp, a) = {
        let map = state.sftp.lock().await;
        let c = map.get(&id).ok_or("SFTP session not found")?;
        (c.sftp.clone(), c.handle.clone())
    };
    let ftp_peer = peer.protocol == "ftp";
    let (host, port) = route_of(&peer, route.as_deref(), ftp_peer)?;

    let cancel = Arc::new(Notify::new());
    state.peer_jobs.lock().await.insert(job.clone(), cancel.clone());
    let result = async {
        // The source side's tree: what gets copied, and how big it all is.
        let tree = if push {
            crate::sftp::walk(&a_sftp, &items).await?
        } else if ftp_peer {
            let targets = items.clone();
            crate::ftp::with_ftp(state, &peer_id, move |f| crate::ftp::walk(f, &targets)).await?
        } else {
            let b = peer_sftp(state, &peer_id).await?;
            crate::sftp::walk(&b, &items).await?
        };
        let total = tree.entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
        let mut reporter = Reporter::new(on_progress, total);
        probe(&a, if ftp_peer { "curl" } else { "sftp" }, &cancel).await?;
        let copy = Copy {
            a: &a,
            a_sftp: &a_sftp,
            peer: &peer,
            host: &host,
            port,
            push,
            items: &items,
            dest: &dest,
            tree: &tree,
            cancel: &cancel,
        };
        let mut report = if ftp_peer {
            copy.curl(state, &peer_id, &mut reporter).await?
        } else {
            copy.sftp(&job, &mut reporter).await?
        };
        if report.failed == 0 {
            reporter.set(total);
        }
        reporter.finish();
        report.unreadable = tree.unreadable.len();
        Ok(report)
    }
    .await;
    state.peer_jobs.lock().await.remove(&job);
    result
}

/// Stop a running copy: the command on A is hung up on, which ends it there.
#[tauri::command]
pub async fn peer_cancel(job: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(stop) = state.peer_jobs.lock().await.get(&job) {
        stop.notify_one();
    }
    Ok(())
}

async fn peer_sftp(state: &AppState, id: &str) -> Result<Arc<SftpSession>, String> {
    state
        .sftp
        .lock()
        .await
        .get(id)
        .map(|c| c.sftp.clone())
        .ok_or_else(|| "Server B's SFTP session not found".into())
}

/// Where A should dial B: the override when one is set (`host`, `host:port`,
/// `[v6]:port`), else B's own address. The host ends up in a shell command and
/// a URL, so it is held to host-name characters.
fn route_of(peer: &Connection, route: Option<&str>, ftp: bool) -> Result<(String, u16), String> {
    let default_port = peer.port.unwrap_or(if ftp { 21 } else { 22 });
    let port_of = |p: &str| p.parse::<u16>().map_err(|_| format!("Bad port \"{p}\""));
    let (host, port) = match route.map(str::trim).filter(|r| !r.is_empty()) {
        None => (peer.host.clone().unwrap_or_default().trim().to_string(), default_port),
        Some(r) => {
            if let Some(rest) = r.strip_prefix('[') {
                let (h, tail) = rest.split_once(']').ok_or("Missing ] in the address")?;
                match tail.strip_prefix(':') {
                    Some(p) => (h.to_string(), port_of(p)?),
                    None if tail.is_empty() => (h.to_string(), default_port),
                    None => return Err(format!("Bad address \"{r}\"")),
                }
            } else {
                match r.rsplit_once(':') {
                    // One colon is host:port; more is a bare IPv6 address.
                    Some((h, p)) if !h.contains(':') => (h.to_string(), port_of(p)?),
                    _ => (r.to_string(), default_port),
                }
            }
        }
    };
    if host.is_empty() {
        return Err("Server B has no host address".into());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'))
    {
        return Err(format!("\"{host}\" isn't a host name or IP address"));
    }
    Ok((host, port))
}

// ---- Running commands on A ----

/// What the output watcher wants done after a chunk of output.
enum Reply {
    Nothing,
    Send(Vec<u8>),
    Abort(String),
}

#[derive(Default)]
struct RunOpts {
    /// A terminal, so `sftp` prompts on it and draws its progress meter.
    pty: bool,
    /// Ask A to forward the agent to this command.
    agent: bool,
    /// Written to the command's stdin, followed by EOF.
    stdin: Option<Vec<u8>>,
}

/// Run `cmd` on A, feeding everything it prints to `on_data` (`true` for
/// stderr). Returns the exit code — `None` when A never sent one.
async fn run_on_a(
    a: &SshHandle,
    cmd: &str,
    opts: RunOpts,
    cancel: &Notify,
    mut on_data: impl FnMut(bool, &[u8]) -> Reply,
) -> Result<Option<u32>, String> {
    let mut ch = a
        .channel_open_session()
        .await
        .map_err(|e| format!("Server A refused to run a command: {e}"))?;
    if opts.pty {
        // Wide, so the progress meter has room for the whole path.
        ch.request_pty(false, "vt100", 250, 40, 0, 0, &[])
            .await
            .map_err(|e| e.to_string())?;
    }
    if opts.agent {
        ch.agent_forward(false).await.map_err(|e| e.to_string())?;
    }
    ch.exec(true, cmd).await.map_err(|e| e.to_string())?;
    if let Some(input) = opts.stdin {
        ch.data(&input[..]).await.map_err(|e| e.to_string())?;
        ch.eof().await.map_err(|e| e.to_string())?;
    }
    let mut code = None;
    loop {
        let msg = tokio::select! {
            m = ch.wait() => m,
            _ = cancel.notified() => {
                hang_up(&ch).await;
                return Err(STOPPED.into());
            }
        };
        let reply = match msg {
            Some(ChannelMsg::Data { data }) => on_data(false, &data),
            Some(ChannelMsg::ExtendedData { data, .. }) => on_data(true, &data),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                code = Some(exit_status);
                Reply::Nothing
            }
            Some(ChannelMsg::ExitSignal { .. }) => {
                code.get_or_insert(255);
                Reply::Nothing
            }
            Some(ChannelMsg::Close) | None => break,
            Some(_) => Reply::Nothing,
        };
        match reply {
            Reply::Nothing => {}
            Reply::Send(bytes) => ch.data(&bytes[..]).await.map_err(|e| e.to_string())?,
            Reply::Abort(e) => {
                hang_up(&ch).await;
                return Err(e);
            }
        }
    }
    Ok(code)
}

/// End a command on A. Closing a PTY channel hangs up its terminal, which is
/// what reliably stops `sftp`; the signal covers the PTY-less `curl`, on
/// servers new enough to honour one.
async fn hang_up(ch: &Channel<Msg>) {
    let _ = ch.signal(Sig::TERM).await;
    let _ = ch.eof().await;
    let _ = ch.close().await;
}

/// Check that A will run commands and has the client this copy needs. An
/// SFTP-only account (`ForceCommand internal-sftp`) answers any command with
/// a silent SFTP server, so the giveaway is our marker never coming back.
async fn probe(a: &SshHandle, tool: &str, cancel: &Notify) -> Result<(), String> {
    let mut out = Vec::new();
    let cmd = format!("echo dshh-probe; command -v {tool}");
    let run = run_on_a(
        a,
        &cmd,
        RunOpts::default(),
        cancel,
        |_, d| {
            out.extend_from_slice(d);
            Reply::Nothing
        },
    );
    let refused = "Server A won't run commands (an SFTP-only account?), and the copy runs on A";
    let code = tokio::time::timeout(Duration::from_secs(15), run)
        .await
        .map_err(|_| refused.to_string())??;
    let text = String::from_utf8_lossy(&out);
    if !text.contains("dshh-probe") {
        return Err(refused.into());
    }
    let found = text.lines().any(|l| l.contains(tool));
    if code != Some(0) || !found {
        return Err(match tool {
            "sftp" => "Server A has no `sftp` client — install OpenSSH's client there (openssh-clients)".into(),
            _ => format!("Server A has no `{tool}` — install it there to copy to and from FTP servers"),
        });
    }
    Ok(())
}

/// Single-quote for A's POSIX shell.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn base_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// Where `path`, found under one of the selected `items`, lands in `dest`.
fn dest_for(items: &[Target], dest: &str, path: &str) -> Option<String> {
    items.iter().find_map(|t| {
        let rest = path.strip_prefix(t.path.as_str())?;
        (rest.is_empty() || rest.starts_with('/'))
            .then(|| format!("{}{rest}", join(dest, base_name(&t.path))))
    })
}

/// Everything one copy needs, so the two drivers share a signature.
struct Copy<'a> {
    a: &'a SshHandle,
    a_sftp: &'a SftpSession,
    peer: &'a Connection,
    host: &'a str,
    port: u16,
    push: bool,
    items: &'a [Target],
    dest: &'a str,
    tree: &'a Tree,
    cancel: &'a Notify,
}

// ---- SFTP/SSH B: OpenSSH's `sftp` on A ----

impl Copy<'_> {
    async fn sftp(&self, job: &str, reporter: &mut Reporter) -> Result<CopyReport, String> {
        let user = self.peer.username.clone().unwrap_or_default();
        let user = user.trim();
        if user.is_empty() {
            return Err("Server B has no username saved".into());
        }
        let (agent, password) = match self.peer.auth_method.as_deref().unwrap_or("password") {
            "key" => {
                let path = self.peer.private_key_path.clone().ok_or("Server B has no key file set")?;
                let key = load_secret_key(&path, self.peer.passphrase.as_deref())
                    .map_err(|e| format!("Server B's key: {e}"))?;
                (Some(AgentSource::Key(Arc::new(key))), None)
            }
            "agent" => (Some(AgentSource::Local), None),
            _ => (None, Some(self.peer.password.clone().unwrap_or_default())),
        };

        let verb = if self.push { "put" } else { "get" };
        let mut batch = String::from("progress\n");
        for t in self.items {
            let target = join(self.dest, base_name(&t.path));
            batch += &format!("{verb} -r {} {}\n", batch_arg(&t.path, true), batch_arg(&target, false));
        }
        let batch_path = write_batch(self.a_sftp, job, &batch).await?;

        // A password goes in at the prompt, so A's own keys stay out of it;
        // a key comes from the forwarded agent, so no password is tried.
        let auth = if password.is_some() {
            "-o PreferredAuthentications=keyboard-interactive,password -o PubkeyAuthentication=no"
        } else {
            "-o PreferredAuthentications=publickey"
        };
        // `BatchMode=no` has to precede `-b`, which otherwise turns prompting
        // (and with it password logins) off; ssh keeps an option's first value.
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.to_string() };
        let cmd = format!(
            "sftp -o BatchMode=no -o ConnectTimeout=15 -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR {auth} -o {} -P {} -b {} {}",
            sq(&format!("User={user}")),
            self.port,
            sq(&batch_path),
            sq(&host),
        );

        let lend = agent.is_some();
        if let Some(source) = agent {
            *self.a.agent.lock().map_err(|e| e.to_string())? = Some(source);
        }
        let mut watch = SftpWatch::new(password, lend);
        let result = run_on_a(
            self.a,
            &cmd,
            RunOpts { pty: true, agent: lend, stdin: None },
            self.cancel,
            |_, data| watch.feed(data, reporter),
        )
        .await;
        if let Ok(mut slot) = self.a.agent.lock() {
            *slot = None;
        }
        let _ = self.a_sftp.remove_file(&batch_path).await;

        match result? {
            Some(0) => Ok(CopyReport {
                files: self.tree.entries.iter().filter(|e| !e.is_dir).count() as u64,
                ..Default::default()
            }),
            code => Err(watch.failure(code)),
        }
    }
}

/// One path as an `sftp` batch argument: double-quoted, with `\` and `"`
/// escaped. `get` and `put` expand their source as a pattern, and sftp only
/// honours a glob escape outside quotes, so in a source each `*`, `?` and `[`
/// steps out of the quotes to be escaped: `"a"\*"b"`. (Checked against
/// OpenSSH 9's sftp, in both directions.)
fn batch_arg(path: &str, glob: bool) -> String {
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '\\' | '"' => {
                out.push('\\');
                out.push(c);
            }
            '*' | '?' | '[' if glob => {
                out.push_str("\"\\");
                out.push(c);
                out.push('"');
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The batch goes into a file on A — `sftp` reads its password from the
/// terminal, so stdin can't carry both. `/tmp` first, A's home if that fails.
async fn write_batch(sftp: &SftpSession, job: &str, body: &str) -> Result<String, String> {
    let tag: String = job.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect();
    let name = format!(".dshh-copy-{tag}.batch");
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| ".".into());
    let mut last = String::new();
    for dir in ["/tmp", home.as_str()] {
        let path = join(dir, &name);
        match sftp.create(&path).await {
            Ok(mut f) => {
                f.write_all(body.as_bytes()).await.map_err(|e| e.to_string())?;
                f.shutdown().await.map_err(|e| e.to_string())?;
                return Ok(path);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Couldn't write the copy's command file on server A: {last}"))
}

/// Reads what `sftp` prints on A's terminal: answers its prompts, moves the
/// progress bar, and keeps the last lines for an error message.
struct SftpWatch {
    password: Option<String>,
    sent_password: bool,
    lent_agent: bool,
    /// Output since the last line end — the meter's newest update, or a
    /// prompt waiting on an answer.
    pending: String,
    lines: VecDeque<String>,
    meter: Meter,
}

impl SftpWatch {
    fn new(password: Option<String>, lent_agent: bool) -> Self {
        Self {
            password,
            sent_password: false,
            lent_agent,
            pending: String::new(),
            lines: VecDeque::new(),
            meter: Meter::default(),
        }
    }

    fn feed(&mut self, data: &[u8], reporter: &mut Reporter) -> Reply {
        self.pending.push_str(&String::from_utf8_lossy(data));
        // The meter redraws with a leading \r and ends a file with \n, so
        // every \r- or \n-terminated piece is one complete update or line.
        while let Some(i) = self.pending.find(['\r', '\n']) {
            let piece: String = self.pending.drain(..=i).collect();
            let piece = piece.trim_end_matches(['\r', '\n']);
            if let Some(m) = parse_meter(piece) {
                self.meter.update(m, reporter);
            } else if !piece.trim().is_empty() {
                self.lines.push_back(piece.trim().to_string());
                if self.lines.len() > 30 {
                    self.lines.pop_front();
                }
            }
        }

        let tail = self.pending.trim_end().to_ascii_lowercase();
        if tail.is_empty() {
            return Reply::Nothing;
        }
        // First contact with B: accept its host key, as Dshh does for its own
        // connections. A changed key is refused by ssh before it asks.
        if tail.contains("(yes/no") {
            self.pending.clear();
            return Reply::Send(b"yes\n".to_vec());
        }
        // One of A's own keys wants unlocking: skip it, ours is in the agent.
        if tail.contains("enter passphrase for") {
            self.pending.clear();
            return Reply::Send(b"\n".to_vec());
        }
        if tail.ends_with(':') && tail.contains("password") {
            self.pending.clear();
            return match (&self.password, self.sent_password) {
                (Some(p), false) => {
                    self.sent_password = true;
                    Reply::Send(format!("{p}\n").into_bytes())
                }
                (Some(_), true) => Reply::Abort("Server B rejected the password".into()),
                (None, _) => Reply::Abort(
                    "Server B asked for a password — it didn't accept the key forwarded from Dshh".into(),
                ),
            };
        }
        if let Some(m) = parse_meter(&self.pending) {
            self.meter.update(m, reporter);
        }
        Reply::Nothing
    }

    /// Why a copy ended badly, from the last things `sftp` said.
    fn failure(&self, code: Option<u32>) -> String {
        let said: Vec<&str> = self
            .lines
            .iter()
            .map(String::as_str)
            .filter(|l| {
                !(l.starts_with("sftp>")
                    || l.starts_with("Fetching ")
                    || l.starts_with("Uploading ")
                    || l.starts_with("Entering ")
                    || l.starts_with("Progress meter")
                    || l.starts_with("Connected to "))
            })
            .collect();
        let tail = said[said.len().saturating_sub(3)..].join(" · ");
        let mut msg = if tail.is_empty() {
            match code {
                Some(c) => format!("sftp on server A exited with code {c}"),
                None => "sftp on server A ended without saying why".into(),
            }
        } else {
            tail
        };
        if msg.contains("Permission denied") {
            // ssh is only asked for one password, so it gives up rather than
            // prompting again: a refusal after ours went in is the password.
            if self.sent_password {
                return "Server B rejected the password".into();
            }
            if self.lent_agent {
                msg += " — server A may not allow agent forwarding (AllowAgentForwarding), or B doesn't accept this key";
            }
        }
        msg
    }
}

/// Where the copy is, from the meter lines: bytes of files already finished
/// plus how far into the current one.
#[derive(Default)]
struct Meter {
    finished: u64,
    name: String,
    bytes: u64,
    pct: u32,
}

impl Meter {
    fn update(&mut self, (name, pct, bytes): (String, u32, u64), reporter: &mut Reporter) {
        // A new name, or the same one starting over, is the next file.
        if name != self.name || pct < self.pct {
            self.finished += self.bytes;
            self.name = name;
        }
        self.bytes = bytes;
        self.pct = pct;
        reporter.set(self.finished + self.bytes);
    }
}

/// `name   45%   46MB  11.4MB/s   00:05 ETA` → (name, 45, 46 MiB).
fn parse_meter(line: &str) -> Option<(String, u32, u64)> {
    let at = line.rfind('%')?;
    let head = &line[..at];
    let digits = head.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if digits == head.len() || !head[..digits].ends_with(' ') {
        return None;
    }
    let pct: u32 = head[digits..].parse().ok()?;
    if pct > 100 {
        return None;
    }
    let rest = line[at + 1..].trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
    let num: f64 = rest[..end].parse().ok()?;
    let scale: f64 = match rest[end..].trim_start().chars().next()? {
        'B' => 1.0,
        'K' => 1024.0,
        'M' => 1024.0 * 1024.0,
        'G' => 1024.0 * 1024.0 * 1024.0,
        'T' => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((head[..digits].trim().to_string(), pct, (num * scale) as u64))
}

// ---- FTP B: `curl` on A ----

impl Copy<'_> {
    async fn curl(
        &self,
        state: &AppState,
        peer_id: &str,
        reporter: &mut Reporter,
    ) -> Result<CopyReport, String> {
        let dirs: Vec<String> = self
            .tree
            .entries
            .iter()
            .filter(|e| e.is_dir && !e.link)
            .filter_map(|e| dest_for(self.items, self.dest, &e.path))
            .collect();
        let files: Vec<(String, String, u64)> = self
            .tree
            .entries
            .iter()
            .filter(|e| !e.is_dir)
            .filter_map(|e| Some((e.path.clone(), dest_for(self.items, self.dest, &e.path)?, e.size)))
            .collect();

        // Folders first, so empty ones arrive too — curl only makes the
        // folders a file needs. Created from here, over the sessions Dshh
        // already holds; one that exists already is fine.
        if self.push {
            let made = dirs.clone();
            crate::ftp::with_ftp(state, peer_id, move |ftp| {
                for d in &made {
                    let _ = ftp.mkdir(d);
                }
                Ok(())
            })
            .await?;
        } else {
            for d in &dirs {
                let _ = self.a_sftp.create_dir(d.as_str()).await;
            }
        }
        if files.is_empty() {
            return Ok(CopyReport::default());
        }

        let user = self.peer.username.clone().filter(|u| !u.trim().is_empty());
        let user = user.unwrap_or_else(|| "anonymous".into());
        let pass = self.peer.password.clone().unwrap_or_default();
        // Credentials and paths travel as a config on stdin: nothing in A's
        // process list, no quoting through A's shell.
        // (A write-out starting with `@` would name a file to read it from.)
        let mut cfg = format!(
            "user = {}\ngloboff\nprogress-bar\nwrite-out = \"{DONE}\\n\"\n",
            cq(&format!("{user}:{pass}"))
        );
        for (src, dst, _) in &files {
            if self.push {
                cfg += &format!("upload-file = {}\nurl = {}\n", cq(src), cq(&ftp_url(self.host, self.port, dst)));
            } else {
                cfg += &format!("url = {}\noutput = {}\n", cq(&ftp_url(self.host, self.port, src)), cq(dst));
            }
        }

        let mut watch = CurlWatch::new(files.iter().map(|f| f.2).collect());
        let code = run_on_a(
            self.a,
            "curl -q -K -",
            RunOpts { pty: false, agent: false, stdin: Some(cfg.into_bytes()) },
            self.cancel,
            |stderr, data| {
                watch.feed(stderr, data, reporter);
                Reply::Nothing
            },
        )
        .await?;
        watch.flush();

        let failed = watch.errors.len() as u64;
        if code != Some(0) && failed == 0 {
            let said = watch.said.iter().map(String::as_str).collect::<Vec<_>>().join(" · ");
            return Err(match code {
                Some(127) => "Server A has no `curl` — install it there to copy to and from FTP servers".into(),
                _ if !said.is_empty() => said,
                Some(c) => format!("curl on server A exited with code {c}"),
                None => "curl on server A ended without saying why".into(),
            });
        }
        Ok(CopyReport {
            files: (files.len() as u64).saturating_sub(failed),
            failed,
            first_error: watch.errors.first().cloned(),
            unreadable: 0,
        })
    }
}

/// A quoted value in a curl config file.
fn cq(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `ftp://host:port/%2F<path>`. The encoded leading slash makes the path
/// absolute, as Dshh's listings are; a plain one would be taken from the login
/// folder.
fn ftp_url(host: &str, port: u16, path: &str) -> String {
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    let mut url = format!("ftp://{host}:{port}/%2F");
    for (i, seg) in path.trim_start_matches('/').split('/').enumerate() {
        if i > 0 {
            url.push('/');
        }
        for b in seg.bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                url.push(b as char);
            } else {
                url += &format!("%{b:02X}");
            }
        }
    }
    url
}

/// Printed by curl after each transfer (its `write-out`).
const DONE: &str = "dshh:done";

/// Reads curl's output: [`DONE`] on stdout after each transfer, its progress
/// bar and `curl: (N) …` errors on stderr.
struct CurlWatch {
    sizes: Vec<u64>,
    finished: usize,
    finished_bytes: u64,
    out: String,
    err: String,
    /// One per failed transfer.
    errors: Vec<String>,
    /// Anything else curl said, for when it fails before any transfer.
    said: VecDeque<String>,
}

impl CurlWatch {
    fn new(sizes: Vec<u64>) -> Self {
        Self {
            sizes,
            finished: 0,
            finished_bytes: 0,
            out: String::new(),
            err: String::new(),
            errors: Vec::new(),
            said: VecDeque::new(),
        }
    }

    fn feed(&mut self, stderr: bool, data: &[u8], reporter: &mut Reporter) {
        let text = String::from_utf8_lossy(data);
        if !stderr {
            self.out.push_str(&text);
            while let Some(i) = self.out.find('\n') {
                let line: String = self.out.drain(..=i).collect();
                if line.trim_end() == DONE {
                    self.finished_bytes += self.sizes.get(self.finished).copied().unwrap_or(0);
                    self.finished += 1;
                }
            }
            reporter.set(self.finished_bytes);
            return;
        }
        self.err.push_str(&text);
        while let Some(i) = self.err.find(['\r', '\n']) {
            let piece: String = self.err.drain(..=i).collect();
            let piece = piece.trim();
            // An error can land on the end of the bar's line.
            if let Some(at) = piece.find("curl: (") {
                self.errors.push(piece[at..].to_string());
            } else if let Some(pct) = bar_percent(piece) {
                self.progress(pct, reporter);
            } else if !piece.is_empty() && !piece.starts_with('#') {
                self.said.push_back(piece.to_string());
                if self.said.len() > 3 {
                    self.said.pop_front();
                }
            }
        }
        if let Some(pct) = bar_percent(&self.err) {
            self.progress(pct, reporter);
        }
    }

    fn progress(&self, pct: f64, reporter: &mut Reporter) {
        let current = self.sizes.get(self.finished).copied().unwrap_or(0) as f64;
        reporter.set(self.finished_bytes + (current * pct / 100.0) as u64);
    }

    /// An error printed without a final line end.
    fn flush(&mut self) {
        let rest = std::mem::take(&mut self.err);
        if let Some(at) = rest.find("curl: (") {
            self.errors.push(rest[at..].trim().to_string());
        }
    }
}

/// `######              45.6%` → 45.6.
fn bar_percent(piece: &str) -> Option<f64> {
    let at = piece.rfind('%')?;
    let head = &piece[..at];
    let start = head.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.').len();
    head[start..].parse().ok().filter(|p| (0.0..=100.0).contains(p))
}

// ---- Agent forwarding ----

const AGENT_FAILURE: u8 = 5;
const AGENTC_REQUEST_IDENTITIES: u8 = 11;
const AGENT_IDENTITIES_ANSWER: u8 = 12;
const AGENTC_SIGN_REQUEST: u8 = 13;
const AGENT_SIGN_RESPONSE: u8 = 14;
const AGENT_RSA_SHA2_256: u32 = 2;
const AGENT_RSA_SHA2_512: u32 = 4;

/// Answer one forwarded agent channel. A key file is served by a minimal
/// agent of our own — list the key, sign with it — honouring the RSA SHA-2
/// flags (russh's bundled agent signs RSA with SHA-1 only, which current
/// servers refuse). The local agent is simply relayed.
pub async fn serve_agent(channel: Channel<Msg>, source: AgentSource) {
    let mut stream = channel.into_stream();
    match source {
        AgentSource::Key(key) => {
            let _ = answer_with_key(&mut stream, &key).await;
        }
        AgentSource::Local => {
            #[cfg(windows)]
            {
                use tokio::net::windows::named_pipe::ClientOptions;
                if let Ok(mut pipe) = ClientOptions::new().open(r"\\.\pipe\openssh-ssh-agent") {
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut pipe).await;
                } else if let Ok(mut pageant) = pageant::PageantStream::new().await {
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut pageant).await;
                }
            }
            #[cfg(not(windows))]
            if let Some(path) = std::env::var_os("SSH_AUTH_SOCK") {
                if let Ok(mut sock) = tokio::net::UnixStream::connect(path).await {
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut sock).await;
                }
            }
        }
    }
}

async fn answer_with_key<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    key: &PrivateKey,
) -> std::io::Result<()> {
    let blob = key
        .public_key()
        .to_bytes()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    loop {
        let len = s.read_u32().await? as usize;
        if len == 0 || len > 256 * 1024 {
            return Ok(());
        }
        let mut msg = vec![0; len];
        s.read_exact(&mut msg).await?;
        let reply = match msg[0] {
            AGENTC_REQUEST_IDENTITIES => {
                let mut r = vec![AGENT_IDENTITIES_ANSWER];
                r.extend_from_slice(&1u32.to_be_bytes());
                put_string(&mut r, &blob);
                put_string(&mut r, b"dshh");
                r
            }
            AGENTC_SIGN_REQUEST => {
                sign_reply(&msg[1..], &blob, key).unwrap_or_else(|| vec![AGENT_FAILURE])
            }
            _ => vec![AGENT_FAILURE],
        };
        s.write_u32(reply.len() as u32).await?;
        s.write_all(&reply).await?;
        s.flush().await?;
    }
}

fn sign_reply(body: &[u8], blob: &[u8], key: &PrivateKey) -> Option<Vec<u8>> {
    let (wanted, rest) = take_string(body)?;
    let (data, rest) = take_string(rest)?;
    let flags = rest.get(..4).map_or(0, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    if wanted != blob {
        return None;
    }
    let hash = if flags & AGENT_RSA_SHA2_512 != 0 {
        Some(HashAlg::Sha512)
    } else if flags & AGENT_RSA_SHA2_256 != 0 {
        Some(HashAlg::Sha256)
    } else {
        None
    };
    use russh::keys::signature::Signer;
    let sig: Signature = match key.key_data() {
        KeypairData::Rsa(rsa) => Signer::try_sign(&(rsa, hash), data).ok()?,
        other => Signer::try_sign(other, data).ok()?,
    };
    let mut r = vec![AGENT_SIGN_RESPONSE];
    put_string(&mut r, &sig.encode_vec().ok()?);
    Some(r)
}

fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

fn take_string(b: &[u8]) -> Option<(&[u8], &[u8])> {
    let len = u32::from_be_bytes(b.get(..4)?.try_into().ok()?) as usize;
    let s = b.get(4..4 + len)?;
    Some((s, &b[4 + len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_sftp_meter() {
        let (name, pct, bytes) =
            parse_meter("/home/test/big.bin                     45%   46MB  11.4MB/s   00:05 ETA").unwrap();
        assert_eq!((name.as_str(), pct, bytes), ("/home/test/big.bin", 45, 46 * 1024 * 1024));
        let (name, pct, _) = parse_meter("file 2.txt 100% 1024KB   1.0MB/s   00:00").unwrap();
        assert_eq!((name.as_str(), pct), ("file 2.txt", 100));
        assert!(parse_meter("sftp> get -r \"/x\" \"/y\"").is_none());
        assert!(parse_meter("Progress meter enabled").is_none());
    }

    #[test]
    fn reads_the_curl_bar() {
        assert_eq!(bar_percent("######################                 35.2%"), Some(35.2));
        assert_eq!(bar_percent("#=#=#"), None);
    }

    #[test]
    fn routes() {
        let peer = Connection { host: Some("10.0.0.5".into()), port: Some(2222), ..Default::default() };
        assert_eq!(route_of(&peer, None, false).unwrap(), ("10.0.0.5".into(), 2222));
        assert_eq!(route_of(&peer, Some("db.internal"), false).unwrap(), ("db.internal".into(), 2222));
        assert_eq!(route_of(&peer, Some("db:22"), false).unwrap(), ("db".into(), 22));
        assert_eq!(route_of(&peer, Some("[fe80::1]:21"), true).unwrap(), ("fe80::1".into(), 21));
        assert_eq!(route_of(&peer, Some("fe80::1"), true).unwrap(), ("fe80::1".into(), 2222));
        assert!(route_of(&peer, Some("host;rm -rf /"), false).is_err());
    }

    #[test]
    fn quotes() {
        assert_eq!(sq("it's"), r"'it'\''s'");
        assert_eq!(batch_arg(r#"/a "b"\x*[1].txt"#, true), r#""/a \"b\"\\x"\*""\["1].txt""#);
        assert_eq!(batch_arg(r#"/a "b"\x*[1].txt"#, false), r#""/a \"b\"\\x*[1].txt""#);
        assert_eq!(cq("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(ftp_url("h", 21, "/srv/a b/ü.txt"), "ftp://h:21/%2Fsrv/a%20b/%C3%BC.txt");
        let items = [Target { path: "/x/dir".into(), is_dir: true, size: 0 }];
        assert_eq!(dest_for(&items, "/y", "/x/dir/sub/f").as_deref(), Some("/y/dir/sub/f"));
        assert_eq!(dest_for(&items, "/y/", "/x/dir").as_deref(), Some("/y/dir"));
        assert_eq!(dest_for(&items, "/y", "/x/dirt"), None);
    }

    // ---- Live: three containers on one Docker network ----
    //   A    127.0.0.1:2222  sshd + sftp client + curl, test/test123
    //   B    127.0.0.1:2223  sshd + sftp-server, test/test123; A reaches it as dshh-peer-b:22
    //   FTP  127.0.0.1:2121  pyftpdlib, test/test123; A reaches it as dshh-peer-ftp:2121
    // Key auth also wants DSHH_PEER_KEYS: comma-separated private key files
    // whose public halves are in B's ~test/.ssh/authorized_keys.
    // Run: cargo test peer_live -- --ignored --test-threads=1 --nocapture

    use crate::ftp::FtpConn;
    use std::sync::Mutex as StdMutex;

    fn ssh_conn(port: u16) -> Connection {
        Connection {
            id: format!("live-{port}"),
            name: format!("live-{port}"),
            protocol: "ssh".into(),
            host: Some("127.0.0.1".into()),
            port: Some(port),
            username: Some("test".into()),
            auth_method: Some("password".into()),
            password: Some("test123".into()),
            ..Default::default()
        }
    }

    /// Progress messages, as the frontend would receive them.
    fn recorder() -> (IpcChannel<Progress>, Arc<StdMutex<Vec<(u64, u64)>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let chan = IpcChannel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap();
                sink.lock().unwrap().push((v["done"].as_u64().unwrap(), v["total"].as_u64().unwrap()));
            }
            Ok(())
        });
        (chan, seen)
    }

    async fn state_with_a_and_b() -> AppState {
        let state = AppState::default();
        let a = crate::sftp::open(&ssh_conn(2222)).await.expect("server A");
        let b = crate::sftp::open(&ssh_conn(2223)).await.expect("server B");
        state.sftp.lock().await.insert("a".into(), a);
        state.sftp.lock().await.insert("b".into(), b);
        state
    }

    async fn sh(state: &AppState, which: &str, cmd: &str) -> String {
        let handle = state.sftp.lock().await.get(which).unwrap().handle.clone();
        let mut out = Vec::new();
        run_on_a(&handle, cmd, RunOpts::default(), &Notify::new(), |_, d| {
            out.extend_from_slice(d);
            Reply::Nothing
        })
        .await
        .unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn req(peer: Connection, peer_id: &str, route: &str, push: bool, items: Vec<Target>, dest: &str) -> CopyRequest {
        CopyRequest {
            id: "a".into(),
            peer,
            peer_id: peer_id.into(),
            route: Some(route.into()),
            push,
            items,
            dest: dest.into(),
            job: format!("job{}", std::process::id()),
        }
    }

    /// Password-auth B, both directions, through names that need every kind
    /// of escaping `sftp` has.
    #[tokio::test]
    #[ignore]
    async fn peer_live_sftp_password() {
        let state = state_with_a_and_b().await;
        let base = format!("/home/test/pl{}", std::process::id());
        let odd = r#"q "x" back\slash*[1].txt"#;
        let made = sh(
            &state,
            "b",
            &format!(
                "mkdir -p {d}/sub {d}/empty && head -c 300000 /dev/urandom > {d}/sub/data.bin && echo hi > {d}/{o} && echo done",
                d = sq(&format!("{base}/tree")),
                o = sq(odd)
            ),
        )
        .await;
        assert!(made.contains("done"), "{made}");
        sh(&state, "a", &format!("mkdir -p {}", sq(&format!("{base}/in")))).await;

        // B → A
        let items = vec![Target { path: format!("{base}/tree"), is_dir: true, size: 0 }];
        let (chan, seen) = recorder();
        let r = copy_between(&state, req(ssh_conn(2223), "b", "dshh-peer-b:22", false, items, &format!("{base}/in")), chan)
            .await
            .expect("pull");
        assert_eq!((r.files, r.failed), (2, 0));
        let listing = sh(&state, "a", &format!("cd {} && find . | sort && md5sum sub/data.bin", sq(&format!("{base}/in/tree")))).await;
        let src_sum = sh(&state, "b", &format!("cd {} && md5sum sub/data.bin", sq(&format!("{base}/tree")))).await;
        assert!(listing.contains("./empty") && listing.contains(odd), "{listing}");
        assert!(listing.contains(src_sum.split_whitespace().next().unwrap()), "{listing} vs {src_sum}");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.last().copied(), Some((300003, 300003)), "{seen:?}");

        // A → B, the odd file alone into another folder
        sh(&state, "b", &format!("mkdir -p {}", sq(&format!("{base}/back")))).await;
        let items = vec![Target { path: format!("{base}/in/tree/{odd}"), is_dir: false, size: 3 }];
        let r = copy_between(&state, req(ssh_conn(2223), "b", "dshh-peer-b:22", true, items, &format!("{base}/back")), recorder().0)
            .await
            .expect("push");
        assert_eq!(r.files, 1);
        let back = sh(&state, "b", &format!("cat {}", sq(&format!("{base}/back/{odd}")))).await;
        assert_eq!(back.trim(), "hi");

        // A wrong password is named as such, not left hanging.
        let mut wrong = ssh_conn(2223);
        wrong.password = Some("nope".into());
        let items = vec![Target { path: format!("{base}/tree/sub"), is_dir: true, size: 0 }];
        let e = copy_between(&state, req(wrong, "b", "dshh-peer-b:22", false, items, &format!("{base}/in")), recorder().0)
            .await
            .unwrap_err();
        assert!(e.contains("rejected the password"), "{e}");

        sh(&state, "a", &format!("rm -rf {}", sq(&base))).await;
        sh(&state, "b", &format!("rm -rf {}", sq(&base))).await;
    }

    /// Key-auth B: the key stays here and A borrows it over agent forwarding.
    /// RSA keys prove the SHA-2 signature flags are honoured.
    #[tokio::test]
    #[ignore]
    async fn peer_live_sftp_key() {
        let Ok(keys) = std::env::var("DSHH_PEER_KEYS") else {
            eprintln!("DSHH_PEER_KEYS not set — skipping");
            return;
        };
        let state = state_with_a_and_b().await;
        let base = format!("/home/test/pk{}", std::process::id());
        sh(&state, "b", &format!("mkdir -p {b} && echo key > {b}/k.txt", b = sq(&base))).await;
        sh(&state, "a", &format!("mkdir -p {}", sq(&base))).await;
        for (i, key) in keys.split(',').enumerate() {
            let mut peer = ssh_conn(2223);
            peer.auth_method = Some("key".into());
            peer.private_key_path = Some(key.to_string());
            peer.password = None;
            let dest = format!("{base}/via{i}");
            sh(&state, "a", &format!("mkdir -p {}", sq(&dest))).await;
            let items = vec![Target { path: format!("{base}/k.txt"), is_dir: false, size: 4 }];
            let r = copy_between(&state, req(peer, "b", "dshh-peer-b:22", false, items, &dest), recorder().0).await;
            assert_eq!(r.map(|r| r.files), Ok(1), "key {key}");
            let got = sh(&state, "a", &format!("cat {}", sq(&format!("{dest}/k.txt")))).await;
            assert_eq!(got.trim(), "key", "key {key}");
        }
        // The slot is emptied afterwards: nothing more is lent.
        let lent = state.sftp.lock().await.get("a").unwrap().handle.agent.lock().unwrap().is_some();
        assert!(!lent);
        sh(&state, "a", &format!("rm -rf {}", sq(&base))).await;
        sh(&state, "b", &format!("rm -rf {}", sq(&base))).await;
    }

    /// Stopping a big copy ends `sftp` on A rather than leaving it running.
    #[tokio::test]
    #[ignore]
    async fn peer_live_cancel() {
        let state = Arc::new(state_with_a_and_b().await);
        let base = format!("/home/test/pc{}", std::process::id());
        sh(&state, "b", &format!("mkdir -p {b} && head -c 1500000000 /dev/zero > {b}/big.bin", b = sq(&base))).await;
        sh(&state, "a", &format!("mkdir -p {}", sq(&base))).await;
        let job = format!("job{}", std::process::id());
        let (chan, seen) = recorder();
        let task = {
            let state = state.clone();
            let items = vec![Target { path: format!("{base}/big.bin"), is_dir: false, size: 1_500_000_000 }];
            let r = req(ssh_conn(2223), "b", "dshh-peer-b:22", false, items, &base);
            tokio::spawn(async move { copy_between(&state, r, chan).await })
        };
        // Wait until bytes are moving, then stop.
        for _ in 0..200 {
            if seen.lock().unwrap().iter().any(|&(done, _)| done > 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(seen.lock().unwrap().iter().any(|&(done, _)| done > 0), "never started");
        state.peer_jobs.lock().await.get(&job).expect("job registered").notify_one();
        let r = task.await.unwrap();
        assert_eq!(r.unwrap_err(), STOPPED);
        assert!(state.peer_jobs.lock().await.is_empty());
        tokio::time::sleep(Duration::from_millis(500)).await;
        let ps = sh(&state, "a", "ps -o args | grep '[s]ftp -o' || echo none").await;
        assert_eq!(ps.trim(), "none", "sftp still running on A: {ps}");
        sh(&state, "a", &format!("rm -rf {}", sq(&base))).await;
        sh(&state, "b", &format!("rm -rf {}", sq(&base))).await;
    }

    /// FTP B through curl on A: folders (an empty one too) both ways, and a
    /// bad password reported per file rather than as a crash.
    #[tokio::test]
    #[ignore]
    async fn peer_live_ftp() {
        let state = AppState::default();
        let a = crate::sftp::open(&ssh_conn(2222)).await.expect("server A");
        state.sftp.lock().await.insert("a".into(), a);
        let mut ftp = suppaftp::FtpStream::connect("127.0.0.1:2121").expect("ftp");
        ftp.login("test", "test123").expect("login");
        let base = format!("/pf{}", std::process::id());
        for d in [base.clone(), format!("{base}/sub"), format!("{base}/empty")] {
            ftp.mkdir(&d).unwrap();
        }
        ftp.put_file(format!("{base}/sub/a b.txt"), &mut std::io::Cursor::new(vec![7u8; 200_000])).unwrap();
        ftp.put_file(format!("{base}/top.txt"), &mut std::io::Cursor::new(b"top")).unwrap();
        state.ftp.lock().await.insert("f".into(), FtpConn { stream: Arc::new(StdMutex::new(ftp)) });

        let peer = Connection {
            protocol: "ftp".into(),
            host: Some("127.0.0.1".into()),
            port: Some(2121),
            username: Some("test".into()),
            password: Some("test123".into()),
            ..Default::default()
        };
        let a_base = format!("/home/test/pf{}", std::process::id());
        sh(&state, "a", &format!("mkdir -p {}", sq(&a_base))).await;

        // B → A
        let items = vec![Target { path: base.clone(), is_dir: true, size: 0 }];
        let (chan, seen) = recorder();
        let r = copy_between(&state, req(peer.clone(), "f", "dshh-peer-ftp:2121", false, items, &a_base), chan)
            .await
            .expect("pull");
        assert_eq!((r.files, r.failed), (2, 0), "{r:?}");
        let name = base.trim_start_matches('/');
        let got = sh(&state, "a", &format!("cd {} && find . -type d | sort && wc -c 'sub/a b.txt'", sq(&format!("{a_base}/{name}")))).await;
        assert!(got.contains("./empty") && got.contains("200000"), "{got}");
        assert_eq!(seen.lock().unwrap().last().copied(), Some((200_003, 200_003)));

        // A → B, into a new folder name
        let items = vec![Target { path: format!("{a_base}/{name}"), is_dir: true, size: 0 }];
        state.ftp.lock().await.get("f").unwrap().stream.lock().unwrap().mkdir(format!("{base}/back")).unwrap();
        let r = copy_between(&state, req(peer.clone(), "f", "dshh-peer-ftp:2121", true, items, &format!("{base}/back")), recorder().0)
            .await
            .expect("push");
        assert_eq!((r.files, r.failed), (2, 0), "{r:?}");
        let back = {
            let conn = state.ftp.lock().await;
            let mut ftp = conn.get("f").unwrap().stream.lock().unwrap();
            let sub = ftp.nlst(Some(&format!("{base}/back/{name}/sub"))).unwrap();
            let top = ftp.nlst(Some(&format!("{base}/back/{name}"))).unwrap();
            format!("{sub:?} {top:?}")
        };
        assert!(back.contains("a b.txt") && back.contains("empty"), "{back}");

        // A wrong password: every file fails, with curl's reason.
        let mut wrong = peer.clone();
        wrong.password = Some("nope".into());
        let items = vec![Target { path: format!("{base}/top.txt"), is_dir: false, size: 3 }];
        let r = copy_between(&state, req(wrong, "f", "dshh-peer-ftp:2121", false, items, &a_base), recorder().0)
            .await
            .expect("report");
        assert_eq!((r.files, r.failed), (0, 1), "{r:?}");
        assert!(r.first_error.as_deref().unwrap_or("").contains("curl: ("), "{r:?}");

        sh(&state, "a", &format!("rm -rf {}", sq(&a_base))).await;
        let conn = state.ftp.lock().await;
        let mut ftp = conn.get("f").unwrap().stream.lock().unwrap();
        let tree = crate::ftp::walk(&mut ftp, &[Target { path: base.clone(), is_dir: true, size: 0 }]).unwrap();
        for e in tree.delete_order() {
            let _ = if e.is_dir { ftp.rmdir(&e.path) } else { ftp.rm(&e.path) };
        }
    }
}
