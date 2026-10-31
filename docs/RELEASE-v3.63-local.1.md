# whale_gril_v3.63_custom · v3.63-local.1

基于 [Banan1cee/whale_gril](https://github.com/Banan1cee/whale_gril) **v3.63**（MIT）的魔改分支。原版的人设、网页、桥接骨架全部保留，下面这些是这一个多月加的东西，全部有开关、可单独关掉。

## 一、识图（认图不再瞎猜）

- **多来源交叉核对**：`trace.moe`（以图搜图）+ `SauceNAO`（图片出处）+ `AniList`（作品库）+ 搜狗/百度网页，候选必须有「名字 + 画面特征」双重证据才下结论
- **四级证据标记**：`verified`（图搜+网页核对）/ `reverse`（仅图搜命中，措辞降级为「疑似」）/ `guess`（只有网页线索，必须说「可能」）/ `none`（查不到就说查不到）
- **阈值**：trace.moe 收种子 0.75、下结论 0.9（≥0.95 才算可信）、SauceNAO ≥70%
- **可选 DSH 兜底**：难图会再走一遍 DeepSeek Harness（更强模型 + 联网），结论标注「仅供参考」
- 开关：`vision.webSearch.{enabled,reverseSearch,descSearch,traceMinSimilarity}`、`dshBridge.{enabled,describe,fallback,maxSearches}`

## 二、看图与联网

- **看图默认关思考**：`vision.thinking="off"`，同一张图 7.7s → 1.8s，信息量几乎不变
- **顺手搜一下**：图里有作品/角色/商品/软件才搜 3 条附在描述后；纯壁纸、聊天截图、长截图分段不搜
- **浏览器兜底**：Bing 直接抓 IP 被风控时，用本机 Edge/Chrome 无头 `--dump-dom` 取结果（10 分钟缓存 + 单飞）
- **长截图**按 2~3 段切分逐段转写

## 三、微信桥接

- **收图先问用途**：私聊立刻问；**群聊先挂起**，等发图人叫它外号/`@` 再问「想让我拿这张图做什么？」，下一句 90 秒内自动合图处理
- **文档/聊天截图只读字不联网**：识别为「总结/提取/翻译/整理/校对」类要求时只做逐字转写
- **群里 @ 用纯文本**：`atUi=false`，避开 UI @ 导致的卡死；**群昵称**从 `chat_room.ext_buffer` 解析，60 秒自动跟随改名
- **表情包彩蛋**：收到表情包 30% 概率回「服务器繁忙，请稍后重试」（`wechat.stickerBusy`）
- **B 站视频**：主动分享改成下载完整视频以视频消息发出；**别人发来的链接**也会自动下载回发（`wechat.videoLink`，上限/画质/冷却/发完删除/是否回退搜索框都可配）
- **群聊批处理**：群里短时间内多条消息合成一次回复（`wechat.batch`）
- **打字停顿 + 发送三级降级**：按字数停顿再发；主通道失败退键盘、再失败强制重发
- **启动自动拉起主服务**：双击「启动微信桥接.bat」时如果 8787 没在跑，自动后台启动鲸鲸

## 四、聊天内核

- **允许范围白名单 + 逐聊天权限**：`access.mode=all|whitelist`，每个会话可设 `chat`（只聊）/`full`（可下指令）/`off`（不理）
- **记忆分层**：私聊档案（TA 说过的事/常聊）+ 群档案（群里常聊/群里的人/印象标签），压成一段注入提示词，不占聊天条数额度
- **情绪自动微调**：8 种情绪（平静/开心/有点烦/炸毛/黏人/关心/委屈/困了）+ 强度 1~5 + 25 分钟衰减，满 6 轮后台归纳；只改语气话量，不改人设正文
- **人格自我修改**：教它自己重写人设（调教台卡片 / 微信里「改人设：…」「查看人设」「撤销人格」），带快照可撤销
- **每条回复带费用**：按 DeepSeek 官方价（含缓存命中/高峰）算出本句消耗，形如 `（0.0010）`
- **活人感**：单/双气泡概率、开场白防复读、动态温度（技术话题 0.8 / 闲聊 1.1）
- **Prefix-Cache 分层提示词**：固定人设在前、每轮变化的内容在后，省钱也更稳
- **修复「主人在群里永远回」**：`masterAlwaysReply=false` 时，主人在群里没 @ 就不接话（不再被「接话窗口」无限续期）

## 五、网页

- 调试台 http://127.0.0.1:8787/debug 新增 **「新功能开关」卡片**（9 组 25 个字段，保存即生效）
- 调教台 http://127.0.0.1:8787/persona 新增 **「让她自己改人格」卡片**

## 六、开关速查

| 想关什么 | 配置项 |
|---|---|
| 识图联网搜索 | `vision.webSearch.enabled=false` |
| 以图搜图 / 画面特征搜 | `reverseSearch` / `descSearch` |
| DSH 复核 | `dshBridge.enabled=false` |
| 看图思考 | `vision.thinking="low"` 可开回（默认 off） |
| 收图先问用途 | `wechat.imageAsk.enabled=false` |
| 群里等叫外号 | `wechat.imageAsk.callTtlSec`（默认 90 秒） |
| 视频链接自动回发 | `wechat.videoLink.enabled=false` |
| 表情包彩蛋 | `wechat.stickerBusy.chance=0` |
| 群聊批处理 | `wechat.batch.enabled=false` |
| 记忆分层 | `archive.enabled=false` |
| 白名单 | `access.enabled=false` |
| 回复显示费用 | `pricing.enabled=false` |
| 双气泡 | `chat.dualBubbleChance=0` |
| 主人群里没 @ 也回 | `group.masterAlwaysReply=true` |

## 七、安装 / 更新

- **下载本页的 `whale-girl-3.63-custom-full.zip`（约 120MB）**，解压到**纯英文路径**（例：`D:\AstrWechat\whale-girl`）
- 自带 Node 22 + Python 3.12 + ffmpeg，**不用装环境**
- 双击「启动鲸鱼娘.bat」→ 网页 http://127.0.0.1:8787 ；接微信再双击「启动微信桥接.bat」
- 首次启动会从 `config.example.json` 生成 `config.json`，在里面填你自己的 `apiKey`（本包**不含任何 Key**）
- 更新：解压新包覆盖原目录，`data\` 和 `config.json` 不会被覆盖，记忆保留
- 相对原版的详细改动见 `docs/本仓库改动说明.md`

## 八、回滚

每个改动都在 `patches/<主题>/` 留了改前的 `.bak-*`（本仓库不含这些备份，只在发布者本机）。要回滚某个补丁：用同名 `.bak-*` 覆盖回去、重启服务即可。整体回滚：直接切回上游 `v3.63`。

## 九、许可与署名

- 原项目：**MIT**，版权归 [Banan1cee](https://github.com/Banan1cee/whale_gril) 所有
- 本分支同样以 MIT 发布，保留原 LICENSE；改动部分由 `mikudoro88-ctrl` 维护
- 请勿把本分支当作原创作品再发布；二次分发请保留 LICENSE 与署名
