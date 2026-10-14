//! Text recognition for the VNC view's "Copy text": a VM console seldom
//! shares its clipboard, so the text is read off the screen instead, by the
//! OCR engine built into Windows (Windows.Media.Ocr) — nothing to install.
//!
//! The frontend sends the selected screen area as raw RGBA, with its size in
//! the `x-width` / `x-height` headers, and gets the recognised text back, laid
//! out in rows and columns as the screen shows it.

use tauri::ipc::{InvokeBody, Request};

/// Selections are scaled up 3× (smoothly — blocky pixels read worse): console
/// glyphs at 1:1 sit near the engine's smallest readable size, and 3× read
/// best across the console fonts tried. Less when that would pass this side.
const SCALE: u32 = 3;
const MAX_SIDE: u32 = 4000;

#[tauri::command]
pub async fn ocr_image(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("Expected the screen area as raw pixels".into());
    };
    let dim = |name: &str| -> Result<u32, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| format!("Missing {name}"))
    };
    let (w, h) = (dim("x-width")?, dim("x-height")?);
    if rgba.len() != (w * h * 4) as usize {
        return Err(format!("{} bytes isn't a {w}×{h} RGBA image", rgba.len()));
    }
    let rgba = rgba.clone();
    let lines = tokio::task::spawn_blocking(move || {
        let (w, h, bgra) = prepare(w, h, &rgba);
        recognize(w, h, &bgra)
    })
    .await
    .map_err(|e| format!("Text recognition stopped: {e}"))??;
    Ok(tidy(&layout(&lines)))
}

/// A word the engine read, and its box on the image it was given.
#[derive(Debug, Clone)]
struct Word {
    text: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl Word {
    fn len(&self) -> usize {
        self.text.chars().count()
    }
}

/// The middle value (the lower one of an even count); None when empty.
fn median(values: impl Iterator<Item = f32>) -> Option<f32> {
    let mut v: Vec<f32> = values.filter(|v| v.is_finite()).collect();
    v.sort_by(f32::total_cmp);
    v.get(v.len().saturating_sub(1) / 2).copied()
}

/// Put the words back where the screen has them. The engine breaks a row at
/// a wide gap and reads a table column by column, so a two-row table comes
/// back as six lines. Its lines are regrouped into rows by height, each word
/// set at the column its position gives in the console's fixed character
/// width, and empty rows kept — so the columns line up as they did.
fn layout(lines: &[Vec<Word>]) -> String {
    let words: Vec<&Word> = lines.iter().flatten().collect();
    let Some(height) = median(words.iter().map(|w| w.h)) else {
        return String::new();
    };
    let pitch = char_pitch(lines, height);
    let left = words.iter().map(|w| w.x).fold(f32::MAX, f32::min);

    // Rows top to bottom: the engine's lines whose middles sit within half a
    // character's height of each other share one.
    let mut frags: Vec<(f32, &[Word])> = lines
        .iter()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let top = l.iter().map(|w| w.y).fold(f32::MAX, f32::min);
            let bottom = l.iter().map(|w| w.y + w.h).fold(f32::MIN, f32::max);
            ((top + bottom) / 2.0, l.as_slice())
        })
        .collect();
    frags.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut rows: Vec<(f32, Vec<&Word>)> = Vec::new();
    for (mid, frag) in frags {
        match rows.last_mut() {
            Some((row_mid, row)) if (mid - *row_mid).abs() < height / 2.0 => {
                let n = row.len() as f32;
                *row_mid = (*row_mid * n + mid * frag.len() as f32) / (n + frag.len() as f32);
                row.extend(frag);
            }
            _ => rows.push((mid, frag.iter().collect())),
        }
    }

    // The line spacing is the closest two rows sit; a wider step had rows
    // with nothing readable on them (blank, or only a rule of dashes).
    let spacing = rows
        .windows(2)
        .map(|r| r[1].0 - r[0].0)
        .fold(f32::MAX, f32::min)
        .max(height);

    let mut out = String::new();
    let mut above: Option<f32> = None;
    for (mid, mut row) in rows {
        if let Some(above) = above {
            let steps = ((mid - above) / spacing).round().max(1.0) as usize;
            out.push_str(&"\n".repeat(steps));
        }
        above = Some(mid);
        row.sort_by(|a, b| a.x.total_cmp(&b.x));
        let mut col = 0;
        for (i, word) in row.iter().enumerate() {
            let at = ((word.x - left) / pitch).round().max(0.0) as usize;
            // At least a space between words, however the columns round.
            let gap = if i == 0 { at } else { at.saturating_sub(col).max(1) };
            out.extend(std::iter::repeat_n(' ', gap));
            out.push_str(&word.text);
            col += gap + word.len();
        }
    }
    out
}

/// The console's character width. Words the engine kept on one line are
/// mostly a single space apart, so the step from one word's start to the
/// next, over its length plus one, is the width; steps far from what the
/// words' own widths suggest (a wide gap, not one space) are left out.
fn char_pitch(lines: &[Vec<Word>], height: f32) -> f32 {
    let words = || lines.iter().flatten().filter(|w| w.len() > 0);
    // A word's ink stops short of its last cell, so this runs a bit under.
    let ink = median(words().filter(|w| w.len() > 1).map(|w| w.w / w.len() as f32))
        .or_else(|| median(words().map(|w| w.w / w.len() as f32)))
        .unwrap_or(height * 0.6);
    let steps = lines
        .iter()
        .flat_map(|l| l.windows(2))
        .map(|p| (p[1].x - p[0].x) / (p[0].len() + 1) as f32)
        .filter(|s| (ink * 0.9..=ink * 1.3).contains(s));
    median(steps)
        .unwrap_or(ink * 1.05)
        .clamp(height * 0.3, height * 1.2)
}

/// Grey and scaled up (bilinear), which is what the engine reads best.
/// Returns the new size and its pixels as BGRA.
fn prepare(w: u32, h: u32, rgba: &[u8]) -> (u32, u32, Vec<u8>) {
    let grey: Vec<f32> = rgba
        .chunks_exact(4)
        .map(|p| p[0] as f32 * 0.299 + p[1] as f32 * 0.587 + p[2] as f32 * 0.114)
        .collect();
    let at = |x: u32, y: u32| grey[(y * w + x) as usize];

    let k = (MAX_SIDE / w.max(h)).clamp(1, SCALE);
    let (sw, sh) = (w * k, h * k);
    let mut out = Vec::with_capacity((sw * sh * 4) as usize);
    for y in 0..sh {
        // Source position of this pixel's centre, and its neighbours.
        let fy = ((y as f32 + 0.5) / k as f32 - 0.5).max(0.0);
        let (y0, ty) = (fy as u32, fy.fract());
        let y1 = (y0 + 1).min(h - 1);
        for x in 0..sw {
            let fx = ((x as f32 + 0.5) / k as f32 - 0.5).max(0.0);
            let (x0, tx) = (fx as u32, fx.fract());
            let x1 = (x0 + 1).min(w - 1);
            let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
            let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
            let g = (top * (1.0 - ty) + bottom * ty).round() as u8;
            out.extend_from_slice(&[g, g, g, 255]);
        }
    }
    (sw, sh, out)
}

/// Undo the engine's usual misreads of console text: a slashed or dotted
/// zero comes back as Ø, or as O inside a number ("73/O/8"), and a hyphen or
/// underscore as a dash.
fn tidy(text: &str) -> String {
    let mut out: Vec<char> = text
        .chars()
        .map(|c| match c {
            'Ø' | 'ø' => '0',
            '—' | '–' => '-',
            c => c,
        })
        .collect();
    for i in 0..out.len() {
        if out[i] == 'O' && reads_as_zero(&out, i) {
            out[i] = '0';
        }
    }
    out.into_iter().collect()
}

/// An O with a digit beside it, or between two of `/ . :` in a word that has
/// digits, and nothing but those (or another O) next to it — so "1O", "73/O/8"
/// and "1OO" are numbers, while "I/O", "OK" and "ISO9001" stay as they are.
fn reads_as_zero(chars: &[char], i: usize) -> bool {
    let near = |j: Option<usize>| j.and_then(|j| chars.get(j)).copied().filter(|c| !c.is_whitespace());
    let (before, after) = (near(i.checked_sub(1)), near(Some(i + 1)));
    let sep = |c: char| matches!(c, '/' | '.' | ':');
    let fits = |c: Option<char>| c.is_none_or(|c| c.is_ascii_digit() || sep(c) || c == 'O');
    if !fits(before) || !fits(after) {
        return false;
    }
    let digit = |c: Option<char>| c.is_some_and(|c| c.is_ascii_digit());
    if digit(before) || digit(after) {
        return true;
    }
    let word_start = chars[..i].iter().rposition(|c| c.is_whitespace()).map_or(0, |j| j + 1);
    let word_end = chars[i..].iter().position(|c| c.is_whitespace()).map_or(chars.len(), |j| i + j);
    before.is_some_and(sep)
        && after.is_some_and(sep)
        && chars[word_start..word_end].iter().any(char::is_ascii_digit)
}

/// The engine's lines, each as its words with their boxes.
#[cfg(windows)]
fn recognize(w: u32, h: u32, bgra: &[u8]) -> Result<Vec<Vec<Word>>, String> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    let fail = |e: windows::core::Error| format!("Text recognition failed: {}", e.message());
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .or_else(|_| {
            // None of the profile's languages has an OCR pack: any that does.
            let lang = OcrEngine::AvailableRecognizerLanguages()?.GetAt(0)?;
            OcrEngine::TryCreateFromLanguage(&lang)
        })
        .map_err(|_| {
            "Windows has no text-recognition language installed. Add English under \
             Settings → Time & language → Language & region, then try again."
                .to_string()
        })?;
    let max = OcrEngine::MaxImageDimension().map_err(fail)?;
    if w > max || h > max {
        return Err(format!("Select a smaller area — the limit is {max} pixels a side"));
    }

    let writer = DataWriter::new().map_err(fail)?;
    writer.WriteBytes(bgra).map_err(fail)?;
    let buffer = writer.DetachBuffer().map_err(fail)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        w as i32,
        h as i32,
        BitmapAlphaMode::Ignore,
    )
    .map_err(fail)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(fail)?.get().map_err(fail)?;

    let mut lines = Vec::new();
    for line in result.Lines().map_err(fail)? {
        let mut words = Vec::new();
        for word in line.Words().map_err(fail)? {
            let r = word.BoundingRect().map_err(fail)?;
            words.push(Word {
                text: word.Text().map_err(fail)?.to_string_lossy(),
                x: r.X,
                y: r.Y,
                w: r.Width,
                h: r.Height,
            });
        }
        lines.push(words);
    }
    Ok(lines)
}

#[cfg(not(windows))]
fn recognize(_w: u32, _h: u32, _bgra: &[u8]) -> Result<Vec<Vec<Word>>, String> {
    Err("Reading text off the screen needs Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_areas_are_scaled_up_smoothly_in_grey() {
        // A white pixel beside a black one.
        let rgba = [255, 255, 255, 255, 0, 0, 0, 255];
        let (w, h, bgra) = prepare(2, 1, &rgba);
        assert_eq!((w, h), (2 * SCALE, SCALE));
        let px = |x: u32| bgra[(x * 4) as usize];
        assert_eq!(px(0), 255);
        assert_eq!(px(w - 1), 0);
        // In between, a ramp rather than a hard step.
        assert!(px(2) < 255 && px(2) > 0 && px(2) > px(3), "{:?}", &bgra);
        assert_eq!(&bgra[..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn big_areas_keep_their_size() {
        let (w, h) = (MAX_SIDE, 2);
        let rgba: Vec<u8> = (0..w * h).flat_map(|_| [200, 200, 200, 255]).collect();
        let (sw, sh, bgra) = prepare(w, h, &rgba);
        assert_eq!((sw, sh), (w, h));
        assert_eq!(&bgra[..4], &[200, 200, 200, 255]);
    }

    #[test]
    fn misread_zeros_and_dashes_are_put_back() {
        assert_eq!(tidy("ethØ pfifo—fast 1Ø.ø–2"), "eth0 pfifo-fast 10.0-2");
        assert_eq!(
            tidy("200GE73/O/8 1OO vlan1O 10.O.0.1 I/O OK ISO9001 O GO/O/1"),
            "200GE73/0/8 100 vlan10 10.0.0.1 I/O OK ISO9001 O GO/0/1"
        );
    }

    /// Words as a console shows them: 10px a character, 30px a row, the ink
    /// a little inside each cell.
    fn run(text: &str, col: usize, row: usize) -> Vec<Word> {
        let mut at = col;
        text.split(' ')
            .map(|t| {
                let n = t.chars().count();
                let w = Word {
                    text: t.into(),
                    x: at as f32 * 10.0 + 1.0,
                    y: row as f32 * 30.0 + 5.0,
                    w: n as f32 * 10.0 - 2.0,
                    h: 20.0,
                };
                at += n + 1;
                w
            })
            .collect()
    }

    /// The same, a few pixels lower: a line without capitals or with
    /// descenders has its box off-centre from its neighbours'.
    fn lower(mut words: Vec<Word>, dy: f32) -> Vec<Word> {
        words.iter_mut().for_each(|w| w.y += dy);
        words
    }

    #[test]
    fn a_table_read_column_by_column_comes_back_in_rows() {
        // As the engine hands it over: the two rows of a table broken at
        // their wide gaps and read a column at a time, and the rule of dashes
        // on row 1 and the ones before END not read at all.
        let lines = vec![
            run("The result is as follows:", 0, 0),
            run("Trunk Interface Name Member Interface Name Select Status Member Status", 0, 2),
            run("Eth-Trunk2", 0, 4),
            run("Eth-Trunk2", 0, 5),
            lower(run("200GE73/0/8", 18, 4), 4.0),
            lower(run("200GE73/0/10", 18, 5), 4.0),
            [run("Selected", 35, 4), run("Up", 47, 4)].concat(),
            [run("Selected", 35, 5), run("Up", 47, 5)].concat(),
            run("(Number of results = 2)", 0, 6),
            run("END", 4, 8),
        ];
        assert_eq!(
            layout(&lines),
            "The result is as follows:\n\
             \n\
             Trunk Interface Name Member Interface Name Select Status Member Status\n\
             \n\
             Eth-Trunk2        200GE73/0/8      Selected    Up\n\
             Eth-Trunk2        200GE73/0/10     Selected    Up\n\
             (Number of results = 2)\n\
             \n    END"
        );
    }

    #[test]
    fn nothing_read_is_empty() {
        assert_eq!(layout(&[]), "");
        assert_eq!(layout(&[vec![]]), "");
    }
}
