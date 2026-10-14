//! Text recognition for the VNC view's "Copy text": a VM console seldom
//! shares its clipboard, so the text is read off the screen instead, by the
//! OCR engine built into Windows (Windows.Media.Ocr) — nothing to install.
//!
//! The frontend sends the selected screen area as raw RGBA, with its size in
//! the `x-width` / `x-height` headers, and gets the recognised lines back.

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
    let text = tokio::task::spawn_blocking(move || {
        let (w, h, bgra) = prepare(w, h, &rgba);
        recognize(w, h, &bgra)
    })
    .await
    .map_err(|e| format!("Text recognition stopped: {e}"))??;
    Ok(tidy(&text))
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
/// zero comes back as Ø, and a hyphen or underscore as a dash.
fn tidy(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'Ø' | 'ø' => '0',
            '—' | '–' => '-',
            c => c,
        })
        .collect()
}

#[cfg(windows)]
fn recognize(w: u32, h: u32, bgra: &[u8]) -> Result<String, String> {
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

    let mut text = String::new();
    for line in result.Lines().map_err(fail)? {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&line.Text().map_err(fail)?.to_string_lossy());
    }
    Ok(text)
}

#[cfg(not(windows))]
fn recognize(_w: u32, _h: u32, _bgra: &[u8]) -> Result<String, String> {
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
    }
}
