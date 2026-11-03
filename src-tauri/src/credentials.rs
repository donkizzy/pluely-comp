// Provider settings (which may contain API keys) live in the OS credential
// store, never in a plaintext file.

fn provider_entry(key: &str) -> Result<keyring::Entry, String> {
    if !matches!(
        key,
        "curl_selected_ai_provider"
            | "curl_selected_stt_provider"
            | "curl_custom_ai_providers"
            | "curl_custom_speech_providers"
    ) {
        return Err("Invalid provider storage key".to_string());
    }
    keyring::Entry::new("com.srikanthnani.pluely", key)
        .map_err(|_| "OS credential store unavailable".to_string())
}

#[tauri::command]
pub fn provider_settings_get(key: String) -> Result<Option<String>, String> {
    match provider_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read provider credentials".to_string()),
    }
}

#[tauri::command]
pub fn provider_settings_save(key: String, value: String) -> Result<(), String> {
    provider_entry(&key)?
        .set_password(&value)
        .map_err(|_| "Could not save provider credentials".to_string())
}
