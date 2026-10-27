# ミュージックライブアクティビティの分散型コンピューティング化調査

## 結論

分散化は可能です。ただし、現行のミュージックライブアクティビティで最も効果が大きいのは、Discordボイスチャンネルへの音声再生を分散することではありません。**Activity向けの動画取得・FFmpeg変換・HLS配信をBotプロセスから切り離し、専用のメディアワーカーへ移すこと**です。

現状では、Bot本体がDiscordのGateway／Voice接続、音楽再生、Activity状態API、Activity向け動画変換を同じ実行環境で担っています。特にActivityの動画経路では、`yt-dlp`でYouTubeのストリームURLを取得した後、Botホスト上で`ffmpeg`を起動し、720p以下の映像をHLSへリアルタイム変換しています（`keep_alive.py:157-220`）。ここがCPU、プロセス数、ディスクI/O、ネットワーク帯域を消費する主な分散化候補です。

一方、音声再生はBotのDiscord Voice接続と密結合です。DiscordのVoice接続はGatewayとは別のVoice WebSocketとUDP接続を使い、音声データの送受信にはUDPを利用します。[1] そのため、音声を別ワーカーで生成すること自体は可能でも、最終的にDiscord Voice接続を保持するBotプロセスへ低遅延で音声を転送する必要があり、構成が複雑になる割に、単一サーバーの負荷軽減効果は限定的です。

## 現行構成

現在のActivityは、Discord内のiframeで動作するWebアプリです。Discord公式仕様でも、Activityはiframe上のWebアプリで、Embedded App SDKを通じてDiscordクライアントと通信すると説明されています。[2] 現行の経路は次の通りです。

```text
Discord Activity iframe
  ├─ Next.js /api/activity/auth
  │    └─ Discord OAuth code交換・短寿命Activity token発行
  ├─ Next.js /api/activity/music-state
  │    └─ HMAC署名付きPOST
  │         └─ Bot Flask /internal/activity/music-state
  │              └─ Discord上の参加者・VC・VoiceClientを確認
  │                   └─ VoiceCog.activity_snapshot()
  └─ Next.js /api/activity/music-video
       └─ HMAC署名付きPOST
            └─ Bot Flask /internal/activity/music-video
                 └─ yt-dlpでYouTube情報取得
                      └─ ffmpegでHLS生成
                           └─ HLS manifest / TS segmentをNext.js経由で返却
```

状態同期は、Activityクライアントが約2秒ごとに`/api/activity/music-state`をポーリングします（`web/app/activity/music/ActivityClient.tsx:150-160`）。Bot側はリクエストごとに、ユーザーが対象Voiceチャンネルにいるかを確認し、現在曲のYouTube動画ID、再生位置、再生速度、状態だけを返します（`keep_alive.py:126-154`、`core/music_activity.py:51-95`）。この部分は軽量で、現在の設計も安全な最小情報だけを返す形になっています。

動画経路は異なります。Activityが動画を要求すると、Botは動画IDごとのロックを取得してHLS生成プロセスを起動します。`ffmpeg`は入力ストリームを読み、24fps固定、H.264、AAC、2秒HLSセグメントへ変換します（`keep_alive.py:177-192`）。生成されたHLSはBotホストの一時ディレクトリに置かれ、Next.js APIがmanifestを書き換えて各セグメントをActivityへ中継します（`web/app/api/activity/music-video/route.ts:147-174`）。

## 分散化できる処理

### 1. Activity向け動画変換ワーカー

最も分散化しやすく、効果も大きい領域です。現在の`yt-dlp`実行と`ffmpeg`プロセスを、Botとは別のメディアワーカーへ移します。Botは「現在再生中の動画ID」と「そのGuildでの再生可否」だけを認証し、メディアワーカーは動画ID単位でHLSを生成・保持します。

候補構成は以下です。

```text
Next.js Activity API
  ├─ Bot: 現在曲・VC参加確認
  └─ Media Worker: yt-dlp + ffmpeg + HLS
       ├─ ローカルNVMeキャッシュ、またはオブジェクトストレージ
       └─ CDN / Workerからmanifest・segment配信
```

`yt-dlp`はPythonへ組み込め、`extract_info(..., download=False)`でメタデータやストリーム情報を取得できます。[3] ただしストリームURLやHTTPヘッダーを長期間保存する設計には向きません。現行コードが動画ページURLを保持し、再生URLを都度再取得しているのは妥当です。メディアワーカーでも、永続化するのは動画IDと生成済みアセットの状態だけにし、期限付きの取得URLは必要な時に再生成すべきです。

### 2. HLS配信

HLSセグメントの配信は、BotのPython Flaskプロセスから切り離す価値があります。現在は、Activity → Next.js → Bot → ローカルファイルという二重プロキシになっています。専用ワーカーまたはオブジェクトストレージにmanifest・segmentを置き、CDNまたは配信可能なHTTPサービスから返せば、Botのリクエストスレッド、ファイル読み出し、帯域処理を減らせます。

ただし、Discord ActivityのネットワークはDiscord Proxy経由で、WebRTCはサポートされていません。公式ドキュメントは、Activityの外部通信をURL MappingとProxy前提で構成すること、WebSocketは利用できる一方でWebRTCは非対応であることを示しています。[4] したがって、Activityクライアント同士のP2P動画配信やWebRTCベースの分散化は、現時点の適切な選択肢ではありません。HTTPSの公開配信エンドポイントを用意し、ActivityのURL Mapping／Proxy制約に合わせる必要があります。

### 3. Activity状態APIの読み取りレプリカ

状態APIは軽量ですが、Activity参加者が多い場合は、Botのイベントループを直接待たせる設計を改善できます。BotがGuildごとのMusic snapshotを短いTTLでRedisなどへ発行し、Next.js APIがRedisを読む方式です。

ただし、単純なキャッシュだけでは「ユーザーが現在そのVoiceチャンネルにいるか」という認可情報を安全に扱えません。認可判定はBot側または信頼できる状態更新側で行い、キャッシュには`guild_id`、`channel_id`、`videoId`、再生状態、時刻など必要最小限だけを置くべきです。現行の2秒ポーリングは、まず5〜10秒の短いTTLキャッシュと、状態変化時の即時更新を組み合わせる程度で十分です。

## 分散化の効果が小さい、または避けるべき処理

### Discord Voice接続そのもの

Botの音声再生は、`VoiceCog`のGuild単位状態、Discord VoiceClient、キュー、FFmpeg音声ソースを同じイベントループで管理しています（`cogs/sio_music.py:1345-1375`、`2100-2220`）。DiscordのVoice接続はGatewayのイベント接続とは別のVoice WebSocketおよびUDP接続を必要とします。[1] 音声生成だけを別マシンに移すと、別ワーカーからBotへPCMまたはOpusを送る新しい低遅延ストリーム、再接続、順序制御、バックプレッシャー、障害時のキュー復旧が必要になります。

Guild数が非常に多い場合は、Discord公式のGateway shardingを使ってGuild単位でGatewayイベントを分散できます。Discordは1 shardあたり最大2,500 Guildを目安としており、shard IDは`(guild_id >> 22) % num_shards`で決まります。[5] ただし、これは主にGatewayイベントの分散であり、Activity用HLSのFFmpeg負荷を直接解消するものではありません。また、1つのGuildのMusic状態を複数プロセスで同時に所有する構成には向きません。

### Activityクライアント間の協調配信

複数のActivity参加者が同じ動画を見ているからといって、参加者のブラウザ同士で映像を分配する設計は推奨できません。Discord Proxy、CSP、WebRTC非対応という制約があり、認証・離脱・品質制御も難しくなります。動画は共有キャッシュまたはCDNから配信し、クライアントは現在位置だけを同期するのが安全です。

## 推奨アーキテクチャ

最初の実用的な分散化は、次の3サービスに分ける構成です。

1. **Bot service**: Discord Gateway／Voice接続、音声再生、Guildごとの再生状態、Activity用の認可判定。
2. **Activity API**: OAuth、短寿命Activity token、Botへの署名付き状態照会、HLS URLの発行。
3. **Media worker**: `yt-dlp`、`ffmpeg`、動画ID単位のジョブ制御、HLS生成、TTLキャッシュ、配信。

Media workerのジョブキーは`video_id`単位にします。同じ動画を同時に複数のActivityが開いても、変換ジョブは1本に集約します。ジョブ状態は`processing`、`ready`、`failed`、`expired`程度に限定し、Redisなどに保存します。HLSファイルは、同じ動画の同時生成を避けるために分散ロックを使います。複数ワーカーへ水平スケールする場合は、RedisロックのTTL、ワーカー停止時のロック解放、古いsegmentの削除を設計に含める必要があります。

音声再生は当面Bot側に残します。音楽本体の`yt-dlp`解析と音声用FFmpegは既存のままにし、Activity映像用の`ffmpeg`だけを分離することで、変更範囲と障害範囲を小さくできます。Activityは無音動画を再生し、音声は従来どおりDiscord Voiceから流す現行仕様を維持します。

## 導入順序

### Phase 1: 現状のBot内処理を整理

動画変換ロジックを`keep_alive.py`から独立したPythonモジュールへ移し、`video_id`単位のジョブインターフェースを明確にします。同時に、動画生成中のプロセス数、CPU使用率、HLS生成時間、segment 404率、動画ごとのキャッシュヒット率を計測します。分散化前の計測なしにワーカー台数を決めるべきではありません。

### Phase 2: 専用Media Workerへ切り出し

まずはBotと同じホスト上で別プロセスとして起動し、HTTPまたは内部キューで動画生成を依頼します。これにより、BotプロセスからFFmpegを切り離しながら、ネットワーク構成を増やさずに効果を検証できます。Botが落ちてもActivity配信ワーカーが独立しているという運用上の利点も得られます。

### Phase 3: キャッシュと配信を外部化

次に、共有HLSキャッシュをS3互換ストレージまたはCDN背後へ移します。manifestとsegmentのTTLを短くし、Activity tokenまたは短寿命署名URLでアクセスを制限します。現在の実装は`Cache-Control: no-store`で全体を非キャッシュ扱いにしているため、同じ動画の複数視聴では配信効率が悪くなります。ただし、認証情報をURLへ含める現行方式をCDNキャッシュへそのまま載せず、短寿命署名URLや認証済み配信層へ置き換える必要があります。

### Phase 4: 必要なら状態配信をイベント型へ変更

Activityの2秒ポーリングでBotやNext.jsに負荷が見えた場合だけ、BotからRedisまたはPub/Subへ状態を発行し、Activity APIが短TTLで返す方式へ移行します。WebSocketまたはSSEの採用は可能ですが、Discord ActivityのProxy制約を確認してから行うべきです。状態の更新頻度よりも、動画セグメント配信の負荷を先に解消する方が優先度は高いです。

## 判断

現時点の推奨度は以下です。

- **Activity動画用FFmpegを専用ワーカーへ分離**: 高い。最も現実的で効果が見込める。
- **HLSキャッシュ・配信を外部化**: 高い。同時視聴が増えるほど効果が大きい。
- **Music snapshotをRedisへ複製**: 中程度。高負荷時の候補だが、現状では最優先ではない。
- **音声生成を別ワーカーへ分離**: 中〜低。大規模Guild数でのみ検討価値があり、低遅延ストリーム設計が必要。
- **Activity参加者同士のP2P配信**: 低い。Discord ActivityのProxy／WebRTC制約と運用リスクが大きい。
- **Gateway sharding**: Guild数がDiscordの要件に達した場合に必要。Activity動画の軽量化策ではない。

したがって、分散型コンピューティング化は「可能」ですが、最初に行うべき変更は**Botを分散させることではなく、Activityの映像パイプラインを独立した共有メディアサービスにすること**です。これならDiscord Voiceの安定性と既存の再生制御を保ったまま、CPU・メモリ・FFmpegプロセス・HLS配信帯域を段階的に分離できます。

## References

[1]: https://docs.discord.com/developers/topics/voice-connections "Discord Voice Connections Documentation"
[2]: https://docs.discord.com/developers/activities/overview "Discord Activities Overview"
[3]: https://github.com/yt-dlp/yt-dlp "yt-dlp Official Repository and Embedding Documentation"
[4]: https://docs.discord.com/developers/activities/development-guides/networking "Discord Activities Networking Documentation"
[5]: https://docs.discord.com/developers/events/gateway "Discord Gateway and Sharding Documentation"
