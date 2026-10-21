# Irodori 配音工作台

面向 Windows 本机部署的双文本框配音工作台。粘贴原文、自动处理为逐句正文、选择音色后生成；文本、配置和历史自动保留，无需项目管理。

工作台业务服务和 Irodori GPU 推理环境分别安装。支持已有本机服务连接，也可由工作台启动配置的推理环境。当前要求同机、同文件系统，不包含模型权重或参考音频。

## 安装与启动

1. 安装工作台 Python 3.11+（当前验收基线3.14）与 Node.js `^20.19.0 || >=22.12.0`。
2. 运行 `Setup-Workbench.cmd`，安装锁定的业务依赖并构建页面；已有本机配置会保留。
3. 编辑自动生成的 `config.local.toml`；相对路径以该文件所在目录为准。
4. 运行 `Start-Workbench.cmd --check` 检查配置，再双击 `Start-Workbench.cmd` 启动。

无需GPU体验页面：

```powershell
.\Start-Workbench.cmd --mode fake
```

默认页面为 `http://127.0.0.1:8999`。可用 `--config PATH`、`--port PORT`、`--dev-port PORT`、`--data-dir PATH`、`--server-url URL`、`--no-browser` 覆盖启动选项。完整步骤见 [Windows 部署](docs/WINDOWS-SETUP.md) 和 [Server 集成](integration/server/README.md)。

## 本机配置

读取优先级：命令行 > 环境变量 > `config.local.toml` > 通用默认值。工作台不自动读取 `.env`；Server 环境文件需通过 `inference.env_file` 显式配置。

- `workbench`：模式、页面/开发端口、数据目录。
- `inference.launch_mode="external"`：连接已启动的兼容本机 Server。
- `inference.launch_mode="managed"`：通过指定的推理 Python 和仓库自带 `scripts/run_inference.py` 启动 Server。需要明确配置 Server、运行时和本地模型，不依赖其他未提供的启动脚本。
- `lora.root/catalog`：LoRA根目录和可选清单。清单中的相对路径以root为准；显式ID可保留旧预设，自动发现模型的ID不依赖盘符。
- `encoding.python`：可选的 soundfile 编码环境；未准备编码器时仍可使用 WAV/PCM。
- `presets.profile`：可选作品排序与批量预设默认参数，示例见 `config/voice-profile.example.json`。未指定时使用通用名称排序。

已使用工作台的用户应保留原 `data/` 和私有配置；不要用示例覆盖现有文件。配置化不会重建数据库，也不改写已有预设、Caption、替换规则或历史记录。

| 环境变量 | 配置对应项 |
|---|---|
| `IRODORI_WORKBENCH_CONFIG` | 本机TOML路径 |
| `IRODORI_WORKBENCH_MODE` | workbench.mode |
| `IRODORI_WORKBENCH_PORT` / `IRODORI_WORKBENCH_DEV_PORT` | workbench.port / dev_port |
| `IRODORI_WORKBENCH_DATA` | workbench.data_dir |
| `IRODORI_SERVER_URL` / `IRODORI_LAUNCH_MODE` | inference.url / launch_mode |
| `IRODORI_SERVER_DIR` / `IRODORI_RUNTIME_PYTHON` | inference.server_dir / python |
| `IRODORI_RUNTIME_DIR` / `IRODORI_MODEL_HOME` | inference.runtime_dir / model_home |
| `IRODORI_CHECKPOINT` / `IRODORI_CODEC_REPO` | inference.checkpoint / codec |
| `IRODORI_SERVER_ENV_FILE` / `IRODORI_DEPENDENCY_SITE_PACKAGES` | 可选Server环境文件/旧安装依赖目录 |
| `IRODORI_LORA_SETTINGS` / `IRODORI_LORA_DIR` | lora.catalog / root |
| `IRODORI_ENCODER_PYTHON` / `IRODORI_VOICE_PROFILE` | encoding.python / presets.profile |
| `IRODORI_SERVER_API_KEY` | 推理服务密钥，仅在后端使用 |

密钥、私有配置和运行数据不应加入Git。推理服务的设备、精度等参数可放在明确指定的Server环境文件中；工作台不会安装或升级GPU依赖。

## 配音流程

- 两个大框并排对照；支持文章台词提取、一行一个音频和原样直通。正文手工校对后不会自动再次拆分。
- 长期/本次关键词替换在失焦后应用；长期规则可独立保存、载入。
- 常用音色复制LoRA、参考顺序、Caption和参数；单句可覆盖。单句覆盖优先于整批配置。
- 只生成未完成或已修改的句子；生成期间可编辑、清空或准备新批次。
- 首句生成完成即开始连续试听，后续顺序接续，静音间隔可配置；切换编辑批次不中断原试听。
- 结果直接写入指定目录，每句保留一个当前版本；可打开目录或在资源管理器中定位音频。
- 当前选中音频不自动过期，被替换或删除台词的旧音频保留7天；文本、配置、历史长期保留。
- 日志轮转与历史清理由工作台管理。一个数据目录只运行一个业务worker。

## 外部应用 API

API不依赖页面打开，复用同一批次处理与优先队列。页面可选择跟随外部请求；开始手工编辑后退出跟随。

- `GET /api/v1/health`、`GET /api/v1/status`：就绪与推理状态。
- `GET /api/v1/presets`：已保存的音色预设。
- `POST /api/v1/synthesize`：异步提交原文、配置和处理方式，返回批次。
- `GET /api/v1/batches/{id}`：查询正文、生成进度和音频版本。
- `POST /v1/audio/speech`：普通WAV或兼容SSE；按 `preset_id` 调用时返回完整WAV，并提供 `X-Job-Id`、`X-Preset-Version`。
- `GET /v1/models`、`GET /v1/audio/voices`、`POST /v1/audio/voices`：兼容查询与参考上传。

外部API默认文本直通，可显式传processing。按预设调用时省略voice；不混用预设和显式音色参数。接口结构见 [批次契约](docs/BATCH-CONTRACT.md)。

## 验证与发布

```powershell
$env:PYTHONPATH = "backend/src"
.venv\Scripts\python.exe -m pytest backend/tests -q
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

业务测试与Windows CI使用临时数据和测试音，不需要GPU。Server协议测试使用独立推理环境，见 [集成说明](integration/server/README.md)。`scripts/validate_*.py` 的真实生成必须显式传 `--allow-real-inference`，并提供自己的模型/夹具；不要将作者的验收数据用于新安装。

发布整理见 [发布清单](docs/PUBLISHING.md)。运行数据、私有配置、模型、旧补丁备份及作者本机验收记录均排除在发布内容之外；历史开发文档仍可留在本机。

工作台采用 [MIT License](LICENSE)。第三方组件与模型不由该许可证替代，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
