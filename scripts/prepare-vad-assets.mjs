import { mkdir, readdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

// Keep executable VAD assets local so the desktop CSP can block remote scripts.
const destination = resolve("public/vad");
await mkdir(destination, { recursive: true });
for (const directory of ["node_modules/@ricky0123/vad-web/dist", "node_modules/onnxruntime-web/dist"]) {
  for (const name of await readdir(directory)) {
    if (/\.(onnx|wasm|mjs|js)$/.test(name)) {
      await copyFile(resolve(directory, name), resolve(destination, name));
    }
  }
}
