use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

use crate::settings::RelayProfile;

pub(crate) fn hydrate_profiles(
    settings_path: &Path,
    profiles: &mut [RelayProfile],
) -> anyhow::Result<()> {
    let secrets = load(settings_path)?;
    for profile in profiles {
        profile.vlm_api_key = secrets.get(&profile.id).cloned().unwrap_or_default();
        profile.vlm_api_key_saved = !profile.vlm_api_key.is_empty();
    }
    Ok(())
}

pub(crate) fn save_profiles(settings_path: &Path, profiles: &[RelayProfile]) -> anyhow::Result<()> {
    let existing = load(settings_path)?;
    let mut secrets = BTreeMap::new();
    for profile in profiles {
        let key = profile.vlm_api_key.trim();
        if !key.is_empty() {
            secrets.insert(profile.id.clone(), key.to_string());
        } else if profile.vlm_api_key_saved
            && let Some(key) = existing.get(&profile.id)
        {
            secrets.insert(profile.id.clone(), key.clone());
        }
    }
    save(settings_path, &secrets)
}

pub(crate) fn vault_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("vlm-secrets.bin")
}

fn load(settings_path: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let path = vault_path(settings_path);
    let encrypted = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BTreeMap::new());
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read VLM secret vault {}", path.display()));
        }
    };
    let plaintext = decrypt(&encrypted)
        .with_context(|| format!("failed to decrypt VLM secret vault {}", path.display()))?;
    serde_json::from_slice(&plaintext)
        .with_context(|| format!("failed to parse VLM secret vault {}", path.display()))
}

fn save(settings_path: &Path, secrets: &BTreeMap<String, String>) -> anyhow::Result<()> {
    let path = vault_path(settings_path);
    if secrets.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to remove VLM secret vault {}", path.display())
                });
            }
        }
        return Ok(());
    }
    let plaintext = serde_json::to_vec(secrets)?;
    let encrypted = encrypt(&plaintext)?;
    crate::settings::atomic_write(&path, &encrypted)
        .with_context(|| format!("failed to write VLM secret vault {}", path.display()))
}

#[cfg(windows)]
fn encrypt(plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    use windows::core::PCWSTR;

    let input_len = u32::try_from(plaintext.len()).context("VLM secret vault is too large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
        let encrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(encrypted)
    }
}

#[cfg(windows)]
fn decrypt(encrypted: &[u8]) -> anyhow::Result<Vec<u8>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let input_len = u32::try_from(encrypted.len()).context("VLM secret vault is too large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: encrypted.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
        let plaintext = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(plaintext)
    }
}

#[cfg(not(windows))]
fn encrypt(_plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    anyhow::bail!("VLM API Key 的持久化目前仅支持 Windows DPAPI")
}

#[cfg(not(windows))]
fn decrypt(_encrypted: &[u8]) -> anyhow::Result<Vec<u8>> {
    anyhow::bail!("VLM API Key 的持久化目前仅支持 Windows DPAPI")
}
