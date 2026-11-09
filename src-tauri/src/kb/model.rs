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
    let model = lock.as_mut().ok_or("Embedding engine unavailable")?;
    // Dynamic quantization scales activations per batch, so fastembed rejects
    // any batch smaller than the input ("cannot be used with batching") and
    // vectors from different batches would not be comparable. Embed each text
    // on its own, exactly as search embeds a query, so stored chunks and
    // queries always share the same scale.
    let mut vectors = Vec::with_capacity(texts.len());
    for text in texts {
        let mut out = model.embed(vec![text], None).map_err(|e| e.to_string())?;
        vectors.push(out.pop().ok_or("Local embeddings returned no vector")?);
    }
    Ok(vectors)
}
