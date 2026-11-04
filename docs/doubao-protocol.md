# 豆包播客 API 实测笔记

实现位于 `src/server/doubao.ts`。接入[语音播客 WebSocket v3 协议](https://docs.volcengine.com/docs/doubao-voice/podcast-api-websocket-v3protocol?lang=zh)时，以下几点与官方文档有出入，或文档没有写明。这些结论来自对真实服务的测试，服务端行为以后可能变化。

| 项目 | 文档 | 实测 |
|---|---|---|
| 客户端帧的 message type | 表格写 `0b001`，示例写 `1001` | `0b0001` |
| StartSession、FinishSession 事件号 | 未给出 | 100、102 |
| 生成阶段的上行事件 | 称不需要 | StartSession 之后必须发 FinishSession，否则服务端发完音频也不会结束会话 |
| 每一轮的音频 | 未说明 | 各是一个独立的 MP3 文件，带自己的 ID3 和 Info 帧 |
| `audio_duration` | 当作轮次时长 | 比实际音频略短，累积后字幕会错位 |

对应的处理：

- 拼接前去掉每一轮的 ID3 和 Info 帧，否则播放器会把第一轮的长度当成总时长。
- 字幕时间轴按 MP3 帧数计算，不使用 `audio_duration`。
- 只在一轮完整结束后才写入音频。连接中断时丢弃未完成的一轮，再用 `retry_info` 续传，所以文件里不会出现半轮内容。
