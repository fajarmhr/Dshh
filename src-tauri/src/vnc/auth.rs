//! RFB handshake: protocol version, security negotiation and ServerInit.
//!
//! Supported security types — classic VNC authentication (DES challenge),
//! None, TightVNC's wrapper, VeNCrypt (X509 TLS and Plain sub-types) and
//! Apple Remote Desktop (Diffie-Hellman + AES, for macOS Screen Sharing).

use super::BoxStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SEC_NONE: u8 = 1;
const SEC_VNC: u8 = 2;
const SEC_TIGHT: u8 = 16;
const SEC_VENCRYPT: u8 = 19;
const SEC_ARD: u8 = 30;

const VC_PLAIN: u32 = 256;
const VC_TLS_NONE: u32 = 257;
const VC_TLS_VNC: u32 = 258;
const VC_TLS_PLAIN: u32 = 259;
const VC_X509_NONE: u32 = 260;
const VC_X509_VNC: u32 = 261;
const VC_X509_PLAIN: u32 = 262;

/// Prefix shared by every credential problem, so the frontend's auth-failure
/// check offers the password prompt instead of a dead tab.
const AUTH_FAILED: &str = "Authentication failed";

pub struct Credentials<'a> {
    pub username: &'a str,
    pub password: &'a str,
    /// Host name the VeNCrypt TLS layer is opened against.
    pub tls_domain: &'a str,
    pub verify_tls: bool,
}

/// What ServerInit told us, plus how we got there.
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub name: String,
    pub version: String,
    pub security: String,
}

type R<T> = Result<T, String>;

fn io(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::UnexpectedEof {
        "Server closed the connection".into()
    } else {
        format!("Connection error: {e}")
    }
}

/// Run the whole handshake. VeNCrypt swaps the transport for a TLS stream
/// part-way through, so the stream is taken by value and handed back.
pub async fn handshake(mut s: BoxStream, creds: &Credentials<'_>) -> R<(BoxStream, ServerInit)> {
    // ---- ProtocolVersion ----
    let mut v = [0u8; 12];
    s.read_exact(&mut v).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            "Connection closed before the VNC server introduced itself".to_string()
        } else {
            io(e)
        }
    })?;
    if &v[..4] != b"RFB " {
        return Err(format!(
            "Not a VNC server (it answered {:?})",
            String::from_utf8_lossy(&v).trim()
        ));
    }
    let digits = |b: &[u8]| -> u32 {
        std::str::from_utf8(b).ok().and_then(|t| t.parse().ok()).unwrap_or(0)
    };
    let (major, minor) = (digits(&v[4..7]), digits(&v[8..11]));
    // 3.8 for anything at or above it — Apple's 3.889, RealVNC's 4.x/5.0 and
    // Intel AMT all speak 3.8 to clients. Odd UltraVNC versions are 3.3.
    let minor = if major > 3 || (major == 3 && minor >= 8) {
        8
    } else if major == 3 && minor == 7 {
        7
    } else {
        3
    };
    s.write_all(format!("RFB 003.00{minor}\n").as_bytes()).await.map_err(io)?;
    let version = format!("3.{minor}");

    // ---- Security ----
    let chosen = if minor == 3 {
        // 3.3: the server decides, no list.
        let t = s.read_u32().await.map_err(io)?;
        if t == 0 {
            let reason = read_reason(&mut s).await;
            return Err(format!("Server refused the connection: {reason}"));
        }
        u8::try_from(t).map_err(|_| format!("Unsupported security type {t}"))?
    } else {
        let n = s.read_u8().await.map_err(io)?;
        if n == 0 {
            let reason = read_reason(&mut s).await;
            return Err(format!("Server refused the connection: {reason}"));
        }
        let mut offered = vec![0u8; n as usize];
        s.read_exact(&mut offered).await.map_err(io)?;
        let pick = choose_security(&offered, creds)?;
        s.write_u8(pick).await.map_err(io)?;
        pick
    };

    let mut tight = false;
    let (security, expect_result) = match chosen {
        SEC_NONE => ("none".to_string(), minor == 8),
        SEC_VNC => {
            vnc_auth(&mut s, creds.password).await?;
            ("vnc password".to_string(), true)
        }
        SEC_TIGHT => {
            tight = true;
            let used_password = tight_security(&mut s, creds.password).await?;
            let label = if used_password { "tight · vnc password" } else { "tight" };
            (label.to_string(), used_password || minor == 8)
        }
        SEC_VENCRYPT => {
            let (stream, label) = vencrypt(s, creds).await?;
            s = stream;
            (label, true)
        }
        SEC_ARD => {
            ard_auth(&mut s, creds.username, creds.password).await?;
            ("apple ard".to_string(), true)
        }
        other => return Err(format!("Unsupported security type {other}")),
    };

    if expect_result {
        let result = s.read_u32().await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                // Many servers just hang up on a wrong password.
                format!("{AUTH_FAILED}: the server closed the connection")
            } else {
                io(e)
            }
        })?;
        if result != 0 {
            let reason = if minor == 8 { read_reason(&mut s).await } else { String::new() };
            return Err(if reason.is_empty() {
                format!("{AUTH_FAILED}: wrong password")
            } else {
                format!("{AUTH_FAILED}: {reason}")
            });
        }
    }

    // ---- ClientInit / ServerInit ----
    s.write_u8(1).await.map_err(io)?; // shared: don't kick other viewers off
    let width = s.read_u16().await.map_err(io)?;
    let height = s.read_u16().await.map_err(io)?;
    let mut pixel_format = [0u8; 16];
    s.read_exact(&mut pixel_format).await.map_err(io)?;
    let name_len = s.read_u32().await.map_err(io)? as usize;
    if name_len > 64 * 1024 {
        return Err("Server sent an implausible desktop name".into());
    }
    let mut name = vec![0u8; name_len];
    s.read_exact(&mut name).await.map_err(io)?;
    if tight {
        // TightVNC appends its capability lists to ServerInit.
        let servers = s.read_u16().await.map_err(io)? as usize;
        let clients = s.read_u16().await.map_err(io)? as usize;
        let encodings = s.read_u16().await.map_err(io)? as usize;
        let _pad = s.read_u16().await.map_err(io)?;
        skip(&mut s, (servers + clients + encodings) * 16).await?;
    }

    Ok((
        s,
        ServerInit {
            width,
            height,
            name: String::from_utf8_lossy(&name).into_owned(),
            version,
            security,
        },
    ))
}

/// Pick a security type from the server's list. Missing credentials are
/// reported as auth failures so the user is asked for them.
fn choose_security(offered: &[u8], creds: &Credentials<'_>) -> R<u8> {
    let has = |t: u8| offered.contains(&t);
    let user = !creds.username.is_empty();
    let pass = !creds.password.is_empty();
    if has(SEC_NONE) {
        return Ok(SEC_NONE);
    }
    // A username means the user wants an account login: macOS or VeNCrypt.
    if user && has(SEC_ARD) {
        return Ok(SEC_ARD);
    }
    if user && has(SEC_VENCRYPT) {
        return Ok(SEC_VENCRYPT);
    }
    if pass && has(SEC_VNC) {
        return Ok(SEC_VNC);
    }
    if has(SEC_VENCRYPT) {
        return Ok(SEC_VENCRYPT);
    }
    if has(SEC_TIGHT) {
        return Ok(SEC_TIGHT);
    }
    if has(SEC_VNC) {
        return Err(format!("{AUTH_FAILED}: the server asks for a VNC password"));
    }
    if has(SEC_ARD) {
        return Err(format!(
            "{AUTH_FAILED}: macOS Screen Sharing needs your Mac username and password"
        ));
    }
    let list: Vec<String> = offered.iter().map(|t| t.to_string()).collect();
    Err(format!(
        "No supported security type (the server offers {})",
        list.join(", ")
    ))
}

/// Classic VNC authentication: DES-encrypt the 16-byte challenge with the
/// password (first 8 bytes, each byte bit-reversed) as the key.
async fn vnc_auth(s: &mut BoxStream, password: &str) -> R<()> {
    if password.is_empty() {
        return Err(format!("{AUTH_FAILED}: the server asks for a VNC password"));
    }
    let mut challenge = [0u8; 16];
    s.read_exact(&mut challenge).await.map_err(io)?;
    let response = des_response(&challenge, password);
    s.write_all(&response).await.map_err(io)?;
    Ok(())
}

fn des_response(challenge: &[u8; 16], password: &str) -> [u8; 16] {
    let mut key = [0u8; 8];
    for (k, b) in key.iter_mut().zip(password.as_bytes()) {
        *k = b.reverse_bits();
    }
    let mut out = *challenge;
    des_ecb(&key, &mut out);
    out
}

/// Plain DES in ECB mode over whole 8-byte blocks, in place.
fn des_ecb(key: &[u8; 8], data: &mut [u8]) {
    use des::cipher::{Block, BlockCipherEncrypt, KeyInit};
    let cipher = des::Des::new_from_slice(key).expect("DES key is 8 bytes");
    for chunk in data.chunks_exact_mut(8) {
        let mut block = Block::<des::Des>::default();
        block.copy_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
}

/// TightVNC's security wrapper: decline tunnelling, then pick None or VNC
/// authentication from its capability list. Returns whether a password was
/// used (that decides whether a SecurityResult follows under RFB 3.7).
async fn tight_security(s: &mut BoxStream, password: &str) -> R<bool> {
    let tunnels = s.read_u32().await.map_err(io)? as usize;
    if tunnels > 0 {
        skip(s, tunnels * 16).await?;
        s.write_u32(0).await.map_err(io)?; // NOTUNNEL
    }
    let auths = s.read_u32().await.map_err(io)? as usize;
    if auths == 0 {
        return Ok(false);
    }
    let mut codes = Vec::with_capacity(auths);
    for _ in 0..auths {
        codes.push(s.read_u32().await.map_err(io)?);
        skip(s, 12).await?; // vendor + signature
    }
    if codes.contains(&1) {
        s.write_u32(1).await.map_err(io)?;
        Ok(false)
    } else if codes.contains(&2) {
        if password.is_empty() {
            return Err(format!("{AUTH_FAILED}: the server asks for a VNC password"));
        }
        s.write_u32(2).await.map_err(io)?;
        vnc_auth(s, password).await?;
        Ok(true)
    } else {
        Err("The TightVNC server offers no authentication Dshh supports".into())
    }
}

/// VeNCrypt: optional X509 TLS around None, VNC or Plain (username+password)
/// authentication. The anonymous-TLS sub-types need anonymous Diffie-Hellman
/// cipher suites that Windows' TLS stack refuses to speak, so they are not
/// offered.
async fn vencrypt(mut s: BoxStream, creds: &Credentials<'_>) -> R<(BoxStream, String)> {
    let major = s.read_u8().await.map_err(io)?;
    let minor = s.read_u8().await.map_err(io)?;
    if (major, minor) < (0, 2) {
        return Err(format!("VeNCrypt {major}.{minor} is too old (need 0.2)"));
    }
    s.write_all(&[0, 2]).await.map_err(io)?;
    if s.read_u8().await.map_err(io)? != 0 {
        return Err("The server rejected VeNCrypt 0.2".into());
    }
    let n = s.read_u8().await.map_err(io)? as usize;
    let mut subs = Vec::with_capacity(n);
    for _ in 0..n {
        subs.push(s.read_u32().await.map_err(io)?);
    }
    let has = |t: u32| subs.contains(&t);
    let user = !creds.username.is_empty();
    let pass = !creds.password.is_empty();

    let pick = if user && has(VC_X509_PLAIN) {
        VC_X509_PLAIN
    } else if pass && has(VC_X509_VNC) {
        VC_X509_VNC
    } else if has(VC_X509_NONE) {
        VC_X509_NONE
    } else if user && has(VC_PLAIN) {
        VC_PLAIN
    } else if pass && subs.contains(&(SEC_VNC as u32)) {
        SEC_VNC as u32
    } else if subs.contains(&(SEC_NONE as u32)) {
        SEC_NONE as u32
    } else if has(VC_X509_PLAIN) || has(VC_PLAIN) {
        return Err(format!("{AUTH_FAILED}: the server asks for a username and password"));
    } else if has(VC_X509_VNC) || subs.contains(&(SEC_VNC as u32)) {
        return Err(format!("{AUTH_FAILED}: the server asks for a VNC password"));
    } else if has(VC_TLS_NONE) || has(VC_TLS_VNC) || has(VC_TLS_PLAIN) {
        return Err("The server only offers anonymous TLS (TLSNone/TLSVnc/TLSPlain), which \
                    Windows can't negotiate. Enable an X509 security type or VncAuth on the \
                    server, or tunnel the session through SSH."
            .into());
    } else {
        return Err(format!("No supported VeNCrypt sub-type (server offers {subs:?})"));
    };
    s.write_u32(pick).await.map_err(io)?;

    let tls = matches!(pick, VC_X509_NONE | VC_X509_VNC | VC_X509_PLAIN);
    if tls {
        if s.read_u8().await.map_err(io)? != 1 {
            return Err("The server refused to start TLS".into());
        }
        s = super::tls_wrap(s, creds.tls_domain, creds.verify_tls).await?;
    }

    let label = match pick {
        VC_X509_PLAIN | VC_PLAIN => {
            let u = creds.username.as_bytes();
            let p = creds.password.as_bytes();
            let mut msg = Vec::with_capacity(8 + u.len() + p.len());
            msg.extend_from_slice(&(u.len() as u32).to_be_bytes());
            msg.extend_from_slice(&(p.len() as u32).to_be_bytes());
            msg.extend_from_slice(u);
            msg.extend_from_slice(p);
            s.write_all(&msg).await.map_err(io)?;
            if tls { "vencrypt · tls · user" } else { "vencrypt · plain (unencrypted)" }
        }
        VC_X509_VNC => {
            vnc_auth(&mut s, creds.password).await?;
            "vencrypt · tls · vnc password"
        }
        x if x == SEC_VNC as u32 => {
            vnc_auth(&mut s, creds.password).await?;
            "vencrypt · vnc password"
        }
        VC_X509_NONE => "vencrypt · tls",
        _ => "vencrypt",
    };
    Ok((s, label.to_string()))
}

/// Apple Remote Desktop authentication (security type 30): Diffie-Hellman
/// key agreement, MD5 of the shared secret as an AES-128 key, and the
/// username/password block encrypted with it in ECB mode.
async fn ard_auth(s: &mut BoxStream, username: &str, password: &str) -> R<()> {
    use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
    use num_bigint::BigUint;

    if username.is_empty() || password.is_empty() {
        return Err(format!(
            "{AUTH_FAILED}: macOS Screen Sharing needs your Mac username and password"
        ));
    }
    let generator = s.read_u16().await.map_err(io)?;
    let key_len = s.read_u16().await.map_err(io)? as usize;
    if key_len == 0 || key_len > 1024 {
        return Err("Server sent an invalid ARD key length".into());
    }
    let mut prime = vec![0u8; key_len];
    s.read_exact(&mut prime).await.map_err(io)?;
    let mut server_pub = vec![0u8; key_len];
    s.read_exact(&mut server_pub).await.map_err(io)?;

    let p = BigUint::from_bytes_be(&prime);
    let g = BigUint::from(generator);
    let mut secret_bytes = vec![0u8; key_len];
    getrandom::fill(&mut secret_bytes).map_err(|e| format!("No randomness: {e}"))?;
    let private = BigUint::from_bytes_be(&secret_bytes) % &p;
    let public = g.modpow(&private, &p);
    let shared = BigUint::from_bytes_be(&server_pub).modpow(&private, &p);
    let pad = |n: &BigUint| {
        let b = n.to_bytes_be();
        let mut v = vec![0u8; key_len.saturating_sub(b.len())];
        v.extend_from_slice(&b);
        v
    };
    let key = md5::compute(pad(&shared)).0;

    // 64 bytes each for username and password, NUL-terminated, the rest
    // random filler.
    let mut block = [0u8; 128];
    getrandom::fill(&mut block).map_err(|e| format!("No randomness: {e}"))?;
    let u = &username.as_bytes()[..username.len().min(63)];
    block[..u.len()].copy_from_slice(u);
    block[u.len()] = 0;
    let pw = &password.as_bytes()[..password.len().min(63)];
    block[64..64 + pw.len()].copy_from_slice(pw);
    block[64 + pw.len()] = 0;

    let aes = aes::Aes128::new(GenericArray::from_slice(&key));
    for chunk in block.chunks_exact_mut(16) {
        let b = GenericArray::from_mut_slice(chunk);
        aes.encrypt_block(b);
    }
    s.write_all(&block).await.map_err(io)?;
    s.write_all(&pad(&public)).await.map_err(io)?;
    Ok(())
}

/// A length-prefixed failure reason, or a placeholder when it can't be read.
async fn read_reason(s: &mut BoxStream) -> String {
    let Ok(len) = s.read_u32().await else {
        return "no reason given".into();
    };
    let mut buf = vec![0u8; (len as usize).min(4096)];
    if s.read_exact(&mut buf).await.is_err() {
        return "no reason given".into();
    }
    let text = String::from_utf8_lossy(&buf).trim().to_string();
    if text.is_empty() { "no reason given".into() } else { text }
}

async fn skip(s: &mut BoxStream, mut n: usize) -> R<()> {
    let mut buf = [0u8; 256];
    while n > 0 {
        let take = n.min(buf.len());
        s.read_exact(&mut buf[..take]).await.map_err(io)?;
        n -= take;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The textbook DES vector (key 133457799BBCDFF1, plaintext
    /// 0123456789ABCDEF), so the cipher wiring itself is known good.
    #[test]
    fn des_matches_textbook_vector() {
        let key = [0x13, 0x34, 0x57, 0x79, 0x9B, 0xBC, 0xDF, 0xF1];
        let mut data = [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF];
        des_ecb(&key, &mut data);
        assert_eq!(data, [0x85, 0xE8, 0x13, 0x54, 0x0F, 0x0A, 0xB4, 0x05]);
    }

    /// VNC's quirk: each key byte is bit-reversed, and both challenge halves
    /// are encrypted independently.
    #[test]
    fn challenge_uses_bit_reversed_key() {
        let mut challenge = [0u8; 16];
        challenge[8..].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let got = des_response(&challenge, "pw");
        let mut key = [0u8; 8];
        key[0] = b'p'.reverse_bits();
        key[1] = b'w'.reverse_bits();
        let mut want = challenge;
        des_ecb(&key, &mut want);
        assert_eq!(got, want);
        assert_ne!(got[..8], got[8..]);
    }

    /// Plays the macOS side of ARD: the server must derive the same AES key
    /// from the client's public value and find the credentials where the
    /// protocol puts them.
    #[tokio::test]
    async fn ard_credentials_decrypt_with_the_servers_secret() {
        use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
        use num_bigint::BigUint;

        const LEN: usize = 128;
        let (client_end, mut server) = tokio::io::duplex(8192);
        let mut client: BoxStream = Box::new(client_end);
        // (g^a)^b = (g^b)^a holds for any modulus, which is all this checks.
        let p = BigUint::from_bytes_be(&[0xff; LEN]);
        let g = BigUint::from(2u32);
        let server_secret = BigUint::from_bytes_be(&[0x5a; 64]);
        let pad = |n: &BigUint| {
            let b = n.to_bytes_be();
            let mut v = vec![0u8; LEN - b.len()];
            v.extend_from_slice(&b);
            v
        };
        server.write_u16(2).await.unwrap();
        server.write_u16(LEN as u16).await.unwrap();
        server.write_all(&pad(&p)).await.unwrap();
        server.write_all(&pad(&g.modpow(&server_secret, &p))).await.unwrap();

        ard_auth(&mut client, "alice", "s3cret").await.unwrap();

        let mut block = [0u8; 128];
        server.read_exact(&mut block).await.unwrap();
        let mut client_pub = [0u8; LEN];
        server.read_exact(&mut client_pub).await.unwrap();
        let shared = BigUint::from_bytes_be(&client_pub).modpow(&server_secret, &p);
        let aes = aes::Aes128::new(GenericArray::from_slice(&md5::compute(pad(&shared)).0));
        for chunk in block.chunks_exact_mut(16) {
            aes.decrypt_block(GenericArray::from_mut_slice(chunk));
        }
        assert_eq!(&block[..6], b"alice\0");
        assert_eq!(&block[64..71], b"s3cret\0");
    }

    #[test]
    fn long_passwords_truncate_to_eight() {
        let c = [7u8; 16];
        assert_eq!(des_response(&c, "12345678"), des_response(&c, "123456789abc"));
    }

    fn creds<'a>(u: &'a str, p: &'a str) -> Credentials<'a> {
        Credentials { username: u, password: p, tls_domain: "h", verify_tls: false }
    }

    #[test]
    fn security_choice_prefers_none_then_account_login() {
        assert_eq!(choose_security(&[2, 1], &creds("", "")).unwrap(), SEC_NONE);
        assert_eq!(choose_security(&[30, 2], &creds("me", "pw")).unwrap(), SEC_ARD);
        assert_eq!(choose_security(&[19, 2], &creds("", "pw")).unwrap(), SEC_VNC);
        assert_eq!(choose_security(&[19, 2], &creds("me", "pw")).unwrap(), SEC_VENCRYPT);
    }

    #[test]
    fn missing_password_reads_as_auth_failure() {
        let err = choose_security(&[2], &creds("", "")).unwrap_err();
        assert!(err.starts_with(AUTH_FAILED));
        let err = choose_security(&[30], &creds("", "")).unwrap_err();
        assert!(err.starts_with(AUTH_FAILED));
    }
}
