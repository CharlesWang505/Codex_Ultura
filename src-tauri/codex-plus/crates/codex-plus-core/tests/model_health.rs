use codex_plus_core::model_health::{
    MODEL_HEALTH_INTERVAL, MODEL_HEALTH_MAX_CONCURRENCY, ModelHealthAvailability,
    ModelHealthTransition, ProbeTargetStatus, resolve_probe_target, transition_for,
};
use codex_plus_core::settings::{BackendSettings, RelayMode, RelayProfile, SettingsStore};
use std::time::Duration;

fn profile(test_model: &str, model: &str) -> RelayProfile {
    RelayProfile {
        id: "relay-a".to_string(),
        name: "Relay A".to_string(),
        model: model.to_string(),
        base_url: "https://relay.example/v1".to_string(),
        upstream_base_url: "https://relay.example/v1".to_string(),
        api_key: "sk-test".to_string(),
        relay_mode: RelayMode::PureApi,
        test_model: test_model.to_string(),
        ..RelayProfile::default()
    }
}

#[test]
fn model_health_check_is_disabled_by_default() {
    assert!(!BackendSettings::default().model_health_check_enabled);
}

#[test]
fn settings_without_model_health_flag_remain_compatible() {
    let settings: BackendSettings = serde_json::from_value(serde_json::json!({})).unwrap();

    assert!(!settings.model_health_check_enabled);
}

#[test]
fn settings_store_loads_legacy_file_and_update_persists_model_health_flag() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let store = SettingsStore::new(path);

    assert!(!store.load().unwrap().model_health_check_enabled);

    let enabled = store
        .update(serde_json::json!({ "modelHealthCheckEnabled": true }))
        .unwrap();
    assert!(enabled.model_health_check_enabled);
    assert!(store.load().unwrap().model_health_check_enabled);

    let disabled = store
        .update(serde_json::json!({ "modelHealthCheckEnabled": false }))
        .unwrap();
    assert!(!disabled.model_health_check_enabled);
}

#[test]
fn model_health_interval_and_concurrency_are_fixed() {
    assert_eq!(MODEL_HEALTH_INTERVAL, Duration::from_secs(10 * 60));
    assert_eq!(MODEL_HEALTH_MAX_CONCURRENCY, 3);
}

#[test]
fn resolves_test_model_before_profile_and_global_model() {
    let target = resolve_probe_target(&profile("custom-test", "default-model"), "global-model");

    assert_eq!(target.model, "custom-test");
    assert_eq!(target.status, ProbeTargetStatus::Ready);
}

#[test]
fn falls_back_to_profile_model_then_global_model() {
    let profile_model = resolve_probe_target(&profile("", "default-model"), "global-model");
    let global_model = resolve_probe_target(&profile("", ""), "global-model");
    let config_model = resolve_probe_target(
        &RelayProfile {
            model: String::new(),
            config_contents: "model = \"config-model\"".to_string(),
            ..profile("", "")
        },
        "global-model",
    );

    assert_eq!(profile_model.model, "default-model");
    assert_eq!(global_model.model, "global-model");
    assert_eq!(config_model.model, "config-model");
}

#[test]
fn skips_aggregate_and_official_account_only_profiles() {
    let aggregate = RelayProfile {
        relay_mode: RelayMode::Aggregate,
        ..profile("gpt-5", "gpt-5")
    };
    let official = RelayProfile {
        relay_mode: RelayMode::Official,
        official_mix_api_key: false,
        api_key: String::new(),
        ..profile("gpt-5", "gpt-5")
    };

    assert_eq!(
        resolve_probe_target(&aggregate, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&official, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
}

#[test]
fn skips_profiles_with_incomplete_api_configuration() {
    let missing_url = RelayProfile {
        upstream_base_url: String::new(),
        base_url: String::new(),
        ..profile("gpt-5", "gpt-5")
    };
    let placeholder_url = RelayProfile {
        upstream_base_url: "https://".to_string(),
        base_url: "https://".to_string(),
        ..profile("gpt-5", "gpt-5")
    };
    let missing_key = RelayProfile {
        api_key: String::new(),
        ..profile("gpt-5", "gpt-5")
    };
    let missing_model = profile("", "");

    assert_eq!(
        resolve_probe_target(&missing_url, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&placeholder_url, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&missing_key, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&missing_model, "").status,
        ProbeTargetStatus::Skipped
    );
}

#[test]
fn skips_base_urls_with_credentials_query_or_fragment() {
    for base_url in [
        "https://user:secret@relay.example/v1",
        "https://relay.example/v1?token=secret",
        "https://relay.example/v1#responses",
    ] {
        let profile = RelayProfile {
            base_url: base_url.to_string(),
            upstream_base_url: base_url.to_string(),
            ..profile("gpt-5", "gpt-5")
        };

        assert_eq!(
            resolve_probe_target(&profile, "gpt-5").status,
            ProbeTargetStatus::Skipped,
            "{base_url} should not be probed",
        );
    }
}

#[test]
fn first_failure_notifies_but_first_success_does_not() {
    assert_eq!(
        transition_for(None, ModelHealthAvailability::Unavailable),
        Some(ModelHealthTransition::Failed),
    );
    assert_eq!(
        transition_for(None, ModelHealthAvailability::Available),
        None
    );
}

#[test]
fn repeated_status_does_not_notify_and_recovery_does() {
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Available),
            ModelHealthAvailability::Unavailable,
        ),
        Some(ModelHealthTransition::Failed),
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Unavailable),
            ModelHealthAvailability::Unavailable,
        ),
        None,
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Unavailable),
            ModelHealthAvailability::Available,
        ),
        Some(ModelHealthTransition::Recovered),
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Available),
            ModelHealthAvailability::Available,
        ),
        None,
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Skipped),
            ModelHealthAvailability::Unavailable,
        ),
        Some(ModelHealthTransition::Failed),
    );
}
