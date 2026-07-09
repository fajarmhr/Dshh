use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tauri::State;
use tokio::sync::Mutex;

/// Optional master-password protection for saved connection secrets.
/// The frontend stores passwords either as plain text (no master password)
/// or as `enc:v1:<nonce>:<ciphertext>` blobs. The AES-256-GCM key is derived
/// from the master password with Argon2id and kept only in this process's
/// memory while unlocked — it is never written to disk.

const CHECK_PLAINTEXT: &[u8] = b"dshh-master-check-v1";
pub const ENC_PREFIX: &str = "enc:v1:";

#[derive(Default)]
pub struct CryptoState(pub Mutex<Option<[u8; 32]>>);

#[derive(Debug, Clone, serde::Serialize)]
pub struct MasterMeta {
    pub salt: String,
    pub check: String,
}

fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

fn enc_with(key: &[u8; 32], plain: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher.encrypt(&nonce, plain).map_err(|e| e.to_string())?;
    Ok(format!("{ENC_PREFIX}{}:{}", B64.encode(nonce), B64.encode(ct)))
}

fn dec_with(key: &[u8; 32], blob: &str) -> Result<Vec<u8>, String> {
    let rest = blob.strip_prefix(ENC_PREFIX).ok_or("not an encrypted value")?;
    let (n, c) = rest.split_once(':').ok_or("malformed encrypted value")?;
    let nonce = B64.decode(n).map_err(|e| e.to_string())?;
    let ct = B64.decode(c).map_err(|e| e.to_string())?;
    if nonce.len() != 12 {
        return Err("malformed encrypted value".into());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "wrong master password or corrupt data".to_string())
}

/// Create a new master password: derives the key, keeps it unlocked, and
/// returns the salt + verifier blob the frontend persists in settings.
#[tauri::command]
pub async fn master_setup(
    password: String,
    state: State<'_, CryptoState>,
) -> Result<MasterMeta, String> {
    if password.is_empty() {
        return Err("Master password cannot be empty".into());
    }
    let mut salt = [0u8; 16];
    aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
    let key = derive(&password, &salt)?;
    let check = enc_with(&key, CHECK_PLAINTEXT)?;
    *state.0.lock().await = Some(key);
    Ok(MasterMeta { salt: B64.encode(salt), check })
}

/// Verify the master password against the stored salt + verifier. On success
/// the derived key stays in memory (unlocked) and `true` is returned.
#[tauri::command]
pub async fn master_unlock(
    password: String,
    salt: String,
    check: String,
    state: State<'_, CryptoState>,
) -> Result<bool, String> {
    let salt = B64.decode(salt).map_err(|e| e.to_string())?;
    let key = derive(&password, &salt)?;
    match dec_with(&key, &check) {
        Ok(p) if p == CHECK_PLAINTEXT => {
            *state.0.lock().await = Some(key);
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[tauri::command]
pub async fn master_lock(state: State<'_, CryptoState>) -> Result<(), String> {
    *state.0.lock().await = None;
    Ok(())
}

/// Encrypt a batch of secret strings. Empty values and values that are
/// already encrypted pass through unchanged, so this is idempotent.
#[tauri::command]
pub async fn secrets_encrypt(
    values: Vec<String>,
    state: State<'_, CryptoState>,
) -> Result<Vec<String>, String> {
    let guard = state.0.lock().await;
    let key = guard.as_ref().ok_or("Master password is locked")?;
    values
        .iter()
        .map(|v| {
            if v.is_empty() || v.starts_with(ENC_PREFIX) {
                Ok(v.clone())
            } else {
                enc_with(key, v.as_bytes())
            }
        })
        .collect()
}

/// Decrypt a batch of secret strings. Non-encrypted values pass through.
#[tauri::command]
pub async fn secrets_decrypt(
    values: Vec<String>,
    state: State<'_, CryptoState>,
) -> Result<Vec<String>, String> {
    let guard = state.0.lock().await;
    let key = guard.as_ref().ok_or("Master password is locked")?;
    values
        .iter()
        .map(|v| {
            if !v.starts_with(ENC_PREFIX) {
                Ok(v.clone())
            } else {
                dec_with(key, v)
                    .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_wrong_password() {
        let salt = [7u8; 16];
        let key = derive("hunter2", &salt).unwrap();
        let blob = enc_with(&key, b"s3cret").unwrap();
        assert!(blob.starts_with(ENC_PREFIX));
        assert_eq!(dec_with(&key, &blob).unwrap(), b"s3cret");

        let wrong = derive("hunter3", &salt).unwrap();
        assert!(dec_with(&wrong, &blob).is_err());
    }

    #[test]
    fn verifier_flow() {
        let salt = [9u8; 16];
        let key = derive("master", &salt).unwrap();
        let check = enc_with(&key, CHECK_PLAINTEXT).unwrap();
        assert_eq!(dec_with(&key, &check).unwrap(), CHECK_PLAINTEXT);
        let wrong = derive("not-master", &salt).unwrap();
        assert!(dec_with(&wrong, &check).is_err());
    }

    #[test]
    fn malformed_blobs_fail_cleanly() {
        let key = derive("x", &[1u8; 16]).unwrap();
        assert!(dec_with(&key, "enc:v1:garbage").is_err());
        assert!(dec_with(&key, "enc:v1:AAAA:%%%").is_err());
        assert!(dec_with(&key, "plaintext").is_err());
    }
}
