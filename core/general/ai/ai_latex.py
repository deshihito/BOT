"""AI回答に含まれるLaTeX数式をDiscordで読める形に変換する。

Discordは数式を描画できないため、次のように処理する。

* ``$$...$$`` / ``\\[...\\]`` / ``\\begin{align}...`` などの独立数式
    → matplotlib(mathtext)でPNG画像にし、本文には ``【数式 n】`` を置く。
      複数ある場合は ``compose()`` で縦に並べた1枚の画像にまとめ、embedの画像として使う
* ``$...$`` / ``\\(...\\)`` などの文中数式
    → Unicode文字（α, x², √2 など）に置き換える。変換できない場合は画像にする
* 描画できない式（行列・日本語入り・未対応コマンドなど）
    → ```latex コードブロックとして原文のまま表示する

コードブロック・インラインコードの中身は一切変換しない。
依存: matplotlib（無い場合は画像化せずコードブロック表示にフォールバック）。
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
import threading
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ---- 設定 -------------------------------------------------------------
MAX_IMAGES = 8             # 1回答に添付する数式画像の上限（Discordは1メッセージ10ファイルまで）
MAX_FORMULA_CHARS = 1500   # これより長い式は画像化しない
MAX_FORMULA_ROWS = 12      # 複数行式の最大行数
FONT_SIZE = 12
DPI = 150
PAD_PX = 14
ROW_GAP_RATIO = 0.4
FG_COLOR = "#111111"
BG_COLOR = "#ffffff"       # DiscordのライトでもダークでもOKなよう不透明な白背景にする

SYSTEM_HINT = (
    "数式はLaTeX記法で書いてください。独立した数式は $$...$$、文中の数式は $...$ を使います。"
    "数式の中に日本語は入れず、\\frac, \\sqrt, \\sum, \\int, 上付き・下付き、ギリシャ文字などの"
    "基本的なコマンドだけを使い、\\begin{pmatrix} や \\begin{cases} などの環境は避けてください。"
    "複数行になる式は行ごとに別々の $$...$$ に分けてください。ドル記号そのものは \\$ と書いてください。"
)


class LatexRenderError(Exception):
    """数式を画像にできなかった。"""


@dataclass
class MathImage:
    number: int
    marker: str      # 本文中の目印（例: 【数式 1】）
    filename: str
    data: bytes
    alt: str         # 画像の代替テキスト（LaTeX原文）


@dataclass
class LatexResult:
    text: str
    images: list[MathImage] = field(default_factory=list)


# ---- 数式の検出 ---------------------------------------------------------
_CODE_RE = re.compile(r"(```.*?```|`[^`\n]+`)", re.DOTALL)
_MATH_RE = re.compile(
    r"\$\$(?P<d1>.+?)\$\$"
    r"|\\\[(?P<d2>.+?)\\\]"
    r"|\\begin\{(?P<env>align\*?|aligned\*?|equation\*?|gather\*?|eqnarray\*?)\}(?P<d3>.+?)\\end\{(?P=env)\}"
    r"|\\\((?P<i1>.+?)\\\)"
    r"|(?<![\\$])\$(?![\s$])(?P<i2>[^$\n]+?)(?<![\s\\])\$(?![\d$])",
    re.DOTALL,
)
_WIDE_CHAR_RE = re.compile(r"[\u3000-\u9fff\uff00-\uffef\uac00-\ud7af]")


@dataclass
class _Formula:
    src: str
    display: bool
    text: str = ""


# ---- mathtext向けの前処理 ------------------------------------------------
_PREPARE_SUBS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|limits|nolimits|nonumber|notag)(?![a-zA-Z])"), ""),
    (re.compile(r"\\(?:label|tag)\{[^{}]*\}"), ""),
    (re.compile(r"\\(?:big|Big|bigg|Bigg)[lrm]?(?![a-zA-Z])"), ""),
    (re.compile(r"\\(?:dfrac|tfrac)(?![a-zA-Z])"), r"\\frac"),
    (re.compile(r"\\implies(?![a-zA-Z])"), r"\\Rightarrow"),
    (re.compile(r"\\impliedby(?![a-zA-Z])"), r"\\Leftarrow"),
    (re.compile(r"\\land(?![a-zA-Z])"), r"\\wedge"),
    (re.compile(r"\\lor(?![a-zA-Z])"), r"\\vee"),
    (re.compile(r"\\[lr]vert(?![a-zA-Z])"), "|"),
    (re.compile(r"\\coloneqq(?![a-zA-Z])"), ":="),
    (re.compile(r"\\(?:bm|boldsymbol|textbf)(?![a-zA-Z])"), r"\\mathbf"),
    (re.compile(r"\\textit(?![a-zA-Z])"), r"\\mathit"),
    (re.compile(r"\\(?:operatorname\*?|textrm|mbox)(?![a-zA-Z])"), r"\\mathrm"),
    (re.compile(r"\\pmod\{([^{}]*)\}"), r"\\ (\\mathrm{mod}\\ \1)"),
    (re.compile(r"\\bmod(?![a-zA-Z])"), r"\\ \\mathrm{mod}\\ "),
    (re.compile(r"\\(?:underline|boxed|cancel)\{([^{}]*)\}"), r"\1"),
    (re.compile(r"\\(?:underbrace|overbrace)\{([^{}]*)\}(?:[_^]\{[^{}]*\})?"), r"\1"),
    (re.compile(r"\\xrightarrow\{[^{}]*\}"), r"\\rightarrow"),
    (re.compile(r"\\stackrel\{[^{}]*\}\{([^{}]*)\}"), r"\1"),
    (re.compile(r"\\square(?![a-zA-Z])"), r"\\Box"),
]
_TEXT_RE = re.compile(r"\\text\{([^{}]*)\}")
_ROW_SPLIT_RE = re.compile(r"\\\\(?:\[[^\]]*\])?")


def _prepare_rows(src: str) -> list[str]:
    s = src.strip()
    if _WIDE_CHAR_RE.search(s):
        raise LatexRenderError("日本語など描画できない文字を含む")
    if len(s) > MAX_FORMULA_CHARS:
        raise LatexRenderError("式が長すぎる")
    for pattern, repl in _PREPARE_SUBS:
        s = pattern.sub(repl, s)
    # \text{if x} の空白が mathtext で潰れないよう \  にする
    s = _TEXT_RE.sub(lambda m: "\\text{" + m.group(1).replace(" ", "\\ ") + "}", s)
    s = re.sub(r"\\begin\{(?:align|aligned|gather|equation|eqnarray)\*?\}|\\end\{(?:align|aligned|gather|equation|eqnarray)\*?\}", "", s)
    s = s.replace("&", " ")
    rows = [r.strip() for r in _ROW_SPLIT_RE.split(s)]
    rows = [r for r in rows if r]
    if not rows:
        raise LatexRenderError("空の式")
    if len(rows) > MAX_FORMULA_ROWS:
        raise LatexRenderError("行数が多すぎる")
    return rows


# ---- PNG描画（matplotlib mathtext） ---------------------------------------
_RENDER_LOCK = threading.Lock()  # rc_context はスレッドセーフではないため直列化する


def _render_png(src: str) -> bytes:
    rows = _prepare_rows(src)
    try:
        import matplotlib as mpl
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        from matplotlib.figure import Figure
    except ImportError as exc:  # pragma: no cover
        raise LatexRenderError("matplotlibが未インストール") from exc

    try:
        with _RENDER_LOCK, mpl.rc_context({"mathtext.fontset": "cm"}):
            fig = Figure(dpi=DPI)
            canvas = FigureCanvasAgg(fig)
            renderer = canvas.get_renderer()
            texts = []
            sizes = []
            for row in rows:
                t = fig.text(0, 0, f"${row}$", fontsize=FONT_SIZE, color=FG_COLOR, ha="left", va="bottom")
                bb = t.get_window_extent(renderer)
                texts.append(t)
                sizes.append((bb.width, bb.height))
            gap = FONT_SIZE * DPI / 72 * ROW_GAP_RATIO
            width = max(w for w, _ in sizes) + PAD_PX * 2
            height = sum(h for _, h in sizes) + gap * (len(sizes) - 1) + PAD_PX * 2
            fig.set_size_inches(width / DPI, height / DPI)
            y = height - PAD_PX
            for t, (w, h) in zip(texts, sizes):
                y -= h
                t.set_position(((width - w) / 2 / width, y / height))
                y -= gap
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=DPI, facecolor=BG_COLOR)
            return buf.getvalue()
    except LatexRenderError:
        raise
    except Exception as exc:
        raise LatexRenderError(f"mathtextで描画できない: {exc}") from exc


# ---- 文中数式 → Unicode ---------------------------------------------------
_GREEK = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ϵ", "varepsilon": "ε",
    "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "varpi": "ϖ", "rho": "ρ",
    "varrho": "ϱ", "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "ϕ",
    "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π",
    "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
}
_SYMBOLS = {
    "times": "×", "cdot": "·", "div": "÷", "pm": "±", "mp": "∓", "leq": "≤", "le": "≤",
    "leqslant": "≤", "geq": "≥", "ge": "≥", "geqslant": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "sim": "∼", "simeq": "≃", "propto": "∝", "infty": "∞",
    "partial": "∂", "nabla": "∇", "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂",
    "subseteq": "⊆", "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩",
    "emptyset": "∅", "varnothing": "∅", "setminus": "∖", "forall": "∀", "exists": "∃",
    "neg": "¬", "lnot": "¬", "wedge": "∧", "land": "∧", "vee": "∨", "lor": "∨",
    "to": "→", "rightarrow": "→", "leftarrow": "←", "leftrightarrow": "↔",
    "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔", "implies": "⇒", "iff": "⇔",
    "mapsto": "↦", "uparrow": "↑", "downarrow": "↓", "sum": "∑", "prod": "∏", "int": "∫",
    "oint": "∮", "ldots": "…", "dots": "…", "cdots": "⋯", "circ": "∘", "degree": "°",
    "angle": "∠", "perp": "⊥", "parallel": "∥", "hbar": "ℏ", "ell": "ℓ", "Re": "ℜ",
    "Im": "ℑ", "aleph": "ℵ", "therefore": "∴", "because": "∵", "ll": "≪", "gg": "≫",
    "star": "⋆", "ast": "∗", "dagger": "†", "prime": "′", "langle": "⟨", "rangle": "⟩",
    "lfloor": "⌊", "rfloor": "⌋", "lceil": "⌈", "rceil": "⌉", "mid": "∣", "oplus": "⊕",
    "otimes": "⊗", "triangle": "△", "square": "□", "quad": " ", "qquad": "  ",
    "lbrace": "{", "rbrace": "}", "vert": "|", "lvert": "|", "rvert": "|", "Vert": "‖",
}
_FUNCS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh",
    "tanh", "log", "ln", "lg", "exp", "lim", "limsup", "liminf", "max", "min", "sup", "inf",
    "det", "gcd", "arg", "deg", "dim", "ker", "Pr", "mod",
}
_BLACKBOARD = {"R": "ℝ", "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "C": "ℂ", "P": "ℙ", "H": "ℍ"}
_SUP = dict(zip("0123456789+-=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ"))
_SUB = dict(zip("0123456789+-=()aehijklmnoprstuvx", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"))

_WRAP_RE = re.compile(r"\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathscr|mathfrak|operatorname|boldsymbol|bm)\{([^{}]*)\}")
_BB_RE = re.compile(r"\\mathbb\{([^{}]*)\}")
_FRAC_RE = re.compile(r"\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}")
_SQRT_RE = re.compile(r"\\sqrt\{([^{}]*)\}")
_CMD_RE = re.compile(r"\\([a-zA-Z]+|[,;:! |])")
_SCRIPT_RE = re.compile(r"([\^_])(\{[^{}]*\}|[^\s{}])")


def _paren(text: str) -> str:
    text = text.strip()
    return text if re.fullmatch(r"[\w.·]+", text) else f"({text})"


def _script(kind: str, body: str) -> str:
    body = body.strip()
    if body.startswith("{") and body.endswith("}"):
        body = body[1:-1]
    table = _SUP if kind == "^" else _SUB
    if body and all(ch in table for ch in body):
        return "".join(table[ch] for ch in body)
    return f"{kind}{body}" if len(body) == 1 else f"{kind}({body})"


def _command(match: re.Match[str]) -> str:
    name = match.group(1)
    if name in _GREEK:
        return _GREEK[name]
    if name in _SYMBOLS:
        return _SYMBOLS[name]
    if name in _FUNCS:
        return name
    if name in {",", ";", ":", "!", " "}:
        return " " if name != "!" else ""
    if name == "|":
        return "‖"
    return match.group(0)  # 未対応: 後で検出して画像化する


def to_unicode(src: str) -> str | None:
    """文中数式をUnicode文字列にする。変換しきれない場合は None。"""
    s = src.strip()
    s = s.replace("\\{", "\x00L").replace("\\}", "\x00R").replace("\\$", "$").replace("\\%", "%").replace("\\&", "&")
    s = re.sub(r"\\(?:left|right)\s*\.", "", s)
    s = re.sub(r"\\(?:left|right|big|Big|bigg|Bigg|displaystyle|textstyle)[lrm]?(?![a-zA-Z])", "", s)
    s = _BB_RE.sub(lambda m: "".join(_BLACKBOARD.get(c, c) for c in m.group(1)), s)
    for _ in range(6):  # 入れ子の分数・根号を内側から順に展開
        before = s
        s = _WRAP_RE.sub(r"\1", s)
        s = _SQRT_RE.sub(lambda m: "√" + _paren(m.group(1)), s)
        s = _FRAC_RE.sub(lambda m: f"{_paren(m.group(1))}/{_paren(m.group(2))}", s)
        if s == before:
            break
    s = _CMD_RE.sub(_command, s)
    s = _SCRIPT_RE.sub(lambda m: _script(m.group(1), m.group(2)), s)
    s = s.replace("{", "").replace("}", "")
    s = s.replace("\x00L", "{").replace("\x00R", "}")
    if "\\" in s:
        return None
    s = re.sub(r"[ \t]{2,}", " ", s).strip()
    return re.sub(r"([*_~|`])", r"\\\1", s) if s else None


# ---- 本体 ---------------------------------------------------------------
async def process(answer: str) -> LatexResult:
    """回答テキスト中の数式を変換する。失敗しても元の回答をそのまま返す。"""
    try:
        return await _process(answer)
    except Exception:
        logger.exception("LaTeX変換に失敗しました")
        return LatexResult(answer)


async def _process(answer: str) -> LatexResult:
    if "$" not in answer and "\\[" not in answer and "\\(" not in answer and "\\begin" not in answer:
        return LatexResult(answer)

    parts: list[str | _Formula] = []
    for segment in _CODE_RE.split(answer):
        if not segment:
            continue
        if _CODE_RE.fullmatch(segment):
            parts.append(segment)
            continue
        pos = 0
        for m in _MATH_RE.finditer(segment):
            if m.start() > pos:
                parts.append(segment[pos:m.start()])
            body = m.group("d1") or m.group("d2") or m.group("d3") or m.group("i1") or m.group("i2") or ""
            display = bool(m.group("d1") or m.group("d2") or m.group("d3"))
            parts.append(_Formula(body.strip(), display))
            pos = m.end()
        if pos < len(segment):
            parts.append(segment[pos:])

    images: list[MathImage] = []
    for part in parts:
        if not isinstance(part, _Formula):
            continue
        part.text = await _resolve(part, images)

    text = "".join(p if isinstance(p, str) else p.text for p in parts)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return LatexResult(text, images)


async def _resolve(formula: _Formula, images: list[MathImage]) -> str:
    if not formula.src:
        return ""
    if not formula.display:
        converted = to_unicode(formula.src)
        if converted is not None:
            return converted
    if len(images) < MAX_IMAGES:
        try:
            data = await asyncio.to_thread(_render_png, formula.src)
        except LatexRenderError as exc:
            logger.info("数式を画像化できませんでした (%s): %s", exc, formula.src[:80])
        else:
            n = len(images) + 1
            marker = f"【数式 {n}】"
            images.append(MathImage(n, marker, f"math-{n}.png", data, formula.src[:1000]))
            return f"\n**{marker}**\n" if formula.display else f"**{marker}**"
    if formula.display:
        return f"\n```latex\n{formula.src}\n```\n"
    return f"`{formula.src}`"


# ---- 複数の数式画像を1枚にまとめる -----------------------------------------
def _compose_sync(images: list[MathImage]) -> tuple[bytes, str]:
    if len(images) == 1:
        return images[0].data, images[0].alt
    import matplotlib as mpl
    from PIL import Image, ImageDraw, ImageFont

    font_path = mpl.get_data_path() + "/fonts/ttf/DejaVuSans.ttf"
    font = ImageFont.truetype(font_path, 18)
    rows = [Image.open(io.BytesIO(img.data)).convert("RGB") for img in images]
    labels = [f"({img.number})" for img in images]
    label_w = int(max(font.getlength(t) for t in labels)) + 16
    width = label_w + max(r.width for r in rows)
    height = sum(r.height for r in rows) + (len(rows) - 1)  # 行間の区切り線1px
    canvas = Image.new("RGB", (width, height), BG_COLOR)
    draw = ImageDraw.Draw(canvas)
    y = 0
    for i, (row, label) in enumerate(zip(rows, labels)):
        canvas.paste(row, (label_w + (width - label_w - row.width) // 2, y))
        draw.text((8, y + row.height // 2), label, fill="#888888", font=font, anchor="lm")
        y += row.height
        if i < len(rows) - 1:
            draw.line([(0, y), (width, y)], fill="#dddddd")
            y += 1
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    alt = "\n".join(f"({img.number}) {img.alt}" for img in images)
    return buf.getvalue(), alt[:1000]


async def compose(images: list[MathImage]) -> tuple[bytes, str] | None:
    """数式画像を縦に並べた1枚のPNGと代替テキストにする。失敗時は None。"""
    if not images:
        return None
    try:
        return await asyncio.to_thread(_compose_sync, images)
    except Exception:
        logger.exception("数式画像の結合に失敗しました")
        return None