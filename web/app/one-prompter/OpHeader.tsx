// One Prompter のヘッダー。
// 左にブランド（ロゴA＋サービス名。サービス名の常時表示はここの1箇所だけ）、
// 右にハンバーガーメニュー（中身は OpMenu 側で持つ）。
// ブランドマークはロゴA「プロンプト記号」（黒い角丸スクエアに白抜きの
// ターミナルプロンプト「>_」）。ファビコン（page.tsx の OP_ICON）も同一形状。
import OpMenu from "./OpMenu";

function OpLogoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="#17191c" />
      <path
        d="M21 23 L31 32 L21 41"
        stroke="#ffffff"
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="35" y="38.5" width="11" height="5" rx="2.5" fill="#ffffff" />
    </svg>
  );
}

export default function OpHeader() {
  return (
    <header className="op-header">
      <p className="op-brand">
        <OpLogoMark size={28} />
        One Prompter
      </p>
      <div className="op-header-right">
        <OpMenu />
      </div>
    </header>
  );
}
