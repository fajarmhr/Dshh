use std::time::{Duration, Instant};
use tauri::ipc::Channel;

/// Byte counter pushed to the frontend while a file transfer runs, so the
/// browser can draw a real progress bar instead of a spinner.

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    /// Total size in bytes, or 0 when it isn't known up front — an FTP server
    /// that rejects `SIZE`. The frontend draws an indeterminate bar for 0.
    pub total: u64,
}

/// One message per tick at most. A local transfer can move hundreds of
/// megabytes a second; without the limit the IPC channel would carry thousands
/// of messages the UI can't render anyway.
const TICK: Duration = Duration::from_millis(80);

/// Rate-limited progress reporter shared by the SFTP, FTP and SCP transfers.
pub struct Reporter {
    chan: Channel<Progress>,
    total: u64,
    done: u64,
    last: Instant,
}

impl Reporter {
    /// Emits an opening `0 / total` so the bar appears before the first byte
    /// lands — which on a slow link is the part worth showing.
    pub fn new(chan: Channel<Progress>, total: u64) -> Self {
        let mut r = Self {
            chan,
            total,
            done: 0,
            last: Instant::now(),
        };
        r.emit();
        r
    }

    /// Count `n` more transferred bytes.
    pub fn add(&mut self, n: u64) {
        self.done += n;
        if self.last.elapsed() >= TICK {
            self.emit();
        }
    }

    /// Final count, always sent, so the bar lands on 100% rather than wherever
    /// the last tick left it.
    pub fn finish(&mut self) {
        self.emit();
    }

    fn emit(&mut self) {
        self.last = Instant::now();
        // A closed channel (the view was disposed mid-transfer) is not a
        // transfer error: the copy itself is still worth finishing.
        let _ = self.chan.send(Progress {
            done: self.done,
            total: self.total,
        });
    }
}
