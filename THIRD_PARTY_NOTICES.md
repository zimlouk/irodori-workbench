# Third-party components

- The managed-protocol patches in `integration/server/` target [Aratako/Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server), commit `1fc3e100ed8e14ff30f6bfa6cb711a948960f8ce`. Its MIT notice is preserved in [LICENSE.upstream](integration/server/LICENSE.upstream).
- The separately installed [Aratako/Irodori-TTS](https://github.com/Aratako/Irodori-TTS) runtime is not bundled. Prepare the v4 runtime in its own environment and retain its upstream notices.
- Model, codec, tokenizer, LoRA weights, and reference audio are not distributed with this repository. They are independently supplied assets with their own accompanying terms.
- npm dependencies and Python dependencies retain their respective upstream licenses. Exact workbench dependency versions are recorded in `frontend/package-lock.json` and `requirements.lock.txt`.

The root MIT license applies to the workbench code; it does not replace licenses attached to third-party components or assets.
