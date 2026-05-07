# 播了么小红书弹幕捕获插件

这是一个用于捕获小红书网页端直播弹幕的 Chrome MV3 插件。插件优先通过页面主世界 Hook 官方 IM 消息获取实时弹幕，并可通过 WebSocket 将标准化弹幕数据传输给外部程序使用；当 IM 消息不可用时，保留 DOM 兜底捕获。

## 当前能力

- 捕获小红书直播评论弹幕，并尽量获取用户 ID
- 捕获用户进入直播间事件，并尽量获取用户 ID
- 捕获点赞、关注、进入、评论四类事件，并分别标记为 `like`、`follow`、`enter`、`comment`
- 通过主世界注入 Hook 官方 IM 消息，支持 DOM 兜底
- 自动去重，降低重复消息
- 插件窗口支持“只看关键弹幕”，仅显示评论和关注
- 默认通过 WebSocket 输出到 `ws://127.0.0.1:8890`
- 不要求用户安装 Tampermonkey / 油猴
- 点击插件图标会打开独立控制窗口，窗口不会因页面失焦自动关闭

## 工作方式

插件仅在以下页面注入 content script：

- `redlive.xiaohongshu.com/*`
- `ark.xiaohongshu.com/*`
- `www.xiaohongshu.com/livestream/*`

默认 WebSocket 输出地址：

```text
ws://127.0.0.1:8890
```

本仓库只包含 Chrome 插件前端捕获源码，不包含后端、接收端或数据处理服务。

## 安装方式

1. 打开 Chrome：

```text
chrome://extensions/
```

2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本仓库目录：

```text
XHSBarrage_CRX
```

5. 打开小红书直播页面
6. 点击插件图标，打开独立控制窗口，确认状态为「运行中」

## 输出数据格式

评论事件：

```json
{
  "platform": "xiaohongshu",
  "type": "comment",
  "nickname": "用户昵称",
  "user_id": "用户ID",
  "content": "评论内容",
  "source": "im_hook",
  "timestamp": 1778079460.331
}
```

进房事件：

```json
{
  "platform": "xiaohongshu",
  "type": "enter",
  "nickname": "用户昵称",
  "user_id": "用户ID",
  "content": "进入直播间",
  "source": "im_hook",
  "timestamp": 1778079460.331
}
```

## 已知限制

- 优先依赖小红书网页端官方 IM 消息结构，官方改版后可能需要更新解析逻辑
- DOM 兜底消息通常无法稳定获取用户 ID
- 当前不做协议逆向，不绕过登录、验证或风控
- 网页端如果被验证弹窗遮挡或停止渲染，插件也无法继续获取弹幕
- 点赞昵称可能因官方消息字段差异需要持续适配

## 文件说明

- `manifest.json`：Chrome MV3 插件配置
- `inject.js`：页面主世界轻量 Hook，尝试捕获官方 IM 消息中的昵称、用户 ID 和内容
- `content.js`：接收 Hook 消息、DOM 兜底捕获和 WebSocket 转发逻辑
- `popup.html`：插件弹窗界面
- `popup.js`：插件设置和状态显示逻辑
