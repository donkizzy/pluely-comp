use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

static MODEL: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();

pub fn embed(root: &Path, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    let mut lock = MODEL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Embedding engine unavailable")?;
    if lock.is_none() {
        let read = |name: &str| {
            std::fs::read(root.join(name)).map_err(|e| format!("Bundled model {name}: {e}"))
        };
        let model = UserDefinedEmbeddingModel::new(
            read("model.onnx")?,
            TokenizerFiles {
                tokenizer_file: read("tokenizer.json")?,
                config_file: read("config.json")?,
                special_tokens_map_file: read("special_tokens_map.json")?,
                tokenizer_config_file: read("tokenizer_config.json")?,
            },
        )
        .with_pooling(Pooling::Mean)
        .with_quantization(QuantizationMode::Dynamic);
        *lock = Some(
            TextEmbedding::try_new_from_user_defined(
                model,
                InitOptionsUserDefined::default().with_max_length(256),
            )
            .map_err(|e| format!("Local embeddings: {e}"))?,
        );
    }
    lock.as_mut()
        .ok_or("Embedding engine unavailable")?
        .embed(texts, Some(16))
        .map_err(|e| e.to_string())
}
