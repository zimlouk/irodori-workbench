# Irodori Workbench Windows 本地部署

本文说明工作台在 Windows 上的安装、配置和本地启动。工作台业务环境与 Irodori 推理环境分开维护；不要把推理侧的 GPU 依赖装进工作台的 Python 环境。

## 前置条件

- Windows 10/11，使用 PowerShell。
- 工作台 Python 3.11 或更高版本。发布与 CI 的 Python 基线为 3.14，不表示所有 Python 版本组合都已逐一验证。
- Node.js 满足 `^20.19.0` 或 `>=22.12.0`。CI 使用 Node.js 22。
- 使用 `irodori` 模式时，需要同机、同文件系统可访问的本地 Irodori 服务。模型、编解码器、tokenizer 和 LoRA 由用户自行准备。
- 推理侧 Python 环境按上游要求单独准备（常见基线为 Python 3.10+ 和 Transformers 5）。工作台不会升级该环境中的 GPU 包。
- `fake` 模式不要求 GPU，适合本地联调和 CI。

## 安装工作台

在仓库根目录运行：

```powershell
.\Setup-Workbench.cmd
```

脚本会安装 `requirements.lock.txt` 中锁定的 Python 依赖，并在 `frontend` 中执行 `npm ci` 和构建。首次安装时，如果缺少 `config.local.toml`，会从 `config.example.toml` 复制生成。也可以手动创建：

```powershell
Copy-Item .\config.example.toml .\config.local.toml
```

生成后直接编辑 `config.local.toml`。该文件、`.env`、运行时数据、日志、数据库和模型权重都不应提交到 Git。

安装过程不会下载模型权重，也不会安装或升级推理环境的 GPU 依赖。

## 启动与参数

```powershell
# 先检查配置，不启动服务
.\Start-Workbench.cmd --check

# 无 GPU 的本地联调
.\Start-Workbench.cmd --mode fake --no-browser

# 指定配置和端口
.\Start-Workbench.cmd --config .\config.local.toml --port 8010
```

`Start-Workbench.cmd` 将参数传给 `scripts/start.py`。可用参数包括：

- `--config PATH`：指定 TOML 配置文件。
- `--port PORT`：覆盖工作台监听端口。
- `--mode fake|irodori`：选择模拟或真实推理模式。
- `--no-browser`：启动时不自动打开浏览器。
- `--check`：执行启动前检查。

配置优先级为：命令行参数 > 环境变量 > TOML > 默认值。工作台不会自动加载 `.env`。

需要连接带鉴权的本地推理服务时，密钥只放在进程环境变量中：

```powershell
$env:IRODORI_SERVER_API_KEY = "<local-api-key>"
```

不要把真实密钥写入 TOML、脚本、命令行历史或 Git。

## 配置结构

本地配置至少应包含以下段。`fake` 或 `external` 模式下未使用的推理字段可以留空：

```toml
[workbench]
mode = "fake"              # fake 或 irodori
port = 8000
dev_port = 5173
data_dir = "./data"

[inference]
launch_mode = "external"    # external 或 managed
url = "http://127.0.0.1:9000"
server_dir = ""
python = ""
runtime_dir = ""
model_home = ""
checkpoint = ""
codec = ""
dependency_site_packages = ""
env_file = ""

[lora]
root = ""
catalog = ""

[encoding]
python = ""
```

字段含义：

- `[workbench]`：运行模式、工作台端口、前端开发端口和私有数据目录。默认数据目录中的数据不会进入公开仓库。
- `[inference]`：本地推理连接或托管启动参数，包括启动模式、服务 URL、服务目录、Python、运行时目录、模型目录、checkpoint、codec、依赖目录和环境文件。
- `[lora]`：LoRA 根目录和目录清单。
- `[encoding]`：编码相关步骤使用的 Python。

`managed` 模式会通过配置的推理 Python 调用 `scripts/run_inference.py`。相关路径必须显式写全；留空时不能依赖个人电脑上的隐含环境或自动猜测。

```toml
[inference]
launch_mode = "managed"
url = "http://127.0.0.1:9000"
server_dir = "<local-irodori-server-dir>"
python = "<inference-venv-python>"
runtime_dir = "<runtime-dir>"
model_home = "<model-home>"
checkpoint = "<checkpoint-path>"
codec = "<codec-path>"
dependency_site_packages = "<inference-site-packages>"
env_file = "<inference-env-file>"
```

示例中的尖括号内容必须替换为本机实际路径。公开示例不要写入个人绝对路径。

## 两种推理模式

- `external`：连接已经在同一台机器上运行、通过本地文件系统暴露所需资源的 Irodori 服务，并填写 `inference.url`。
- `managed`：由工作台按配置启动本地 `scripts/run_inference.py`，推理进程使用单独的 Python 环境。

两种模式都要求工作台和推理服务在同一台机器、同一文件系统上。采用托管协议 v1，依赖以下本地端点：

```text
GET  /v1/irodori/capabilities
POST /v1/irodori/synthesize
```

这不是通用 OpenAI 兼容 API，也不支持把推理部署到远程主机。

## 接入兼容的 Irodori 服务

集成补丁以服务端 commit `1fc3e100ed8e14ff30f6bfa6cb711a948960f8ce` 为兼容基线。先检查目标 checkout，再执行 dry-run，确认无冲突后才应用：

```powershell
git -C "<local-irodori-server-dir>" rev-parse HEAD
python .\integration\server\apply_patch.py --server-dir "<local-irodori-server-dir>" --check
python .\integration\server\apply_patch.py --server-dir "<local-irodori-server-dir>" --apply
```

`apply_patch.py` 默认执行 dry-run，只有 `--apply` 才写入；脚本会做冲突检查并保留备份。目标目录应是独立的服务端 checkout，不要指向工作台仓库。补丁细节、依赖和许可证说明以 `integration/server/README.md` 为准。

## 常见检查

- `--check` 失败时，先确认 `--config` 指向的文件存在，并检查 `managed` 模式下需要使用的路径是否已全部填写。
- Node 版本报错时，切换到 Node.js 22 或满足 `^20.19.0`、`>=22.12.0` 的版本。
- 端口冲突时，用 `--port` 指定其他端口。
- 连接失败时，确认服务在本机运行、URL 正确，并检查 `/v1/irodori/capabilities` 是否可访问。
- 需要无 GPU 验证时，使用 `--mode fake`。

发布和打包前的完整检查见 [PUBLISHING.md](./PUBLISHING.md)。

作品分组与预设默认参数可通过 `[presets] profile` 指向自备JSON配置；示例见 `config/voice-profile.example.json`。已有本机配置与数据不会被安装脚本覆盖。
