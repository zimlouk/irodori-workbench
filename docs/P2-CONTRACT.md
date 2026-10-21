# P2 项目与预设接口

所有路径前缀 /api/v1。同源 JSON；错误 detail，409 表示修订冲突，保留草稿并提示重新加载，不自动重试写入。

Config = {lora_id: string|null, reference_asset_ids: string[], caption: string, parameters:{num_steps:1..100, seed:decimal-string|null, max_ref_seconds:number|null}}。
Overrides 是 Config 的逐字段可选版本（parameters 内也逐字段可选）。省略继承；null LoRA=基础模型；[] 清空参考；空 caption 清空；seed null 随机；max_ref_seconds null 运行时默认。所有 seed 用字符串，范围 0..9223372036854775807。

- GET /presets -> {items: Preset[]}；POST /presets {voice_name,name,config} -> Preset (201)。
- PUT /presets/{id} {version,voice_name,name,config} -> Preset；无删除接口。
- Preset={id,voice_name,name,version,config,created_at,updated_at}。一个角色可有多个命名预设。
- PATCH /assets/{id} {name} -> Asset。现有 GET/POST /assets、/loras 不变。
- GET /projects -> {items:[{id,name,revision,updated_at,segment_count}]}。
- POST /projects {name,default_preset_id:null|string} -> Project (201)，初始 segments=[]。
- GET /projects/{id} -> Project。
- PUT /projects/{id} {revision,name,default_preset_id,segments:[{id?:string,text,speaker,preset_id:null|string,overrides:Overrides}]} -> Project。
  新段省略 id，旧段必须保留 id。数组即顺序，可增删/上移/下移，无 16 段限制（上限500）。text 允许空草稿，生成时拒绝空白。speaker 是手动标签，P2 无自动匹配。
  同 preset_id 保持原快照；改变 preset_id 才复制当前预设；null 使用项目默认快照。改变项目默认预设，显式更新使用默认的段落。overrides 始终保留并覆盖快照。
- Project={id,name,revision,default_preset_id,default_snapshot,segments,created_at,updated_at}。
- Segment={id,text,speaker,preset_id,snapshot:{preset_id,preset_version,config},overrides,effective_config:Config,input_revision,selected_job_id:null|string,selected_stale:boolean,attempts:Job[]}。
  Job 为已有 Job 加 project_id,segment_id,input_revision,batch_id,stale。stale 表示该任务输入修订不等于当前段。支持 pending/running/succeeded/failed/interrupted/cancelled。
  GET 可以轮询任务，但不要覆盖用户未保存的输入；可只合并 attempts/selected_job_id/selected_stale。后台完成不增加 project.revision。
- POST /projects/{id}/generate {revision,segment_ids?:string[]} -> {items:Job[],batch_id} (202)。省略列表=全部，单段=单元素。按项目顺序冻结生成配置；修订必须匹配；已在排队/运行的段拒绝409。重复生成即新版本，旧版本保留。seed null 才是随机重抽。
- POST /projects/{id}/cancel {batch_id?:string} -> {cancelled:number}，取消未开始任务，当前段完成。
- POST /projects/{id}/segments/{sid}/select {revision,job_id} -> Project；仅可选择该段成功且当前输入修订匹配的结果。
- POST /projects/{id}/preset-preview {revision,segment_ids:string[]} -> {revision,changes:[{segment_id,preset_id,from_version,to_version,before:Config,after:Config}]}。
- POST /projects/{id}/apply-presets {revision,versions:{[preset_id]:number},segment_ids:string[]} -> Project。
  先显示 preview 前后差异，用户点击应用后传入所有 changes 的最新 versions。预设版本改变则409，要求重新预览。只替换快照，保留逐段 overrides。预览的 before/after 已包含 overrides。

前端使用已有 uploadAsset/fetchAssets/fetchLoras/fetchStatus。项目编辑单独保存；保存前不能生成/应用最新预设/选择版本。切换项目存在草稿需显式提示。批量设置选中段的 speaker/preset_id，逐段 overrides 支持继承开关及有序参考编辑。
显示已保存修订、未保存草稿、已过期结果、任务错误、真实/测试模式。每个成功 attempt 可试听；当前修订的 attempt 可设为选定版本。旧结果试听不代表选中。默认新项目基础模型/无参考/40步/随机seed。
不在本轮实现 P3 文本规则/应用映射或 P4 ZIP/拼接/删除。
