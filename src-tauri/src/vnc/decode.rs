//! Rectangle decoders for the encodings Dshh advertises.
//!
//! Every decoder writes RGBA (alpha always 255) into a caller-provided slice
//! that is exactly `w * h * 4` bytes, row-major — the layout `ImageData`
//! wants, so the frontend can `putImageData` it untouched. The pixel format
//! we ask servers for (32bpp, depth 24, little-endian, red at shift 0) puts
//! bytes on the wire as R,G,B,X, and ZRLE's compressed pixels as R,G,B.

use flate2::{Decompress, FlushDecompress, Status};
use tokio::io::{AsyncRead, AsyncReadExt};

type R<T> = Result<T, String>;

fn io(e: std::io::Error) -> String {
    format!("Connection error while reading the screen: {e}")
}

/// Fill a `w`-wide sub-rectangle of an RGBA buffer, clipped to its bounds.
fn fill(px: &mut [u8], stride: usize, x: usize, y: usize, w: usize, h: usize, c: [u8; 4]) {
    let rows = px.len() / (stride * 4);
    let x_end = x.saturating_add(w).min(stride);
    let y_end = y.saturating_add(h).min(rows);
    for row in y.min(y_end)..y_end {
        let line = &mut px[(row * stride + x.min(x_end)) * 4..(row * stride + x_end) * 4];
        for p in line.chunks_exact_mut(4) {
            p.copy_from_slice(&c);
        }
    }
}

async fn pixel<Rd: AsyncRead + Unpin>(rd: &mut Rd) -> R<[u8; 4]> {
    let mut p = [0u8; 4];
    rd.read_exact(&mut p).await.map_err(io)?;
    p[3] = 255;
    Ok(p)
}

fn opaque(px: &mut [u8]) {
    for a in px.iter_mut().skip(3).step_by(4) {
        *a = 255;
    }
}

/// Raw: `w * h` pixels, straight off the wire.
pub async fn raw<Rd: AsyncRead + Unpin>(rd: &mut Rd, px: &mut [u8]) -> R<()> {
    rd.read_exact(px).await.map_err(io)?;
    opaque(px);
    Ok(())
}

/// RRE: a background colour plus solid sub-rectangles.
pub async fn rre<Rd: AsyncRead + Unpin>(rd: &mut Rd, px: &mut [u8], w: usize) -> R<()> {
    let count = rd.read_u32().await.map_err(io)?;
    let bg = pixel(rd).await?;
    fill(px, w, 0, 0, w, usize::MAX, bg);
    for _ in 0..count {
        let c = pixel(rd).await?;
        let x = rd.read_u16().await.map_err(io)? as usize;
        let y = rd.read_u16().await.map_err(io)? as usize;
        let sw = rd.read_u16().await.map_err(io)? as usize;
        let sh = rd.read_u16().await.map_err(io)? as usize;
        fill(px, w, x, y, sw, sh, c);
    }
    Ok(())
}

/// Hextile: 16×16 tiles, each raw or a background with coloured sub-rects.
/// Background and foreground carry over from the previous tile.
pub async fn hextile<Rd: AsyncRead + Unpin>(
    rd: &mut Rd,
    px: &mut [u8],
    w: usize,
    h: usize,
) -> R<()> {
    const RAW: u8 = 1;
    const BG: u8 = 2;
    const FG: u8 = 4;
    const ANY_SUBRECTS: u8 = 8;
    const COLOURED: u8 = 16;
    let mut bg = [0, 0, 0, 255];
    let mut fg = [255, 255, 255, 255];
    let mut tile = vec![0u8; 16 * 16 * 4];
    for ty in (0..h).step_by(16) {
        let th = 16usize.min(h - ty);
        for tx in (0..w).step_by(16) {
            let tw = 16usize.min(w - tx);
            let mask = rd.read_u8().await.map_err(io)?;
            if mask & RAW != 0 {
                let t = &mut tile[..tw * th * 4];
                rd.read_exact(t).await.map_err(io)?;
                opaque(t);
                blit(px, w, tx, ty, t, tw, th);
                continue;
            }
            if mask & BG != 0 {
                bg = pixel(rd).await?;
            }
            fill(px, w, tx, ty, tw, th, bg);
            if mask & FG != 0 {
                fg = pixel(rd).await?;
            }
            if mask & ANY_SUBRECTS != 0 {
                let n = rd.read_u8().await.map_err(io)?;
                for _ in 0..n {
                    let c = if mask & COLOURED != 0 { pixel(rd).await? } else { fg };
                    let xy = rd.read_u8().await.map_err(io)? as usize;
                    let wh = rd.read_u8().await.map_err(io)? as usize;
                    let (sx, sy) = (xy >> 4, xy & 15);
                    let (sw, sh) = ((wh >> 4) + 1, (wh & 15) + 1);
                    // Clip to the tile as well as the rectangle.
                    let sw = sw.min(tw.saturating_sub(sx));
                    let sh = sh.min(th.saturating_sub(sy));
                    fill(px, w, tx + sx, ty + sy, sw, sh, c);
                }
            }
        }
    }
    Ok(())
}

/// Copy a packed `tw`×`th` RGBA tile into the rectangle at (`tx`, `ty`).
fn blit(px: &mut [u8], stride: usize, tx: usize, ty: usize, tile: &[u8], tw: usize, th: usize) {
    for row in 0..th {
        let dst = ((ty + row) * stride + tx) * 4;
        let src = row * tw * 4;
        if dst + tw * 4 > px.len() {
            return;
        }
        px[dst..dst + tw * 4].copy_from_slice(&tile[src..src + tw * 4]);
    }
}

/// ZRLE keeps one zlib stream for the whole connection, so the inflater
/// lives as long as the session.
pub struct Zrle {
    z: Decompress,
}

impl Zrle {
    pub fn new() -> Self {
        Self { z: Decompress::new(true) }
    }

    /// Inflate one rectangle's worth of compressed data.
    pub fn inflate(&mut self, input: &[u8]) -> R<Vec<u8>> {
        let mut out = Vec::with_capacity(input.len().saturating_mul(4).max(4096));
        let mut used = 0usize;
        // Each pass either consumes input or fills the output buffer; the cap
        // only guards against a corrupt stream that does neither.
        for _ in 0..100_000 {
            if out.len() == out.capacity() {
                out.reserve(out.capacity().max(4096));
            }
            let before_in = self.z.total_in();
            let before_out = self.z.total_out();
            let status = self
                .z
                .decompress_vec(&input[used..], &mut out, FlushDecompress::Sync)
                .map_err(|e| format!("ZRLE data is corrupt: {e}"))?;
            used += (self.z.total_in() - before_in) as usize;
            let produced = self.z.total_out() - before_out;
            let output_full = out.len() == out.capacity();
            if status == Status::StreamEnd || (used >= input.len() && !output_full) {
                return Ok(out);
            }
            if produced == 0 && used >= input.len() {
                return Ok(out);
            }
        }
        Err("ZRLE data did not decompress".into())
    }
}

/// Byte cursor over an inflated ZRLE rectangle.
struct Cur<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Cur<'a> {
    fn u8(&mut self) -> R<u8> {
        let b = *self.d.get(self.p).ok_or("ZRLE data ended early")?;
        self.p += 1;
        Ok(b)
    }
    fn take(&mut self, n: usize) -> R<&'a [u8]> {
        let s = self.d.get(self.p..self.p + n).ok_or("ZRLE data ended early")?;
        self.p += n;
        Ok(s)
    }
    /// Compressed pixel: the three significant bytes of our 32bpp format.
    fn cpixel(&mut self) -> R<[u8; 4]> {
        let b = self.take(3)?;
        Ok([b[0], b[1], b[2], 255])
    }
    fn run_length(&mut self) -> R<usize> {
        let mut len = 1usize;
        loop {
            let b = self.u8()?;
            len += b as usize;
            if b != 255 {
                return Ok(len);
            }
        }
    }
}

/// Decode inflated ZRLE data: 64×64 tiles, each raw, solid, packed-palette,
/// plain RLE or palette RLE.
pub fn zrle_tiles(data: &[u8], px: &mut [u8], w: usize, h: usize) -> R<()> {
    let mut c = Cur { d: data, p: 0 };
    let mut tile: Vec<[u8; 4]> = Vec::with_capacity(64 * 64);
    for ty in (0..h).step_by(64) {
        let th = 64usize.min(h - ty);
        for tx in (0..w).step_by(64) {
            let tw = 64usize.min(w - tx);
            let n = tw * th;
            tile.clear();
            let sub = c.u8()?;
            match sub {
                0 => {
                    for _ in 0..n {
                        tile.push(c.cpixel()?);
                    }
                }
                1 => {
                    let p = c.cpixel()?;
                    fill(px, w, tx, ty, tw, th, p);
                    continue;
                }
                2..=16 => {
                    let mut palette = [[0u8; 4]; 16];
                    for slot in palette.iter_mut().take(sub as usize) {
                        *slot = c.cpixel()?;
                    }
                    let bits = match sub {
                        2 => 1,
                        3..=4 => 2,
                        _ => 4,
                    };
                    let row_bytes = (tw * bits).div_ceil(8);
                    for _ in 0..th {
                        let row = c.take(row_bytes)?;
                        for i in 0..tw {
                            let bit = i * bits;
                            let byte = row[bit / 8];
                            let shift = 8 - bits - (bit % 8);
                            let idx = (byte >> shift) & ((1 << bits) - 1);
                            tile.push(palette[idx as usize]);
                        }
                    }
                }
                128 => {
                    while tile.len() < n {
                        let p = c.cpixel()?;
                        let len = c.run_length()?;
                        if tile.len() + len > n {
                            return Err("ZRLE run overflows its tile".into());
                        }
                        tile.extend(std::iter::repeat_n(p, len));
                    }
                }
                130..=255 => {
                    let size = (sub - 128) as usize;
                    let mut palette = [[0u8; 4]; 128];
                    for slot in palette.iter_mut().take(size) {
                        *slot = c.cpixel()?;
                    }
                    while tile.len() < n {
                        let idx = c.u8()?;
                        let p = palette[(idx & 127) as usize];
                        let len = if idx & 128 != 0 { c.run_length()? } else { 1 };
                        if tile.len() + len > n {
                            return Err("ZRLE run overflows its tile".into());
                        }
                        tile.extend(std::iter::repeat_n(p, len));
                    }
                }
                other => return Err(format!("Invalid ZRLE sub-encoding {other}")),
            }
            for row in 0..th {
                let dst = ((ty + row) * w + tx) * 4;
                for (i, p) in tile[row * tw..(row + 1) * tw].iter().enumerate() {
                    px[dst + i * 4..dst + i * 4 + 4].copy_from_slice(p);
                }
            }
        }
    }
    Ok(())
}

/// Cursor pseudo-encoding: pixels followed by a 1-bit transparency mask.
/// Returns RGBA with the mask folded into alpha.
pub async fn cursor<Rd: AsyncRead + Unpin>(rd: &mut Rd, w: usize, h: usize) -> R<Vec<u8>> {
    let mut px = vec![0u8; w * h * 4];
    rd.read_exact(&mut px).await.map_err(io)?;
    let row_bytes = w.div_ceil(8);
    let mut mask = vec![0u8; row_bytes * h];
    rd.read_exact(&mut mask).await.map_err(io)?;
    for y in 0..h {
        for x in 0..w {
            let visible = mask[y * row_bytes + x / 8] & (0x80 >> (x % 8)) != 0;
            px[(y * w + x) * 4 + 3] = if visible { 255 } else { 0 };
        }
    }
    Ok(px)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compress, Compression, FlushCompress};

    fn deflate(z: &mut Compress, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 64);
        z.compress_vec(data, &mut out, FlushCompress::Sync).unwrap();
        out
    }

    #[test]
    fn zrle_solid_and_palette_tiles_across_one_stream() {
        let mut enc = Compress::new(Compression::default(), true);
        let mut dec = Zrle::new();

        // Rect 1: 4×2, one solid red tile.
        let solid = [1u8, 255, 0, 0];
        let data = dec.inflate(&deflate(&mut enc, &solid)).unwrap();
        let mut px = vec![0u8; 4 * 2 * 4];
        zrle_tiles(&data, &mut px, 4, 2).unwrap();
        assert!(px.chunks(4).all(|p| p == [255, 0, 0, 255]));

        // Rect 2 continues the same zlib stream: 2-colour packed palette,
        // 3×1, indices 1,0,1 → bits 101 padded into one byte.
        let packed = [2u8, 0, 0, 0, 0, 255, 0, 0b1010_0000];
        let data = dec.inflate(&deflate(&mut enc, &packed)).unwrap();
        let mut px = vec![0u8; 3 * 4];
        zrle_tiles(&data, &mut px, 3, 1).unwrap();
        assert_eq!(&px[0..4], &[0, 255, 0, 255]);
        assert_eq!(&px[4..8], &[0, 0, 0, 255]);
        assert_eq!(&px[8..12], &[0, 255, 0, 255]);
    }

    #[test]
    fn zrle_palette_rle_runs() {
        // 5×1: palette RLE with two colours — run of 4 of index 0, then one
        // single index 1.
        let data = [130u8, 1, 2, 3, 9, 9, 9, 0x80, 3, 1];
        let mut px = vec![0u8; 5 * 4];
        zrle_tiles(&data, &mut px, 5, 1).unwrap();
        for i in 0..4 {
            assert_eq!(&px[i * 4..i * 4 + 4], &[1, 2, 3, 255]);
        }
        assert_eq!(&px[16..20], &[9, 9, 9, 255]);
    }

    #[test]
    fn zrle_rejects_overlong_run() {
        let data = [128u8, 1, 2, 3, 10];
        let mut px = vec![0u8; 4 * 4];
        assert!(zrle_tiles(&data, &mut px, 4, 1).is_err());
    }

    #[tokio::test]
    async fn hextile_background_and_subrects() {
        // One 4×4 tile: background blue, one foreground-coloured 2×2 subrect
        // at (1,1).
        let mut wire = vec![2 | 4 | 8];
        wire.extend_from_slice(&[0, 0, 255, 0]); // bg
        wire.extend_from_slice(&[255, 255, 0, 0]); // fg
        wire.push(1); // one subrect
        wire.push(0x11); // x=1 y=1
        wire.push(0x11); // w=2 h=2
        let mut px = vec![0u8; 4 * 4 * 4];
        hextile(&mut wire.as_slice(), &mut px, 4, 4).await.unwrap();
        let at = |x: usize, y: usize| px[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4].to_vec();
        assert_eq!(at(0, 0), vec![0, 0, 255, 255]);
        assert_eq!(at(1, 1), vec![255, 255, 0, 255]);
        assert_eq!(at(2, 2), vec![255, 255, 0, 255]);
        assert_eq!(at(3, 3), vec![0, 0, 255, 255]);
    }

    #[tokio::test]
    async fn cursor_mask_becomes_alpha() {
        let mut wire = vec![9u8; 2 * 1 * 4];
        wire.push(0b1000_0000); // only the first pixel visible
        let px = cursor(&mut wire.as_slice(), 2, 1).await.unwrap();
        assert_eq!(px[3], 255);
        assert_eq!(px[7], 0);
    }
}
