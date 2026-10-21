# Windows 本机 Irodori Server 协议扩展

工作台依赖 protocol_version=1 的 `/v1/irodori/capabilities` 与 `/v1/irodori/synthesize`。该扩展支持有序多参考、最终参数与seed元数据、单段WAV、共用合成槽位及取消后的GPU生命周期保护。原普通/SSE接口继续保留。

## 兼容基线与安装

已验证 Server 提交：`1fc3e100ed8e14ff30f6bfa6cb711a948960f8ce`，上游为 [Aratako/Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)。在独立目录准备该版本源码，准备能运行v4模型的Irodori运行时和独立Python环境。

本次记录的推理环境为 Python3.10、torch2.10.0+cu128、Transformers5.12.1、soundfile0.13.1；这些是本机验证版本，不承诺所有GPU或未来上游版本兼容。运行时、checkpoint、codec、tokenizer由用户准备，工作台不下载权重、不升级GPU依赖。

在已准备的推理环境中，只需补齐API依赖：

```powershell
& "<inference-python.exe>" -m pip install -r .\integration\server\requirements.txt
```

该文件不安装torch或Transformers。完整运行时依赖按其自身项目要求安装。若迁移已有安装，可通过 `dependency_site_packages` 显式保留旧依赖目录作为搜索末尾的兼容来源；新安装无需混用虚拟环境。

用工作台业务Python预检并应用补丁：

```powershell
.venv\Scripts\python.exe integration/server/apply_patch.py --server-dir "<server-checkout>" --check
.venv\Scripts\python.exe integration/server/apply_patch.py --server-dir "<server-checkout>" --apply
```

默认只检查。工具对两个文件全部预检后才写入，并保留原字节及哈希备份；未知修改拒绝覆盖。再次执行返回 `already-applied`。也识别此前已验证的本机补丁版本并保持其日志/保存逻辑不变。清单在 `manifest.json`，公开补丁以固定上游提交为基线，不包含作者冻结源码副本。

有后续自定义修改的安装应先合并差异；不要为通过预检删除哈希检查。回滚前停止空闲推理服务，核对当前after哈希后，从本次备份恢复；有后续改动时先合并。

## 运行方式

复制 `config.example.toml` 为私有本机配置，选择：

- `external`：自行启动兼容本机服务，配置url与必要的API key。
- `managed`：配置server_dir、python、runtime_dir，以及checkpoint/codec或显式env_file；由工作台调用仓库内 `scripts/run_inference.py`。支持配置的本机推理端口。

checkpoint旁需要 `tokenizer/tokenizer.json` 和 `tokenizer/tokenizer_config.json`。提供model_home时使用其中的HF缓存；启动器强制离线加载，缺文件会明确报错。

运行时源码目录可显式配置，或使用推理环境中已安装的兼容运行时。工作台和Server必须共享本机文件系统；参考及LoRA传递的是本机文件路径。

## 测试

在推理环境准备可选测试依赖：

```powershell
& "<inference-python.exe>" -m pip install -r .\integration\server\requirements-test.txt
.venv\Scripts\python.exe integration/server/run_tests.py --from-pinned-head
```

入口从本机配置读取路径，也支持 `--server-dir`、`--python`、`--runtime-dir`、`--dependency-site-packages` 显式覆盖。`--test-deps` 仅用于已有隔离测试依赖目录，不是必需安装结构。

测试会在临时目录复制Server源码和测试，并应用公开补丁；`--from-pinned-head` 先从指定提交读取两个源文件，验证真正的发布补丁。测试替换推理对象，不加载真实权重，也不改动正在使用的Server安装。

本轮固定提交补丁与原有协议测试共87项通过。开发重建补丁可用 `prepare_patch.py --server-dir ... --output <临时目录>`，输出后需重新核对manifest、测试和差异；不要直接覆盖发布清单。

上游MIT声明见 [LICENSE.upstream](LICENSE.upstream)。
