use crate::api::get_stored_credentials;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_machine_uid::MachineUidExt;
use uuid::Uuid;

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

fn get_payment_endpoint() -> Result<String, String> {
    if let Ok(endpoint) = env::var("PAYMENT_ENDPOINT") {
        return Ok(endpoint);
    }

    match option_env!("PAYMENT_ENDPOINT") {
        Some(endpoint) => Ok(endpoint.to_string()),
        None => Err("PAYMENT_ENDPOINT environment variable not set. Please ensure it's set during the build process.".to_string())
    }
}

fn get_api_access_key() -> Result<String, String> {
    if let Ok(key) = env::var("API_ACCESS_KEY") {
        return Ok(key);
    }

    Err("Set API_ACCESS_KEY in the runtime environment to use cloud features.".to_string())
}

// Credentials are held in the OS credential store, never in a plaintext JSON file.
#[derive(Serialize, Deserialize, Default)]
pub struct SecureStorage {
    pub(crate) license_key: Option<String>,
    pub(crate) instance_id: Option<String>,
    pub(crate) selected_pluely_model: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct StorageItem {
    key: String,
    value: String,
}

pub type StorageResult = SecureStorage;

fn storage_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.srikanthnani.pluely", "credentials")
        .map_err(|_| "OS credential store unavailable".to_string())
}

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

pub(crate) fn read_secure_storage(app: &AppHandle) -> Result<SecureStorage, String> {
    let _guard = STORAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_secure_storage_unlocked(app)
}

fn read_secure_storage_unlocked(app: &AppHandle) -> Result<SecureStorage, String> {
    let entry = storage_entry()?;
    let mut storage = match entry.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map_err(|_| "Invalid credentials in OS credential store".to_string())?,
        Err(keyring::Error::NoEntry) => SecureStorage::default(),
        Err(_) => return Err("Could not read OS credential store".to_string()),
    };
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data directory unavailable".to_string())?
        .join("secure_storage.json");
    if legacy.exists() {
        let text = fs::read_to_string(&legacy)
            .map_err(|_| "Could not read legacy credentials".to_string())?;
        let old: SecureStorage =
            serde_json::from_str(&text).map_err(|_| "Invalid legacy credentials".to_string())?;
        storage.license_key = storage.license_key.or(old.license_key);
        storage.instance_id = storage.instance_id.or(old.instance_id);
        storage.selected_pluely_model = storage.selected_pluely_model.or(old.selected_pluely_model);
        write_secure_storage(&storage)?;
        // Delete plaintext only after the secure write succeeds.
        fs::remove_file(legacy)
            .map_err(|_| "Could not remove legacy plaintext credentials".to_string())?;
    }
    Ok(storage)
}

fn write_secure_storage(storage: &SecureStorage) -> Result<(), String> {
    let value = serde_json::to_string(storage)
        .map_err(|_| "Could not serialize credentials".to_string())?;
    storage_entry()?
        .set_password(&value)
        .map_err(|_| "Could not write OS credential store".to_string())
}

#[tauri::command]
pub async fn secure_storage_save(app: AppHandle, items: Vec<StorageItem>) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut storage = read_secure_storage_unlocked(&app)?;
    for item in items {
        match item.key.as_str() {
            "pluely_license_key" => storage.license_key = Some(item.value),
            "pluely_instance_id" => storage.instance_id = Some(item.value),
            "selected_pluely_model" => storage.selected_pluely_model = Some(item.value),
            _ => return Err("Invalid storage key".to_string()),
        }
    }
    write_secure_storage(&storage)
}

#[tauri::command]
pub async fn secure_storage_get(app: AppHandle) -> Result<StorageResult, String> {
    read_secure_storage(&app)
}

#[tauri::command]
pub async fn secure_storage_remove(app: AppHandle, keys: Vec<String>) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut storage = read_secure_storage_unlocked(&app)?;
    for key in keys {
        match key.as_str() {
            "pluely_license_key" => storage.license_key = None,
            "pluely_instance_id" => storage.instance_id = None,
            "selected_pluely_model" => storage.selected_pluely_model = None,
            _ => return Err("Invalid storage key".to_string()),
        }
    }
    write_secure_storage(&storage)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ActivationRequest {
    license_key: String,
    instance_name: String,
    machine_id: String,
    app_version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ActivationResponse {
    activated: bool,
    error: Option<String>,
    license_key: Option<String>,
    instance: Option<InstanceInfo>,
    is_dev_license: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateResponse {
    is_active: bool,
    last_validated_at: Option<String>,
    is_dev_license: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstanceInfo {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckoutResponse {
    success: Option<bool>,
    checkout_url: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn activate_license_api(
    app: AppHandle,
    license_key: String,
) -> Result<ActivationResponse, String> {
    // Get payment endpoint and API access key from environment
    let payment_endpoint = get_payment_endpoint()?;
    let api_access_key = get_api_access_key()?;

    // Generate UUID for instance name
    let instance_name = Uuid::new_v4().to_string();
    let machine_id: String = app.machine_uid().get_machine_uid().unwrap().id.unwrap();
    let app_version: String = env!("CARGO_PKG_VERSION").to_string();
    // Prepare activation request
    let activation_request = ActivationRequest {
        license_key: license_key.clone(),
        instance_name: instance_name.clone(),
        machine_id: machine_id.clone(),
        app_version: app_version.clone(),
    };

    // Make HTTP request to activation endpoint with authorization header
    let client = reqwest::Client::new();
    let url = format!("{}/activate", payment_endpoint);

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .json(&activation_request)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make chat request: {}", parts[0])
                } else {
                    format!("Failed to make chat request: {}", error_msg)
                }
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        })?;

    let activation_response: ActivationResponse = response.json().await.map_err(|e| {
        let error_msg = format!("{}", e);
        if error_msg.contains("url (") {
            // Remove the URL part from the error message
            let parts: Vec<&str> = error_msg.split(" for url (").collect();
            if parts.len() > 1 {
                format!("Failed to make chat request: {}", parts[0])
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        } else {
            format!("Failed to make chat request: {}", error_msg)
        }
    })?;
    Ok(activation_response)
}

#[tauri::command]
pub async fn deactivate_license_api(app: AppHandle) -> Result<ActivationResponse, String> {
    // Get payment endpoint and API access key from environment
    let payment_endpoint = get_payment_endpoint()?;
    let api_access_key = get_api_access_key()?;
    let machine_id: String = app.machine_uid().get_machine_uid().unwrap().id.unwrap();
    let (license_key, instance_id, _) = get_stored_credentials(&app).await?;
    let app_version: String = env!("CARGO_PKG_VERSION").to_string();
    let deactivation_request = ActivationRequest {
        license_key: license_key.clone(),
        instance_name: instance_id.clone(),
        machine_id: machine_id.clone(),
        app_version: app_version.clone(),
    };
    // Make HTTP request to activation endpoint with authorization header
    let client = reqwest::Client::new();
    let url = format!("{}/deactivate", payment_endpoint);

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .json(&deactivation_request)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make chat request: {}", parts[0])
                } else {
                    format!("Failed to make chat request: {}", error_msg)
                }
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        })?;
    let deactivation_response: ActivationResponse = response.json().await.map_err(|e| {
        let error_msg = format!("{}", e);
        if error_msg.contains("url (") {
            // Remove the URL part from the error message
            let parts: Vec<&str> = error_msg.split(" for url (").collect();
            if parts.len() > 1 {
                format!("Failed to make chat request: {}", parts[0])
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        } else {
            format!("Failed to make chat request: {}", error_msg)
        }
    })?;
    Ok(deactivation_response)
}

#[tauri::command]
pub async fn validate_license_api(app: AppHandle) -> Result<ValidateResponse, String> {
    // Get payment endpoint and API access key from environment
    let payment_endpoint = get_payment_endpoint()?;
    let api_access_key = get_api_access_key()?;
    let machine_id: String = app.machine_uid().get_machine_uid().unwrap().id.unwrap();
    let (license_key, instance_id, _) = get_stored_credentials(&app).await?;
    let app_version: String = env!("CARGO_PKG_VERSION").to_string();
    let validate_request = ActivationRequest {
        license_key: license_key.clone(),
        instance_name: instance_id.clone(),
        machine_id: machine_id.clone(),
        app_version: app_version.clone(),
    };

    if license_key.is_empty() || instance_id.is_empty() {
        return Ok(ValidateResponse {
            is_active: false,
            last_validated_at: None,
            is_dev_license: false,
        });
    }

    // Make HTTP request to validate endpoint with authorization header
    let client = reqwest::Client::new();
    let url = format!("{}/validate", payment_endpoint);

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .json(&validate_request)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make chat request: {}", parts[0])
                } else {
                    format!("Failed to make chat request: {}", error_msg)
                }
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        })?;

    let validate_response: ValidateResponse = response.json().await.map_err(|e| {
        let error_msg = format!("{}", e);
        if error_msg.contains("url (") {
            // Remove the URL part from the error message
            let parts: Vec<&str> = error_msg.split(" for url (").collect();
            if parts.len() > 1 {
                format!("Failed to make chat request: {}", parts[0])
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        } else {
            format!("Failed to make chat request: {}", error_msg)
        }
    })?;
    Ok(validate_response)
}

#[tauri::command]
pub fn mask_license_key_cmd(license_key: String) -> String {
    if license_key.len() <= 8 {
        return "*".repeat(license_key.len());
    }

    let first_four = &license_key[..4];
    let last_four = &license_key[license_key.len() - 4..];
    let middle_stars = "*".repeat(license_key.len() - 8);

    format!("{}{}{}", first_four, middle_stars, last_four)
}

#[tauri::command]
pub async fn get_checkout_url() -> Result<CheckoutResponse, String> {
    // Get payment endpoint and API access key from environment
    let payment_endpoint = get_payment_endpoint()?;
    let api_access_key = get_api_access_key()?;

    // Make HTTP request to checkout endpoint with authorization header
    let client = reqwest::Client::new();
    let url = format!("{}/checkout", payment_endpoint);

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make chat request: {}", parts[0])
                } else {
                    format!("Failed to make chat request: {}", error_msg)
                }
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        })?;

    let checkout_response: CheckoutResponse = response.json().await.map_err(|e| {
        let error_msg = format!("{}", e);
        if error_msg.contains("url (") {
            // Remove the URL part from the error message
            let parts: Vec<&str> = error_msg.split(" for url (").collect();
            if parts.len() > 1 {
                format!("Failed to make chat request: {}", parts[0])
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        } else {
            format!("Failed to make chat request: {}", error_msg)
        }
    })?;
    Ok(checkout_response)
}
