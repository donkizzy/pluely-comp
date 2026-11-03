fn main() {
    dotenvy::dotenv().ok();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // cidre's Swift bridge uses the system Swift concurrency runtime.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    if let Ok(posthog_api_key) = std::env::var("POSTHOG_API_KEY") {
        println!("cargo:rustc-env=POSTHOG_API_KEY={}", posthog_api_key);
    }

    tauri_build::build()
}
