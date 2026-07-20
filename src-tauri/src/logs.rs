use crate::{AppState, Logger};
use std::fs::{File, OpenOptions};
use std::io::Write;
use tauri::State;

/// Escape-sequence parser state for [`LogSink`].
enum Esc {
    /// Not inside an escape sequence.
    None,
    /// Saw ESC, waiting for the sequence type byte.
    Start,
    /// Inside a CSI sequence (`ESC [ … final`); collects params/intermediates.
    Csi(Vec<u8>),
    /// Inside a string sequence (OSC/DCS/SOS/PM/APC) terminated by BEL or
    /// ST (`ESC \`). The bool tracks whether the previous byte was ESC.
    Str(bool),
    /// Skip this many raw bytes (charset designators like `ESC ( B`).
    Skip(u8),
}

/// Turns the raw terminal byte stream into readable plain text before it hits
/// the log file. Colours and cursor movement are stripped, line editing
/// (backspace, delete, erase-to-end, `\r` overwrites from progress bars) is
/// applied to an in-memory line buffer, and only completed lines are written —
/// so the log shows what the user finally saw, not every keystroke artifact.
pub struct LogSink {
    file: File,
    /// Partial UTF-8 sequence carried across chunk boundaries.
    utf8: Vec<u8>,
    /// The current, not-yet-terminated line and the cursor position within it.
    line: Vec<char>,
    cursor: usize,
    esc: Esc,
}

impl LogSink {
    pub fn new(file: File) -> Self {
        Self {
            file,
            utf8: Vec::new(),
            line: Vec::new(),
            cursor: 0,
            esc: Esc::None,
        }
    }

    /// Write a pre-formatted marker line (log header) straight to the file.
    pub fn write_marker(&mut self, text: &str) {
        let _ = writeln!(self.file, "{text}");
        let _ = self.file.flush();
    }

    /// Feed raw terminal output. Completed lines are written and flushed.
    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match &mut self.esc {
                Esc::None => self.feed_plain(b),
                Esc::Start => {
                    self.esc = match b {
                        b'[' => Esc::Csi(Vec::new()),
                        b']' | b'P' | b'X' | b'^' | b'_' => Esc::Str(false),
                        b'(' | b')' | b'*' | b'+' | b'#' | b'%' => Esc::Skip(1),
                        _ => Esc::None, // two-byte sequence (ESC 7, ESC M, …)
                    };
                }
                Esc::Csi(buf) => {
                    if (0x20..=0x3f).contains(&b) {
                        if buf.len() < 32 {
                            buf.push(b);
                        }
                    } else {
                        // Final byte (0x40..=0x7e) — or garbage; either way done.
                        let params = std::mem::take(buf);
                        self.esc = Esc::None;
                        if (0x40..=0x7e).contains(&b) {
                            self.apply_csi(&params, b);
                        }
                    }
                }
                Esc::Str(prev_esc) => {
                    if b == 0x07 || (*prev_esc && b == b'\\') {
                        self.esc = Esc::None;
                    } else {
                        *prev_esc = b == 0x1b;
                    }
                }
                Esc::Skip(n) => {
                    *n -= 1;
                    if *n == 0 {
                        self.esc = Esc::None;
                    }
                }
            }
        }
        let _ = self.file.flush();
    }

    fn feed_plain(&mut self, b: u8) {
        match b {
            0x1b => {
                self.utf8.clear(); // ESC can't appear mid-codepoint
                self.esc = Esc::Start;
            }
            b'\n' => self.end_line(),
            b'\r' => self.cursor = 0, // next chars overwrite (progress bars)
            0x08 => self.cursor = self.cursor.saturating_sub(1), // backspace
            b'\t' => self.put_char('\t'),
            0x00..=0x1f | 0x7f => {} // BEL and friends — drop
            _ => {
                self.utf8.push(b);
                let expected = match self.utf8[0] {
                    0x00..=0x7f => 1,
                    0xc0..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf7 => 4,
                    _ => 0, // stray continuation byte
                };
                if expected == 0 {
                    self.utf8.clear();
                    self.put_char('\u{fffd}');
                } else if self.utf8.len() >= expected {
                    match std::str::from_utf8(&self.utf8) {
                        Ok(s) => {
                            if let Some(c) = s.chars().next() {
                                self.put_char(c);
                            }
                        }
                        Err(_) => self.put_char('\u{fffd}'),
                    }
                    self.utf8.clear();
                }
            }
        }
    }

    /// Place a char at the cursor, overwriting like a real terminal does.
    fn put_char(&mut self, c: char) {
        if self.cursor < self.line.len() {
            self.line[self.cursor] = c;
        } else {
            while self.line.len() < self.cursor {
                self.line.push(' ');
            }
            self.line.push(c);
        }
        self.cursor += 1;
    }

    fn end_line(&mut self) {
        let s: String = self.line.iter().collect();
        let _ = writeln!(self.file, "{}", s.trim_end());
        self.line.clear();
        self.cursor = 0;
    }

    fn apply_csi(&mut self, params: &[u8], final_byte: u8) {
        let nums: Vec<usize> = std::str::from_utf8(params)
            .unwrap_or("")
            .split(';')
            .map(|p| {
                p.trim_matches(|c: char| !c.is_ascii_digit())
                    .parse()
                    .unwrap_or(0)
            })
            .collect();
        let n0 = nums.first().copied().unwrap_or(0);
        let n = n0.max(1);
        match final_byte {
            // Erase in line: 0 = cursor→end, 1 = start→cursor, 2 = whole line.
            b'K' => match n0 {
                0 => {
                    let end = self.cursor.min(self.line.len());
                    self.line.truncate(end);
                }
                1 => {
                    let end = self.cursor.min(self.line.len());
                    self.line[..end].fill(' ');
                }
                2 => self.line.clear(),
                _ => {}
            },
            // Delete n characters at the cursor (what the Delete key echoes).
            b'P' => {
                for _ in 0..n {
                    if self.cursor < self.line.len() {
                        self.line.remove(self.cursor);
                    }
                }
            }
            // Insert n blanks at the cursor.
            b'@' => {
                if self.cursor <= self.line.len() {
                    for _ in 0..n {
                        self.line.insert(self.cursor, ' ');
                    }
                }
            }
            b'C' => self.cursor += n, // cursor right
            b'D' => self.cursor = self.cursor.saturating_sub(n), // cursor left
            b'G' => self.cursor = n - 1, // cursor to absolute column
            // Cursor position: only the column is meaningful line-wise.
            b'H' | b'f' => self.cursor = nums.get(1).copied().unwrap_or(1).max(1) - 1,
            // Colours, modes, vertical movement, scroll regions: stripped.
            _ => {}
        }
    }

    /// Flush anything still buffered (the in-progress prompt line). Idempotent.
    pub fn finish(&mut self) {
        if !self.line.is_empty() {
            self.end_line();
        }
        let _ = self.file.flush();
    }
}

impl Drop for LogSink {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Append bytes from a live session to its log, if one is active.
pub fn log_bytes(logger: &Logger, data: &[u8]) {
    if let Ok(mut guard) = logger.lock() {
        if let Some(sink) = guard.as_mut() {
            sink.feed(data);
        }
    }
}

/// Find the logger handle for a session id across the protocols that stream
/// terminal-style output (SSH, telnet, serial, and local shells).
async fn logger_for(state: &AppState, id: &str) -> Option<Logger> {
    if let Some(s) = state.ssh.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    if let Some(s) = state.telnet.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    if let Some(s) = state.serial.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    if let Some(s) = state.local.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    None
}

/// Begin appending the live session output to `path`. Creates the file (and
/// appends if it already exists). Used for both manual "record" and auto-log.
#[tauri::command]
pub async fn log_start(id: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let logger = logger_for(&state, &id)
        .await
        .ok_or("Session not found or does not support logging")?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Cannot open log file: {e}"))?;
    // UTF-8 BOM on a fresh file so Windows editors don't guess a legacy
    // codepage and mangle non-ASCII output.
    if file.metadata().map(|m| m.len()).unwrap_or(1) == 0 {
        let _ = file.write_all(b"\xef\xbb\xbf");
    }
    let mut sink = LogSink::new(file);
    sink.write_marker(&format!("===== Dshh log started {} =====", now_stamp()));
    *logger.lock().map_err(|e| e.to_string())? = Some(sink);
    Ok(())
}

/// Stop logging the session (flushes the pending line and closes the file).
#[tauri::command]
pub async fn log_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(logger) = logger_for(&state, &id).await {
        if let Ok(mut guard) = logger.lock() {
            if let Some(mut sink) = guard.take() {
                sink.finish();
            }
        }
    }
    Ok(())
}

/// Write arbitrary text to a file — used by the frontend "Save output" action
/// to dump the current terminal scrollback buffer.
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    // BOM for the same reason as log_start: Windows editors default to a
    // legacy codepage for BOM-less files with box-drawing characters.
    let mut data = Vec::with_capacity(contents.len() + 3);
    data.extend_from_slice(b"\xef\xbb\xbf");
    data.extend_from_slice(contents.as_bytes());
    std::fs::write(&path, data).map_err(|e| format!("Save failed: {e}"))
}

/// Read a UTF-8 text file — used to load the optional saved-sessions file
/// (connections.json) from the folder chosen in Settings.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Read failed: {e}"))
}

fn now_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

#[cfg(test)]
mod tests {
    use super::LogSink;

    /// Run chunks through a sink backed by a temp file and return the result.
    fn filter(chunks: &[&[u8]]) -> String {
        let path = std::env::temp_dir().join(format!(
            "dshh-logsink-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = std::fs::File::create(&path).unwrap();
        let mut sink = LogSink::new(file);
        for c in chunks {
            sink.feed(c);
        }
        sink.finish();
        drop(sink);
        let out = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        out
    }

    #[test]
    fn strips_ansi_colors_and_osc_titles() {
        assert_eq!(
            filter(&[b"\x1b]0;title\x07\x1b[1;31mred\x1b[0m ok\r\n"]),
            "red ok\n"
        );
    }

    #[test]
    fn backspace_erases_typed_chars() {
        // Shell echo for backspacing "c" off "abc": BS SPACE BS.
        assert_eq!(filter(&[b"abc\x08 \x08\r\n"]), "ab\n");
    }

    #[test]
    fn delete_key_removes_char_under_cursor() {
        // Cursor left twice, then DCH (what Delete echoes): "abc" -> "ac".
        assert_eq!(filter(&[b"abc\x1b[2D\x1b[1P\r\n"]), "ac\n");
    }

    #[test]
    fn carriage_return_overwrites_progress_lines() {
        assert_eq!(filter(&[b"10%\r20%\r\x1b[Kdone\r\n"]), "done\n");
    }

    #[test]
    fn utf8_survives_chunk_split() {
        // U+2500 BOX DRAWINGS LIGHT HORIZONTAL split across two reads.
        assert_eq!(filter(&[b"\xe2\x94", b"\x80\r\n"]), "\u{2500}\n");
    }

    #[test]
    fn invalid_bytes_become_replacement_char() {
        assert_eq!(filter(&[b"a\xffb\r\n"]), "a\u{fffd}b\n");
    }

    #[test]
    fn pending_line_flushes_on_finish() {
        assert_eq!(filter(&[b"user@host:~$ "]), "user@host:~$\n");
    }
}
