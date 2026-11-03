# Bundled local embedding model

Xenova/all-MiniLM-L6-v2, quantized ONNX (Apache-2.0).
Upstream: https://huggingface.co/Xenova/all-MiniLM-L6-v2
Pinned revision: 751bff37182d3f1213fa05d7196b954e230abad9
Based on sentence-transformers/all-MiniLM-L6-v2.
The upstream model card declares Apache-2.0; LICENSE contains that license.

Files are loaded from Tauri's resource directory. fastembed's Hugging Face
features are disabled. There are no model downloads at runtime.
CPU ONNX Runtime is linked by ort on each desktop target during the build.
