use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_machine_uid::MachineUidExt;

fn event_payload(
    event: &str,
    properties: Value,
    device_id: &str,
    token: &str,
) -> Result<Value, String> {
    if !matches!(event, "app_started" | "get_license") {
        return Err("Unsupported analytics event".to_string());
    }
    // Only the existing non-content event fields may leave the device.
    let mut allowed = Map::new();
    for key in ["app_version", "platform", "instance_id"] {
        if let Some(value) = properties.get(key).and_then(Value::as_str) {
            allowed.insert(
                key.to_string(),
                Value::String(value.chars().take(200).collect()),
            );
        }
    }
    allowed.insert("$device_id".to_string(), json!(device_id));
    Ok(json!({ "api_key": token, "event": event, "distinct_id": device_id, "properties": allowed }))
}

#[tauri::command]
pub async fn capture_analytics_event(
    app: AppHandle,
    event: String,
    properties: Value,
) -> Result<(), String> {
    let token = option_env!("POSTHOG_API_KEY").unwrap_or("");
    if token.is_empty() {
        return Ok(());
    }
    let device_id = app
        .machine_uid()
        .get_machine_uid()
        .ok()
        .and_then(|value| value.id)
        .ok_or_else(|| "Analytics device identifier unavailable".to_string())?;
    let payload = event_payload(&event, properties, &device_id, token)?;
    // Use the application's patched HTTP/TLS stack instead of the obsolete plugin SDK.
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Analytics client unavailable".to_string())?
        .post("https://us.i.posthog.com/i/v0/e/")
        .json(&payload)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "Analytics delivery failed".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analytics_excludes_credentials_and_conversation_content() {
        let payload = event_payload(
            "app_started",
            json!({
                "app_version": "0.1.9", "platform": "MacIntel", "instance_id": "instance",
                "api_key": "secret", "license_key": "secret", "message": "private conversation"
            }),
            "device",
            "public-ingestion-token",
        )
        .unwrap();
        let properties = payload["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 4);
        assert_eq!(properties["app_version"], "0.1.9");
        assert!(!properties.contains_key("message"));
        assert!(!properties.contains_key("api_key"));
        assert!(!properties.contains_key("license_key"));
        assert!(event_payload("$snapshot", json!({}), "device", "token").is_err());
    }
}
