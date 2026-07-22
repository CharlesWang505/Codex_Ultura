use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::relay_config::{relay_profile_api_key, relay_profile_base_url, relay_profile_model};
use crate::settings::{RelayMode, RelayProfile};

pub const MODEL_HEALTH_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const MODEL_HEALTH_MAX_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelHealthAvailability {
    Available,
    Unavailable,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelHealthTransition {
    Failed,
    Recovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeTargetStatus {
    Ready,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelHealthProbeTarget {
    pub relay_id: String,
    pub relay_name: String,
    pub model: String,
    pub status: ProbeTargetStatus,
    pub detail: String,
}

pub fn resolve_probe_target(
    profile: &RelayProfile,
    global_test_model: &str,
) -> ModelHealthProbeTarget {
    let relay_name = if profile.name.trim().is_empty() {
        "未命名供应商".to_string()
    } else {
        profile.name.trim().to_string()
    };
    let model = if !profile.test_model.trim().is_empty() {
        profile.test_model.trim().to_string()
    } else {
        let profile_model = relay_profile_model(profile);
        if profile_model.trim().is_empty() {
            global_test_model.trim().to_string()
        } else {
            profile_model.trim().to_string()
        }
    };
    let skipped = |detail: &str| ModelHealthProbeTarget {
        relay_id: profile.id.clone(),
        relay_name: relay_name.clone(),
        model: model.clone(),
        status: ProbeTargetStatus::Skipped,
        detail: detail.to_string(),
    };

    if profile.relay_mode == RelayMode::Aggregate {
        return skipped("聚合供应商由成员供应商分别检测。");
    }
    if profile.relay_mode == RelayMode::Official && relay_profile_api_key(profile).trim().is_empty()
    {
        return skipped("仅使用官方账号登录，无需 API 模型检测。");
    }
    if !is_usable_http_base_url(&relay_profile_base_url(profile)) {
        return skipped("Base URL 为空或格式不受支持，无法检测。");
    }
    if relay_profile_api_key(profile).trim().is_empty() {
        return skipped("API Key 为空，无法检测。");
    }
    if model.is_empty() {
        return skipped("测试模型为空，无法检测。");
    }

    ModelHealthProbeTarget {
        relay_id: profile.id.clone(),
        relay_name,
        model,
        status: ProbeTargetStatus::Ready,
        detail: "等待检测。".to_string(),
    }
}

pub fn transition_for(
    previous: Option<ModelHealthAvailability>,
    next: ModelHealthAvailability,
) -> Option<ModelHealthTransition> {
    match (previous, next) {
        (None, ModelHealthAvailability::Unavailable)
        | (Some(ModelHealthAvailability::Skipped), ModelHealthAvailability::Unavailable)
        | (Some(ModelHealthAvailability::Available), ModelHealthAvailability::Unavailable) => {
            Some(ModelHealthTransition::Failed)
        }
        (Some(ModelHealthAvailability::Unavailable), ModelHealthAvailability::Available) => {
            Some(ModelHealthTransition::Recovered)
        }
        (None, ModelHealthAvailability::Available | ModelHealthAvailability::Skipped)
        | (
            Some(ModelHealthAvailability::Available),
            ModelHealthAvailability::Available | ModelHealthAvailability::Skipped,
        )
        | (
            Some(ModelHealthAvailability::Unavailable),
            ModelHealthAvailability::Unavailable | ModelHealthAvailability::Skipped,
        )
        | (
            Some(ModelHealthAvailability::Skipped),
            ModelHealthAvailability::Available | ModelHealthAvailability::Skipped,
        ) => None,
    }
}

fn is_usable_http_base_url(value: &str) -> bool {
    Url::parse(value.trim()).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}
