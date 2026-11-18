// AGO WORLD BOX のアクセス制御（ACL、純粋ロジック・DOM 非依存）。
// コンテナ（樽・木箱・宝箱・収納箱）と門（wooden_gate）に対して、
// 「公開（誰でも）」「ユニオン（同じ国の国民のみ）」「自分のみ（所有者のみ）」の
// 3段階のアクセス権を判定する。API ルートが NationsState を解決してここへ渡す。

export type AccessScope = "public" | "union" | "owner";

export const ACCESS_SCOPES: readonly AccessScope[] = ["public", "union", "owner"];

export function isAccessScope(raw: unknown): raw is AccessScope {
  return raw === "public" || raw === "union" || raw === "owner";
}

export function parseAccessScope(raw: unknown): AccessScope {
  return isAccessScope(raw) ? raw : "public";
}

export function accessScopeLabel(scope: AccessScope | undefined): string {
  if (scope === "union") return "ユニオン";
  if (scope === "owner") return "自分のみ";
  return "公開";
}

export type AccessContext = {
  /** 操作者の不透明 ID（presenceId 形式）。 */
  actorId: string;
  /** 設置者の不透明 ID（presenceId 形式）。 */
  ownerId: string;
  /** 操作者の現在所属国 ID（未所属なら null）。 */
  actorNationId: string | null;
  /** 設置者の現在所属国 ID（未所属なら null）。 */
  ownerNationId: string | null;
};

/**
 * 指定されたアクセス区分に対して操作が許可されるか判定する。
 * 既定（未設定）は "public" で後方互換を保つ。
 */
export function canAccessScope(scope: AccessScope | undefined, ctx: AccessContext): boolean {
  const effective = scope ?? "public";
  if (effective === "public") return true;
  if (ctx.actorId === ctx.ownerId) return true;
  if (effective === "owner") return false;
  return ctx.actorNationId !== null && ctx.actorNationId === ctx.ownerNationId;
}
