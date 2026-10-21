# Irodori Workbench 发布与打包检查

本文用于 Windows 本地发行包和公开 Git 仓库的发布前检查。发布范围是本地工作台及其 Windows 启动脚本，不包括 Linux/Docker 部署、远程 API 服务或模型权重分发。

## 发布边界

- 工作台业务环境要求 Python 3.11 或更高版本；发布和 CI 以 Python 3.14 为基线。Node.js 要求 `^20.19.0` 或 `>=22.12.0`，CI 使用 Node.js 22。
- 工作台与 Irodori 推理环境必须分开。推理侧可继续使用独立的 Python 3.10+ / Transformers 5 环境，工作台不会自动安装或升级 GPU 包。
- `fake` 模式不需要 GPU，适用于 CI 和安装后的基本验证。
- 模型、codec、tokenizer、LoRA 和推理运行时由用户自行准备；仓库不提供自动下载，也不分发权重。
- 推理服务必须与工作台位于同一台机器和同一文件系统。当前范围不承诺远程主机、Linux、Docker 或通用 OpenAI API 兼容部署。

## 应进入发行包的内容

仓库根目录应保留：

- `backend/`、`frontend/`、`scripts/` 和 `integration/server/`。
- `requirements.lock.txt`、`Setup-Workbench.cmd` 和 `Start-Workbench.cmd`。
- `config.example.toml`、`docs/`、`.gitignore`、`.gitattributes` 和 `.github/workflows/ci.yml`。
- `frontend/package-lock.json`，确保干净环境可以使用 `npm ci`。
- 项目提供的 `integration/server/README.md`、`LICENSE` 和上游声明。

不要打包或提交 `node_modules/`、`frontend/dist/`、运行时生成的数据库、日志、补丁备份、虚拟环境或任何模型资产。`frontend/dist/` 应由安装或构建步骤生成。

## 必须保持私有的内容

`data/` 中的预设、历史和音频等用户数据必须保持私有。公开仓库不得出现以下内容：

- `data/`、`config.local.toml`、`config/*.local.json` 和 `.env` 文件。
- 数据库文件及 WAL、SHM、journal 文件，运行日志和 `logs/`。
- `backups/`、`*.bak`、`*.orig`、`*.rej` 以及补丁工具生成的备份。
- `models/`、`weights/`、`checkpoints/` 和 checkpoint、LoRA、codec、tokenizer 等模型资产。
- 个人绝对路径、真实 API key、用户音频、预设导出和用户私有测试夹具。

`.env.example` 可以作为公开模板保留；工作台本身不会自动加载 `.env`。需要鉴权时，密钥只通过 `IRODORI_SERVER_API_KEY` 环境变量传入。

## Git 隐私检查

在仓库根目录执行并逐项确认：

```powershell
git status --short
git ls-files data
git check-ignore -v data config.local.toml config/settings.local.json .env backups logs
git diff --check
```

`git ls-files data` 应没有输出。若发现私有数据已被跟踪，先停止发布并处理历史，不要用 `git add -f` 绕过忽略规则。检查 `config.example.toml`、文档和测试中的示例，确保只有占位符，没有个人盘符路径、真实密钥或用户内容。

不要为了发布而修改或删除本地的 `data/`；它应继续留在忽略目录中。

## Windows 安装验证

从干净 checkout 或解压后的发行包开始，在 PowerShell 中检查：

1. `python --version` 为 3.11 或更高；发布基线为 3.14。
2. `node --version` 满足 `^20.19.0` 或 `>=22.12.0`。
3. 运行 `Setup-Workbench.cmd`，确认锁定的 Python 依赖、`npm ci` 和前端构建成功。
4. 从 `config.example.toml` 创建本地 `config.local.toml`，不要把它加入 Git。
5. 运行 `Start-Workbench.cmd --check`，再运行 `Start-Workbench.cmd --mode fake --no-browser` 验证无 GPU 启动。
6. 确认配置优先级为命令行 > 环境变量 > TOML > 默认值，且没有继承发布者的个人配置。

CI 等价检查在仓库根目录执行：

```powershell
$env:PYTHONPATH = "backend/src"
$env:IRODORI_WORKBENCH_MODE = "fake"
$env:IRODORI_WORKBENCH_CONFIG = "$env:TEMP\irodori-ci-missing.toml"
python -m pip install -r requirements.lock.txt
npm ci --prefix frontend
pytest backend/tests -q
npm --prefix frontend test
npm --prefix frontend run build
```

这里使用的临时配置路径应保持不存在，避免 CI 或发布验证读取个人配置。不要把本机已有配置、用户夹具或 GPU 环境带入测试。

## CI 检查项

`.github/workflows/ci.yml` 使用 `windows-latest`、Python 3.14 和 Node.js 22，在仓库根目录安装锁定依赖，随后运行后端 fake 测试、前端测试和前端构建。工作流只申请 `contents: read` 权限，不包含 GPU 测试、网络推理、用户数据、部署、推送或发布动作。

发布前确认工作流仍设置：

- `PYTHONPATH=backend/src`。
- `IRODORI_WORKBENCH_MODE=fake`。
- 指向临时不存在文件的 `IRODORI_WORKBENCH_CONFIG`。

## 推理集成检查

服务端兼容基线固定为 commit `1fc3e100ed8e14ff30f6bfa6cb711a948960f8ce`。发布时应保留该基线和检查说明，不要声称已验证其他上游版本。

接入前先查看目标 checkout，并使用 dry-run 检查冲突：

```powershell
git -C "<local-irodori-server-dir>" rev-parse HEAD
python .\integration\server\apply_patch.py --server-dir "<local-irodori-server-dir>" --check
python .\integration\server\apply_patch.py --server-dir "<local-irodori-server-dir>" --apply
```

`apply_patch.py` 默认只做 dry-run，`--apply` 才写入；应用前会做冲突检查并保留备份。`external` 模式连接已运行的本地服务，`managed` 模式通过配置的推理 Python 调用 `scripts/run_inference.py`。托管协议 v1 使用 `/v1/irodori/capabilities` 和 `/v1/irodori/synthesize`，不是通用 OpenAI 兼容接口。

依赖、补丁范围、许可证和已知限制以项目提供的 `integration/server/README.md` 为准。

## 许可证与上游声明

`LICENSE` 的选择以及上游代码、模型或推理组件的版权声明与 NOTICE 见项目根LICENSE和第三方说明。第三方组件声明见仓库根 THIRD_PARTY_NOTICES.md。发布前确认仓库中的第三方代码和文档带有相应声明。

## 最终打包清单

- 干净环境中完成安装、`--check`、fake 模式启动、后端测试、前端测试和构建。
- 公开文件只包含预期源码、锁定依赖、启动脚本、配置模板和文档。
- `data/`、本地配置、密钥、数据库、日志、备份和模型权重未进入 Git 或压缩包。
- 示例配置使用占位符或相对路径，不包含个人绝对路径。
- Windows 入口脚本按 `.gitattributes` 保持 CRLF，其余常见文本文件保持 LF。
- CI 工作流没有 GPU、用户夹具或网络推理依赖，且没有写权限。
- `LICENSE`、上游声明和 `integration/server/README.md` 已核对。
- 发布说明没有承诺自动下载、Linux/Docker 支持、远程 API 部署或权重分发。

生成仅含公开源文件的归档（需要Git，但不在当前目录建库或暂存）：

```powershell
.venv\Scripts\python.exe scripts/package_source.py --check
.venv\Scripts\python.exe scripts/package_source.py
```

默认归档写入被忽略的 `data/releases/`，不会包含本机配置和数据库。
