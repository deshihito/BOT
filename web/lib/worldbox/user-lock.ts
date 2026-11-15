// AGO WORLD BOX のプロセス内ロック（キー単位の直列化）。
// カジノの二重精算（PR #943）と同じ型の事故を防ぐための共有基盤:
// 状態の read-modify-write と経済オプの登録を伴う API ハンドラは、
// 同じキーのリクエストが同時に走ると、古いスナップショット同士で
// 上書きし合ったり、同じ支払いを2件積んだりしうる。対象キーの
// リクエストを直列化し、検証→保存→オプ登録を1つの不可分な流れにする。
// キーは用途ごとに選ぶ: ユーザー単位（所有者キー）、空間単位
// （インスタンスの共有状態）、固定キー（ギルド依頼の全体状態）など。
// カジノルートは #943 時点の実装（ルート内ローカル定義）をそのまま使い、
// ここはそれ以外のルートが共有する正。

const locks = new Map<string, Promise<void>>();

/** 同じ key の呼び出しを直列化して fn を実行する。 */
export async function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  locks.set(key, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
