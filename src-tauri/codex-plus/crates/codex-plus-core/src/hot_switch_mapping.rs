use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};

use crate::model_suffix::ModelCatalogEntry;
use crate::settings::{BackendSettings, HotSwitchModelMapping, RelayMode, RelayProfile};

pub const HOT_SWITCH_AUTO_MODEL_ID: &str = "codex-compass-auto";
pub const HOT_SWITCH_AUTO_MODEL_DISPLAY_NAME: &str = "Codex Compass 自动模型";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotSwitchProviderScan {
    pub relay_id: String,
    pub relay_name: String,
    pub endpoint: String,
    pub models: Vec<String>,
    pub error: String,
}

impl HotSwitchProviderScan {
    pub fn succeeded(&self) -> bool {
        self.error.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotSwitchMappingScan {
    pub mappings: Vec<HotSwitchModelMapping>,
    pub providers: Vec<HotSwitchProviderScan>,
    pub conflict_count: usize,
    pub failed_provider_count: usize,
}

#[derive(Debug, Clone)]
pub struct HotSwitchResolvedRoute {
    pub relay: RelayProfile,
    pub fallback_relays: Vec<RelayProfile>,
    pub requested_model: String,
    pub upstream_model: String,
    pub reasoning: String,
    pub mapped: bool,
}

pub async fn scan_hot_switch_model_mappings(settings: &BackendSettings) -> HotSwitchMappingScan {
    let profiles = eligible_profiles(settings);
    let scans = join_all(profiles.into_iter().map(|profile| async move {
        match crate::model_catalog::fetch_relay_profile_model_ids(&profile).await {
            Ok((models, endpoint)) => HotSwitchProviderScan {
                relay_id: profile.id,
                relay_name: profile.name,
                endpoint,
                models,
                error: String::new(),
            },
            Err(error) => HotSwitchProviderScan {
                relay_id: profile.id,
                relay_name: profile.name,
                endpoint: String::new(),
                models: Vec::new(),
                error: error.to_string(),
            },
        }
    }))
    .await;
    build_mapping_scan(settings, scans)
}

pub fn build_mapping_scan(
    settings: &BackendSettings,
    providers: Vec<HotSwitchProviderScan>,
) -> HotSwitchMappingScan {
    let relay_order = settings
        .relay_profiles
        .iter()
        .enumerate()
        .map(|(index, profile)| (profile.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let failed_relay_ids = providers
        .iter()
        .filter(|scan| !scan.succeeded())
        .map(|scan| scan.relay_id.as_str())
        .collect::<HashSet<_>>();
    let valid_relay_ids = eligible_profiles(settings)
        .into_iter()
        .map(|profile| profile.id)
        .collect::<HashSet<_>>();
    let previous_by_alias = settings
        .hot_switch_model_mappings
        .iter()
        .map(|mapping| (mapping.model.as_str(), mapping))
        .collect::<HashMap<_, _>>();
    let previous_by_upstream = settings
        .hot_switch_model_mappings
        .iter()
        .map(|mapping| (mapping.upstream_model.as_str(), mapping))
        .collect::<HashMap<_, _>>();
    let mut candidates = HashMap::<String, Vec<String>>::new();

    for scan in providers.iter().filter(|scan| scan.succeeded()) {
        for model in &scan.models {
            let model = model.trim();
            if model.is_empty() {
                continue;
            }
            let relay_ids = candidates.entry(model.to_string()).or_default();
            if !relay_ids.contains(&scan.relay_id) {
                relay_ids.push(scan.relay_id.clone());
            }
        }
    }

    // 某个供应商临时扫描失败时保留其旧候选，避免一次网络抖动清空已有映射。
    for mapping in &settings.hot_switch_model_mappings {
        for relay_id in &mapping.candidate_relay_ids {
            if failed_relay_ids.contains(relay_id.as_str()) && valid_relay_ids.contains(relay_id) {
                let relay_ids = candidates.entry(mapping.model.clone()).or_default();
                if !relay_ids.contains(relay_id) {
                    relay_ids.push(relay_id.clone());
                }
            }
        }
    }

    let mut models = candidates.keys().cloned().collect::<Vec<_>>();
    models.sort_by_key(|model| model.to_ascii_lowercase());
    let mappings = models
        .into_iter()
        .filter_map(|model| {
            let mut relay_ids = candidates.remove(&model).unwrap_or_default();
            relay_ids.sort_by_key(|relay_id| {
                relay_order
                    .get(relay_id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX)
            });
            relay_ids.dedup();
            // 用户可以把 Codex 中显示的模型名改成别名。重新扫描时应按真实上游
            // 模型找到旧规则，而不是只按已经改过的别名匹配。
            let old = previous_by_upstream
                .get(model.as_str())
                .copied()
                .filter(|mapping| relay_ids.contains(&mapping.relay_id))
                .or_else(|| previous_by_alias.get(model.as_str()).copied());
            let relay_id = old
                .filter(|mapping| relay_ids.contains(&mapping.relay_id))
                .map(|mapping| mapping.relay_id.clone())
                .or_else(|| relay_ids.first().cloned())?;
            let upstream_model = old
                .filter(|mapping| {
                    mapping.relay_id == relay_id && !mapping.upstream_model.trim().is_empty()
                })
                .map(|mapping| mapping.upstream_model.clone())
                .unwrap_or_else(|| model.clone());
            Some(HotSwitchModelMapping {
                model: old
                    .filter(|mapping| !mapping.model.trim().is_empty())
                    .map(|mapping| mapping.model.clone())
                    .unwrap_or_else(|| model.clone()),
                upstream_model,
                relay_id,
                candidate_relay_ids: relay_ids,
                fallback_relay_ids: old
                    .map(|mapping| mapping.fallback_relay_ids.clone())
                    .unwrap_or_default(),
                reasoning_override: old
                    .map(|mapping| mapping.reasoning_override.clone())
                    .unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let conflict_count = mappings
        .iter()
        .filter(|mapping| mapping.candidate_relay_ids.len() > 1)
        .count();
    let failed_provider_count = providers.iter().filter(|scan| !scan.succeeded()).count();
    HotSwitchMappingScan {
        mappings,
        providers,
        conflict_count,
        failed_provider_count,
    }
}

pub fn resolve_hot_switch_route(
    settings: &BackendSettings,
    requested_model: &str,
) -> anyhow::Result<Option<HotSwitchResolvedRoute>> {
    if !settings.hot_switch_enabled {
        return Ok(None);
    }
    let requested_model = requested_model.trim().to_string();
    if settings.hot_switch_auto_model_enabled && requested_model == HOT_SWITCH_AUTO_MODEL_ID {
        let mut relay = settings.hot_switch_relay_profile();
        let upstream_model = if !settings.hot_switch_model.trim().is_empty() {
            settings.hot_switch_model.trim().to_string()
        } else {
            relay.model.trim().to_string()
        };
        if upstream_model.is_empty() {
            anyhow::bail!("Codex Compass 自动模型尚未选择实际模型");
        }
        relay.model = upstream_model.clone();
        return Ok(Some(HotSwitchResolvedRoute {
            relay,
            fallback_relays: Vec::new(),
            requested_model,
            upstream_model,
            reasoning: settings.default_reasoning.clone(),
            mapped: true,
        }));
    }
    if settings.hot_switch_model_routing_enabled && !requested_model.is_empty() {
        if let Some(mapping) = settings
            .hot_switch_model_mappings
            .iter()
            .find(|mapping| mapping.model == requested_model)
        {
            let mut relay = relay_profile_by_id(settings, &mapping.relay_id).ok_or_else(|| {
                anyhow::anyhow!(
                    "模型「{}」映射的供应商「{}」不存在",
                    mapping.model,
                    mapping.relay_id
                )
            })?;
            relay.model = mapping.upstream_model.clone();
            let fallback_relays = mapping
                .fallback_relay_ids
                .iter()
                .filter(|relay_id| *relay_id != &mapping.relay_id)
                .filter_map(|relay_id| relay_profile_by_id(settings, relay_id))
                .map(|mut fallback| {
                    fallback.model = mapping.upstream_model.clone();
                    fallback
                })
                .collect();
            return Ok(Some(HotSwitchResolvedRoute {
                relay,
                fallback_relays,
                requested_model,
                upstream_model: mapping.upstream_model.clone(),
                reasoning: if mapping.reasoning_override.trim().is_empty()
                    || mapping.reasoning_override == "inherit"
                {
                    settings.default_reasoning.clone()
                } else {
                    mapping.reasoning_override.clone()
                },
                mapped: true,
            }));
        }
    }

    let mut relay = settings.hot_switch_relay_profile();
    let upstream_model = if settings.hot_switch_model_routing_enabled && !requested_model.is_empty()
    {
        requested_model.clone()
    } else if !settings.hot_switch_model.trim().is_empty() {
        settings.hot_switch_model.trim().to_string()
    } else {
        requested_model.clone()
    };
    relay.model = upstream_model.clone();
    Ok(Some(HotSwitchResolvedRoute {
        relay,
        fallback_relays: Vec::new(),
        requested_model,
        upstream_model,
        reasoning: settings.default_reasoning.clone(),
        mapped: false,
    }))
}

pub fn hot_switch_catalog_entries(settings: &BackendSettings) -> Vec<ModelCatalogEntry> {
    let provider_names = settings
        .relay_profiles
        .iter()
        .map(|profile| (profile.id.as_str(), profile.name.as_str()))
        .collect::<HashMap<_, _>>();
    let mut entries = Vec::new();
    if settings.hot_switch_auto_model_enabled {
        entries.push(ModelCatalogEntry {
            slug: HOT_SWITCH_AUTO_MODEL_ID.to_string(),
            display_name: HOT_SWITCH_AUTO_MODEL_DISPLAY_NAME.to_string(),
            suffix_window: None,
        });
    }
    if settings.hot_switch_model_routing_enabled {
        entries.extend(
            settings
                .hot_switch_model_mappings
                .iter()
                .filter(|mapping| mapping.model != HOT_SWITCH_AUTO_MODEL_ID)
                .map(|mapping| ModelCatalogEntry {
                    slug: mapping.model.clone(),
                    display_name: provider_names
                        .get(mapping.relay_id.as_str())
                        .filter(|name| !name.trim().is_empty())
                        .map(|name| format!("{} · {}", mapping.model, name))
                        .unwrap_or_else(|| mapping.model.clone()),
                    suffix_window: mapping_context_window(settings, mapping),
                }),
        );
    }
    entries
}

pub fn hot_switch_default_model(settings: &BackendSettings) -> Option<String> {
    if settings.hot_switch_auto_model_enabled {
        return Some(HOT_SWITCH_AUTO_MODEL_ID.to_string());
    }
    let matching = settings.hot_switch_model_mappings.iter().find(|mapping| {
        mapping.relay_id == settings.hot_switch_relay_id
            && mapping.upstream_model == settings.hot_switch_model
    });
    matching
        .or_else(|| settings.hot_switch_model_mappings.first())
        .map(|mapping| mapping.model.clone())
        .or_else(|| {
            (!settings.hot_switch_model.trim().is_empty())
                .then(|| settings.hot_switch_model.trim().to_string())
        })
}

pub fn hot_switch_models_api_payload(
    settings: &BackendSettings,
    codex_catalog_format: bool,
) -> Option<Value> {
    let entries = hot_switch_catalog_entries(settings);
    if !settings.hot_switch_enabled || entries.is_empty() {
        return None;
    }
    if codex_catalog_format {
        return serde_json::from_str(&crate::model_suffix::build_model_catalog_json(
            &entries, None,
        ))
        .ok();
    }
    let data = entries
        .iter()
        .map(|entry| {
            let owner = if entry.slug == HOT_SWITCH_AUTO_MODEL_ID {
                "Codex Compass"
            } else {
                settings
                    .hot_switch_model_mappings
                    .iter()
                    .find(|mapping| mapping.model == entry.slug)
                    .and_then(|mapping| {
                        settings
                            .relay_profiles
                            .iter()
                            .find(|profile| profile.id == mapping.relay_id)
                            .map(|profile| profile.name.as_str())
                            .or(Some(mapping.relay_id.as_str()))
                    })
                    .unwrap_or("Codex Compass")
            };
            json!({
                "id": entry.slug,
                "object": "model",
                "owned_by": owner,
                "display_name": entry.display_name
            })
        })
        .collect::<Vec<_>>();
    Some(json!({
        "object": "list",
        "data": data
    }))
}

fn eligible_profiles(settings: &BackendSettings) -> Vec<RelayProfile> {
    settings
        .relay_profiles
        .iter()
        .filter(|profile| {
            profile.relay_mode != RelayMode::Aggregate
                && !profile.base_url.trim().is_empty()
                && !profile.api_key.trim().is_empty()
        })
        .cloned()
        .collect()
}

fn relay_profile_by_id(settings: &BackendSettings, relay_id: &str) -> Option<RelayProfile> {
    settings
        .relay_profiles
        .iter()
        .find(|profile| profile.id == relay_id && profile.relay_mode != RelayMode::Aggregate)
        .cloned()
}

fn mapping_context_window(
    settings: &BackendSettings,
    mapping: &HotSwitchModelMapping,
) -> Option<u64> {
    let profile = settings
        .relay_profiles
        .iter()
        .find(|profile| profile.id == mapping.relay_id)?;
    let windows =
        serde_json::from_str::<HashMap<String, String>>(&profile.model_windows).unwrap_or_default();
    crate::model_suffix::collect_catalog_entries(
        &profile.model_list,
        &windows,
        &mapping.upstream_model,
    )
    .into_iter()
    .find(|entry| entry.slug == mapping.upstream_model)
    .and_then(|entry| entry.suffix_window)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{RelayMode, RelayProfile};

    fn profile(id: &str, name: &str) -> RelayProfile {
        RelayProfile {
            id: id.to_string(),
            name: name.to_string(),
            base_url: format!("https://{id}.example/v1"),
            upstream_base_url: format!("https://{id}.example/v1"),
            api_key: format!("sk-{id}"),
            relay_mode: RelayMode::PureApi,
            ..RelayProfile::default()
        }
    }

    #[test]
    fn mapping_scan_auto_maps_unique_models_and_marks_conflicts() {
        let settings = BackendSettings {
            relay_profiles: vec![profile("a", "A"), profile("b", "B")],
            ..BackendSettings::default()
        };
        let scan = build_mapping_scan(
            &settings,
            vec![
                HotSwitchProviderScan {
                    relay_id: "a".to_string(),
                    relay_name: "A".to_string(),
                    endpoint: "https://a.example/v1/models".to_string(),
                    models: vec!["model-a".to_string(), "shared".to_string()],
                    error: String::new(),
                },
                HotSwitchProviderScan {
                    relay_id: "b".to_string(),
                    relay_name: "B".to_string(),
                    endpoint: "https://b.example/v1/models".to_string(),
                    models: vec!["model-b".to_string(), "shared".to_string()],
                    error: String::new(),
                },
            ],
        );

        assert_eq!(scan.mappings.len(), 3);
        assert_eq!(scan.conflict_count, 1);
        let shared = scan
            .mappings
            .iter()
            .find(|mapping| mapping.model == "shared")
            .unwrap();
        assert_eq!(shared.relay_id, "a");
        assert_eq!(shared.candidate_relay_ids, vec!["a", "b"]);
    }

    #[test]
    fn mapping_scan_preserves_previous_conflict_choice() {
        let settings = BackendSettings {
            relay_profiles: vec![profile("a", "A"), profile("b", "B")],
            hot_switch_model_mappings: vec![HotSwitchModelMapping {
                model: "shared".to_string(),
                upstream_model: "shared".to_string(),
                relay_id: "b".to_string(),
                candidate_relay_ids: vec!["a".to_string(), "b".to_string()],
                ..HotSwitchModelMapping::default()
            }],
            ..BackendSettings::default()
        };
        let scan = build_mapping_scan(
            &settings,
            vec![
                HotSwitchProviderScan {
                    relay_id: "a".to_string(),
                    relay_name: "A".to_string(),
                    endpoint: String::new(),
                    models: vec!["shared".to_string()],
                    error: String::new(),
                },
                HotSwitchProviderScan {
                    relay_id: "b".to_string(),
                    relay_name: "B".to_string(),
                    endpoint: String::new(),
                    models: vec!["shared".to_string()],
                    error: String::new(),
                },
            ],
        );

        assert_eq!(scan.mappings[0].relay_id, "b");
    }

    #[test]
    fn mapping_scan_preserves_custom_codex_alias() {
        let settings = BackendSettings {
            relay_profiles: vec![profile("a", "A")],
            hot_switch_model_mappings: vec![HotSwitchModelMapping {
                model: "my-claude".to_string(),
                upstream_model: "claude-opus-4-5".to_string(),
                relay_id: "a".to_string(),
                candidate_relay_ids: vec!["a".to_string()],
                ..HotSwitchModelMapping::default()
            }],
            ..BackendSettings::default()
        };
        let scan = build_mapping_scan(
            &settings,
            vec![HotSwitchProviderScan {
                relay_id: "a".to_string(),
                relay_name: "A".to_string(),
                endpoint: String::new(),
                models: vec!["claude-opus-4-5".to_string()],
                error: String::new(),
            }],
        );

        assert_eq!(scan.mappings[0].model, "my-claude");
        assert_eq!(scan.mappings[0].upstream_model, "claude-opus-4-5");
    }

    #[test]
    fn resolver_uses_codex_model_to_choose_provider_and_upstream_model() {
        let settings = BackendSettings {
            hot_switch_enabled: true,
            hot_switch_model_routing_enabled: true,
            relay_profiles: vec![profile("a", "A"), profile("b", "B")],
            hot_switch_model_mappings: vec![HotSwitchModelMapping {
                model: "codex-choice".to_string(),
                upstream_model: "real-model".to_string(),
                relay_id: "b".to_string(),
                candidate_relay_ids: vec!["b".to_string()],
                fallback_relay_ids: vec!["a".to_string()],
                reasoning_override: "high".to_string(),
            }],
            ..BackendSettings::default()
        };

        let route = resolve_hot_switch_route(&settings, "codex-choice")
            .unwrap()
            .unwrap();
        assert!(route.mapped);
        assert_eq!(route.relay.id, "b");
        assert_eq!(route.fallback_relays[0].id, "a");
        assert_eq!(route.upstream_model, "real-model");
        assert_eq!(route.reasoning, "high");
    }

    #[test]
    fn resolver_auto_model_uses_current_floating_target() {
        let mut settings = BackendSettings {
            hot_switch_enabled: true,
            hot_switch_auto_model_enabled: true,
            hot_switch_relay_id: "b".to_string(),
            hot_switch_model: "model-from-floating".to_string(),
            default_reasoning: "xhigh".to_string(),
            relay_profiles: vec![profile("a", "A"), profile("b", "B")],
            ..BackendSettings::default()
        };

        let route = resolve_hot_switch_route(&settings, HOT_SWITCH_AUTO_MODEL_ID)
            .unwrap()
            .unwrap();
        assert!(route.mapped);
        assert_eq!(route.relay.id, "b");
        assert_eq!(route.upstream_model, "model-from-floating");
        assert_eq!(route.reasoning, "xhigh");

        settings.hot_switch_relay_id = "a".to_string();
        settings.hot_switch_model = "next-model".to_string();
        let next_route = resolve_hot_switch_route(&settings, HOT_SWITCH_AUTO_MODEL_ID)
            .unwrap()
            .unwrap();
        assert_eq!(next_route.relay.id, "a");
        assert_eq!(next_route.upstream_model, "next-model");
    }

    #[test]
    fn auto_model_is_exposed_without_regular_mappings_and_becomes_default() {
        let settings = BackendSettings {
            hot_switch_enabled: true,
            hot_switch_auto_model_enabled: true,
            relay_profiles: vec![profile("a", "Provider A")],
            ..BackendSettings::default()
        };

        assert_eq!(
            hot_switch_default_model(&settings).as_deref(),
            Some(HOT_SWITCH_AUTO_MODEL_ID)
        );

        let payload = hot_switch_models_api_payload(&settings, false).unwrap();
        assert_eq!(payload["data"][0]["id"], HOT_SWITCH_AUTO_MODEL_ID);
        assert_eq!(payload["data"][0]["owned_by"], "Codex Compass");
        assert_eq!(
            payload["data"][0]["display_name"],
            HOT_SWITCH_AUTO_MODEL_DISPLAY_NAME
        );

        let catalog = hot_switch_models_api_payload(&settings, true).unwrap();
        assert_eq!(catalog["models"][0]["slug"], HOT_SWITCH_AUTO_MODEL_ID);
        assert_eq!(
            catalog["models"][0]["display_name"],
            HOT_SWITCH_AUTO_MODEL_DISPLAY_NAME
        );
    }

    #[test]
    fn models_api_payload_exposes_all_mapped_codex_models() {
        let settings = BackendSettings {
            hot_switch_enabled: true,
            hot_switch_model_routing_enabled: true,
            relay_profiles: vec![profile("a", "Provider A")],
            hot_switch_model_mappings: vec![HotSwitchModelMapping {
                model: "codex-choice".to_string(),
                upstream_model: "real-model".to_string(),
                relay_id: "a".to_string(),
                candidate_relay_ids: vec!["a".to_string()],
                ..HotSwitchModelMapping::default()
            }],
            ..BackendSettings::default()
        };

        let payload = hot_switch_models_api_payload(&settings, false).unwrap();

        assert_eq!(payload["object"], "list");
        assert_eq!(payload["data"][0]["id"], "codex-choice");
        assert_eq!(payload["data"][0]["owned_by"], "Provider A");
        assert_eq!(
            payload["data"][0]["display_name"],
            "codex-choice · Provider A"
        );

        let catalog = hot_switch_models_api_payload(&settings, true).unwrap();
        assert_eq!(catalog["models"][0]["slug"], "codex-choice");
        assert_eq!(
            catalog["models"][0]["display_name"],
            "codex-choice · Provider A"
        );
        assert!(
            catalog["models"][0]["supported_reasoning_levels"]
                .as_array()
                .is_some_and(|levels| levels.iter().any(|level| level["effort"] == "max"))
        );
    }
}
