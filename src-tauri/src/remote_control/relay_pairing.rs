use std::collections::HashMap;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, mpsc};
use x25519_dalek::{PublicKey, StaticSecret};

use super::protocol::{PROTOCOL_VERSION, unix_timestamp_ms};
use super::settings::RemoteSettings;

const PAIRING_TTL_MS: u64 = 2 * 60 * 1_000;
const MAX_FAILED_PROOFS: u16 = 5;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineRelayMobile {
    pub device_id: String,
    pub device_name: String,
    pub browser: String,
    pub platform: String,
    pub connected_at: u64,
    pub last_seen_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRelayPairing {
    pub pairing_id: String,
    pub remote_device_id: String,
    pub device_name: String,
    pub browser: String,
    pub platform: String,
    pub mode: String,
    pub code: String,
    pub requested_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayPairingSnapshot {
    pub online_mobiles: Vec<OnlineRelayMobile>,
    pub pending_requests: Vec<PendingRelayPairing>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayPairingInvitation {
    pub pairing_id: String,
    pub remote_device_id: String,
    pub device_name: String,
    pub code: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct RelayPairingManager {
    state: Arc<Mutex<RelayPairingState>>,
}

struct RelayPairingState {
    mobiles: HashMap<String, OnlineRelayMobile>,
    requests: HashMap<String, PairingRecord>,
    outbound: Option<mpsc::UnboundedSender<Value>>,
    credentials: Option<PairingCredentials>,
    last_error: Option<String>,
}

#[derive(Clone)]
struct PairingCredentials {
    public_web_url: String,
    room_id: String,
    desktop_device_id: String,
    desktop_name: String,
    access_token: String,
    encryption_key: String,
}

struct PairingRecord {
    public: PendingRelayPairing,
    desktop_secret: StaticSecret,
    desktop_public_key: String,
    failed_attempts: u16,
}

impl Default for RelayPairingManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RelayPairingManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RelayPairingState {
                mobiles: HashMap::new(),
                requests: HashMap::new(),
                outbound: None,
                credentials: None,
                last_error: None,
            })),
        }
    }

    pub async fn start_runtime(
        &self,
        settings: &RemoteSettings,
        outbound: mpsc::UnboundedSender<Value>,
    ) {
        let mut state = self.state.lock().await;
        state.outbound = Some(outbound);
        state.credentials = Some(PairingCredentials {
            public_web_url: settings.public_web_url.clone(),
            room_id: settings.room_id.clone(),
            desktop_device_id: settings.desktop_device_id.clone(),
            desktop_name: settings.device_name.clone(),
            access_token: settings.access_token.clone(),
            encryption_key: settings.encryption_key.clone(),
        });
        state.mobiles.clear();
        state.requests.clear();
        state.last_error = None;
    }

    pub async fn stop_runtime(&self) {
        let mut state = self.state.lock().await;
        state.outbound = None;
        state.credentials = None;
        state.mobiles.clear();
        state.requests.clear();
    }

    pub async fn snapshot(&self) -> RelayPairingSnapshot {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let mut online_mobiles = state.mobiles.values().cloned().collect::<Vec<_>>();
        online_mobiles.sort_by_key(|item| std::cmp::Reverse(item.connected_at));
        let mut pending_requests = state
            .requests
            .values()
            .map(|record| record.public.clone())
            .collect::<Vec<_>>();
        pending_requests.sort_by_key(|item| std::cmp::Reverse(item.requested_at));
        RelayPairingSnapshot {
            online_mobiles,
            pending_requests,
            last_error: state.last_error.clone(),
        }
    }

    pub async fn request_mobile_list(&self) -> Result<(), String> {
        self.send(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "presence.mobile.list.request",
            "messageId": uuid::Uuid::new_v4().to_string(),
        }))
        .await
    }

    pub async fn create_invitation(
        &self,
        remote_device_id: &str,
    ) -> Result<RelayPairingInvitation, String> {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let credentials = state
            .credentials
            .clone()
            .ok_or_else(|| "中继尚未连接，无法发起公网配对".to_string())?;
        let mobile = state
            .mobiles
            .get(remote_device_id)
            .cloned()
            .ok_or_else(|| "手机网页已离线，请刷新在线设备列表".to_string())?;
        let record = new_pairing_record(&mobile, "desktop_invite");
        let pairing_id = record.public.pairing_id.clone();
        let invitation = RelayPairingInvitation {
            pairing_id: pairing_id.clone(),
            remote_device_id: mobile.device_id.clone(),
            device_name: mobile.device_name.clone(),
            code: record.public.code.clone(),
            expires_at: record.public.expires_at,
        };
        let message = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "pairing.invite",
            "messageId": uuid::Uuid::new_v4().to_string(),
            "pairingId": pairing_id,
            "senderDeviceId": credentials.desktop_device_id,
            "targetDeviceId": mobile.device_id,
            "payload": {
                "desktopName": credentials.desktop_name,
                "desktopPublicKey": record.desktop_public_key,
            }
        });
        state.requests.insert(invitation.pairing_id.clone(), record);
        send_locked(&state, message)?;
        Ok(invitation)
    }

    pub async fn reject(&self, pairing_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let credentials = state
            .credentials
            .clone()
            .ok_or_else(|| "中继尚未连接".to_string())?;
        let record = state
            .requests
            .remove(pairing_id)
            .ok_or_else(|| "配对请求不存在或已过期".to_string())?;
        send_locked(
            &state,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "kind": "pairing.rejected",
                "messageId": uuid::Uuid::new_v4().to_string(),
                "pairingId": pairing_id,
                "senderDeviceId": credentials.desktop_device_id,
                "targetDeviceId": record.public.remote_device_id,
                "payload": {"message": "电脑已拒绝配对请求"}
            }),
        )
    }

    pub async fn handle_server_message(&self, value: Value) -> bool {
        let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
        match kind {
            "presence.mobile.list" => {
                let devices = value
                    .get("devices")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut state = self.state.lock().await;
                state.mobiles = devices
                    .into_iter()
                    .filter_map(parse_mobile)
                    .map(|mobile| (mobile.device_id.clone(), mobile))
                    .collect();
                true
            }
            "presence.mobile.online" => {
                if let Some(mobile) = value.get("device").cloned().and_then(parse_mobile) {
                    self.state
                        .lock()
                        .await
                        .mobiles
                        .insert(mobile.device_id.clone(), mobile);
                }
                true
            }
            "presence.mobile.offline" => {
                if let Some(device_id) = value.get("deviceId").and_then(Value::as_str) {
                    let mut state = self.state.lock().await;
                    state.mobiles.remove(device_id);
                    state
                        .requests
                        .retain(|_, record| record.public.remote_device_id != device_id);
                }
                true
            }
            "pairing.request" => {
                if let Err(error) = self.accept_mobile_request(&value).await {
                    self.set_error(error).await;
                }
                true
            }
            "pairing.proof" => {
                if let Err(error) = self.complete_proof(&value).await {
                    self.set_error(error).await;
                }
                true
            }
            "pairing.cancelled" | "pairing.rejected" => {
                if let Some(pairing_id) = value.get("pairingId").and_then(Value::as_str) {
                    self.state.lock().await.requests.remove(pairing_id);
                }
                true
            }
            "error" if value.get("pairingId").is_some() => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("公网配对消息被中继拒绝");
                self.set_error(message.to_string()).await;
                true
            }
            _ => false,
        }
    }

    async fn accept_mobile_request(&self, value: &Value) -> Result<(), String> {
        let pairing_id = required_string(value, "pairingId")?;
        let remote_device_id = required_string(value, "senderDeviceId")?;
        let target_device_id = required_string(value, "targetDeviceId")?;
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let credentials = state
            .credentials
            .clone()
            .ok_or_else(|| "中继尚未连接".to_string())?;
        if target_device_id != credentials.desktop_device_id {
            return Err("手机配对请求目标不匹配".into());
        }
        let mobile = state
            .mobiles
            .get(&remote_device_id)
            .cloned()
            .or_else(|| parse_mobile(value.get("payload").cloned().unwrap_or(Value::Null)))
            .ok_or_else(|| "无法识别发起请求的手机".to_string())?;
        if state.requests.contains_key(&pairing_id) {
            return Err("配对请求已经存在".into());
        }
        let mut record = new_pairing_record(&mobile, "mobile_request");
        record.public.pairing_id = pairing_id.clone();
        let message = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "pairing.challenge",
            "messageId": uuid::Uuid::new_v4().to_string(),
            "pairingId": pairing_id,
            "senderDeviceId": credentials.desktop_device_id,
            "targetDeviceId": remote_device_id,
            "payload": {
                "desktopName": credentials.desktop_name,
                "desktopPublicKey": record.desktop_public_key,
            }
        });
        state
            .requests
            .insert(record.public.pairing_id.clone(), record);
        send_locked(&state, message)
    }

    async fn complete_proof(&self, value: &Value) -> Result<(), String> {
        let pairing_id = required_string(value, "pairingId")?;
        let sender_device_id = required_string(value, "senderDeviceId")?;
        let payload = value
            .get("payload")
            .and_then(Value::as_object)
            .ok_or_else(|| "手机配对证明格式无效".to_string())?;
        let client_public_key = payload
            .get("clientPublicKey")
            .and_then(Value::as_str)
            .ok_or_else(|| "手机临时公钥缺失".to_string())?;
        let request_nonce = payload
            .get("requestNonce")
            .and_then(Value::as_str)
            .ok_or_else(|| "手机配对随机数缺失".to_string())?;
        let proof = payload
            .get("proof")
            .and_then(Value::as_str)
            .ok_or_else(|| "手机配对证明缺失".to_string())?;

        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let credentials = state
            .credentials
            .clone()
            .ok_or_else(|| "中继尚未连接".to_string())?;
        let record = state
            .requests
            .get_mut(&pairing_id)
            .ok_or_else(|| "配对请求不存在或已过期".to_string())?;
        if record.public.remote_device_id != sender_device_id {
            return Err("手机配对请求来源不匹配".into());
        }
        let canonical = proof_message(
            &pairing_id,
            &sender_device_id,
            &credentials.desktop_device_id,
            client_public_key,
            &record.desktop_public_key,
            request_nonce,
        );
        if !verify_hmac(record.public.code.as_bytes(), canonical.as_bytes(), proof) {
            record.failed_attempts = record.failed_attempts.saturating_add(1);
            let terminal = record.failed_attempts >= MAX_FAILED_PROOFS;
            let target = record.public.remote_device_id.clone();
            if terminal {
                state.requests.remove(&pairing_id);
            }
            send_locked(
                &state,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "kind": if terminal { "pairing.rejected" } else { "pairing.error" },
                    "messageId": uuid::Uuid::new_v4().to_string(),
                    "pairingId": pairing_id,
                    "senderDeviceId": credentials.desktop_device_id,
                    "targetDeviceId": target,
                    "payload": {"message": if terminal { "配对码错误次数过多" } else { "配对码不正确，请重试" }}
                }),
            )?;
            return Err("手机提交了无效的公网配对码".into());
        }
        let client_public = PublicKey::from(
            decode_fixed::<32>(client_public_key).ok_or_else(|| "手机临时公钥无效".to_string())?,
        );
        let shared = record.desktop_secret.diffie_hellman(&client_public);
        if shared.as_bytes().iter().all(|byte| *byte == 0) {
            return Err("手机临时公钥无效".into());
        }
        let key = derive_pairing_key(
            shared.as_bytes(),
            record.public.code.as_bytes(),
            &pairing_id,
            &sender_device_id,
            &credentials.desktop_device_id,
        );
        let plaintext = serde_json::to_vec(&json!({
            "protocolVersion": PROTOCOL_VERSION,
            "publicWebUrl": credentials.public_web_url,
            "roomId": credentials.room_id,
            "desktopDeviceId": credentials.desktop_device_id,
            "token": credentials.access_token,
            "key": credentials.encryption_key,
        }))
        .map_err(|_| "无法编码公网配对凭据".to_string())?;
        let encrypted = encrypt_credentials(
            &key,
            &pairing_id,
            &sender_device_id,
            &credentials.desktop_device_id,
            &plaintext,
        )?;
        let target = record.public.remote_device_id.clone();
        state.requests.remove(&pairing_id);
        send_locked(
            &state,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "kind": "pairing.completed",
                "messageId": uuid::Uuid::new_v4().to_string(),
                "pairingId": pairing_id,
                "senderDeviceId": credentials.desktop_device_id,
                "targetDeviceId": target,
                "payload": encrypted,
            }),
        )
    }

    async fn set_error(&self, error: String) {
        self.state.lock().await.last_error = Some(error);
    }

    async fn send(&self, message: Value) -> Result<(), String> {
        let state = self.state.lock().await;
        send_locked(&state, message)
    }
}

fn new_pairing_record(mobile: &OnlineRelayMobile, mode: &str) -> PairingRecord {
    let desktop_secret = StaticSecret::random();
    let desktop_public = PublicKey::from(&desktop_secret);
    let now = unix_timestamp_ms();
    PairingRecord {
        public: PendingRelayPairing {
            pairing_id: uuid::Uuid::new_v4().to_string(),
            remote_device_id: mobile.device_id.clone(),
            device_name: mobile.device_name.clone(),
            browser: mobile.browser.clone(),
            platform: mobile.platform.clone(),
            mode: mode.into(),
            code: generate_pairing_code(),
            requested_at: now,
            expires_at: now.saturating_add(PAIRING_TTL_MS),
        },
        desktop_secret,
        desktop_public_key: URL_SAFE_NO_PAD.encode(desktop_public.as_bytes()),
        failed_attempts: 0,
    }
}

fn parse_mobile(value: Value) -> Option<OnlineRelayMobile> {
    let device_id = value.get("deviceId")?.as_str()?.to_string();
    if device_id.len() < 8 {
        return None;
    }
    Some(OnlineRelayMobile {
        device_id,
        device_name: clean_field(
            value
                .get("deviceName")
                .and_then(Value::as_str)
                .unwrap_or("未命名手机"),
            80,
        ),
        browser: clean_field(
            value
                .get("browser")
                .and_then(Value::as_str)
                .unwrap_or("手机浏览器"),
            240,
        ),
        platform: clean_field(
            value
                .get("platform")
                .and_then(Value::as_str)
                .unwrap_or("未知系统"),
            120,
        ),
        connected_at: value
            .get("connectedAt")
            .and_then(Value::as_u64)
            .unwrap_or_else(unix_timestamp_ms),
        last_seen_at: value
            .get("lastSeenAt")
            .and_then(Value::as_u64)
            .unwrap_or_else(unix_timestamp_ms),
    })
}

fn send_locked(state: &RelayPairingState, message: Value) -> Result<(), String> {
    state
        .outbound
        .as_ref()
        .ok_or_else(|| "中继连接尚未就绪".to_string())?
        .send(message)
        .map_err(|_| "中继连接已经关闭".to_string())
}

fn purge_expired(state: &mut RelayPairingState) {
    let now = unix_timestamp_ms();
    state
        .requests
        .retain(|_, record| record.public.expires_at > now);
}

fn generate_pairing_code() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let value = u32::from_be_bytes(bytes[..4].try_into().unwrap_or_default()) % 1_000_000;
    format!("{value:06}")
}

fn proof_message(
    pairing_id: &str,
    mobile_device_id: &str,
    desktop_device_id: &str,
    client_public_key: &str,
    desktop_public_key: &str,
    request_nonce: &str,
) -> String {
    format!(
        "codex-compass-relay-pairing-proof-v1\n{pairing_id}\n{mobile_device_id}\n{desktop_device_id}\n{client_public_key}\n{desktop_public_key}\n{request_nonce}"
    )
}

fn derive_pairing_key(
    shared_secret: &[u8; 32],
    code: &[u8],
    pairing_id: &str,
    mobile_device_id: &str,
    desktop_device_id: &str,
) -> [u8; 32] {
    let salt = Sha256::digest(code);
    let mut info = Vec::with_capacity(
        42 + pairing_id.len() + mobile_device_id.len() + desktop_device_id.len(),
    );
    info.extend_from_slice(b"codex-compass-relay-pairing-key-v1\0");
    info.extend_from_slice(pairing_id.as_bytes());
    info.push(0);
    info.extend_from_slice(mobile_device_id.as_bytes());
    info.push(0);
    info.extend_from_slice(desktop_device_id.as_bytes());
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared_secret);
    let mut key = [0_u8; 32];
    hkdf.expand(&info, &mut key)
        .expect("32-byte HKDF output length is valid");
    key
}

fn verify_hmac(key: &[u8], message: &[u8], proof: &str) -> bool {
    let Ok(proof) = URL_SAFE_NO_PAD.decode(proof) else {
        return false;
    };
    let Ok(mut mac) = <HmacSha256 as Mac>::new_from_slice(key) else {
        return false;
    };
    mac.update(message);
    mac.verify_slice(&proof).is_ok()
}

fn encrypt_credentials(
    key: &[u8; 32],
    pairing_id: &str,
    mobile_device_id: &str,
    desktop_device_id: &str,
    plaintext: &[u8],
) -> Result<Value, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "无法初始化公网配对加密".to_string())?;
    let nonce_uuid = uuid::Uuid::new_v4();
    let nonce = &nonce_uuid.as_bytes()[..12];
    let aad = format!(
        "codex-compass-relay-pairing-payload-v1\n{pairing_id}\n{mobile_device_id}\n{desktop_device_id}"
    );
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "无法加密公网配对凭据".to_string())?;
    Ok(json!({
        "nonce": URL_SAFE_NO_PAD.encode(nonce),
        "ciphertext": URL_SAFE_NO_PAD.encode(ciphertext),
        "aad": aad,
    }))
}

fn decode_fixed<const N: usize>(value: &str) -> Option<[u8; N]> {
    URL_SAFE_NO_PAD.decode(value).ok()?.try_into().ok()
}

fn required_string(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("公网配对消息缺少 {name}"))
}

fn clean_field(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_pairing_key_and_proof_are_deterministic() {
        let shared = [8_u8; 32];
        let first = derive_pairing_key(&shared, b"123456", "pair", "mobile", "desktop");
        let second = derive_pairing_key(&shared, b"123456", "pair", "mobile", "desktop");
        assert_eq!(first, second);
        assert_eq!(
            hex::encode(first),
            "2c074647ed6dbfc30d19a7191169b190b396aa389bd4213e9d922967c9330dcb"
        );

        let message = proof_message(
            "pair",
            "mobile",
            "desktop",
            "mobile-key",
            "desktop-key",
            "nonce",
        );
        let mut mac = <HmacSha256 as Mac>::new_from_slice(b"123456").unwrap();
        mac.update(message.as_bytes());
        let proof = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        assert!(verify_hmac(b"123456", message.as_bytes(), &proof));
        assert!(!verify_hmac(b"654321", message.as_bytes(), &proof));
    }

    #[test]
    fn relay_pairing_credentials_are_encrypted() {
        let key = [4_u8; 32];
        let encrypted =
            encrypt_credentials(&key, "pair", "mobile", "desktop", b"secret-token").unwrap();
        assert!(!encrypted.to_string().contains("secret-token"));
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(
                    &URL_SAFE_NO_PAD
                        .decode(encrypted["nonce"].as_str().unwrap())
                        .unwrap(),
                ),
                Payload {
                    msg: &URL_SAFE_NO_PAD
                        .decode(encrypted["ciphertext"].as_str().unwrap())
                        .unwrap(),
                    aad: encrypted["aad"].as_str().unwrap().as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(plaintext, b"secret-token");
    }
}
