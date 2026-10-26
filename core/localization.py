"""Guild-scoped localization settings and small translation helpers."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any
from core.guild_settings import get_store

LANGUAGE_SECTION = "localization"
DEFAULT_LOCALE = "en"
SUPPORTED_LOCALES = ("en", "ja", "zh", "ko", "id", "th", "ar", "hi")
LOCALE_LABELS = {
    "en": "English",
    "ja": "日本語",
    "zh": "简体中文",
    "ko": "한국어",
    "id": "Bahasa Indonesia",
    "th": "ภาษาไทย",
    "ar": "العربية",
    "hi": "हिन्दी",
}
LOCALE_FLAGS = {
    "en": "🇺🇸", "ja": "🇯🇵", "zh": "🇨🇳", "ko": "🇰🇷",
    "id": "🇮🇩", "th": "🇹🇭", "ar": "🇸🇦", "hi": "🇮🇳",
}
FLAG_TO_LOCALE = {flag: locale for locale, flag in LOCALE_FLAGS.items()}

_TRANSLATIONS = {
    "language_settings_title": {
        "en": "Language settings", "ja": "言語設定", "zh": "语言设置", "ko": "언어 설정",
        "id": "Pengaturan bahasa", "th": "การตั้งค่าภาษา", "ar": "إعدادات اللغة", "hi": "भाषा सेटिंग्स",
    },
    "language_settings_description": {
        "en": "Choose the language used by AGOBOT in this server. The setting is shared by all members.",
        "ja": "このサーバーで AGOBOT が使用する言語を選択します。設定はサーバー全体で共有されます。",
        "zh": "选择 AGOBOT 在此服务器中使用的语言。设置对所有成员生效。",
        "ko": "이 서버에서 AGOBOT이 사용할 언어를 선택하세요. 모든 멤버에게 적용됩니다.",
        "id": "Pilih bahasa yang digunakan AGOBOT di server ini. Pengaturan berlaku untuk semua anggota.",
        "th": "เลือกภาษาที่ AGOBOT จะใช้ในเซิร์ฟเวอร์นี้ การตั้งค่านี้มีผลกับสมาชิกทุกคน",
        "ar": "اختر اللغة التي سيستخدمها AGOBOT في هذا الخادم. ينطبق الإعداد على جميع الأعضاء.",
        "hi": "इस सर्वर में AGOBOT द्वारा उपयोग की जाने वाली भाषा चुनें। यह सेटिंग सभी सदस्यों पर लागू होगी।",
    },
    "language_saved": {
        "en": "Language changed to {language}.", "ja": "言語を {language} に変更しました。", "zh": "语言已更改为 {language}。",
        "ko": "언어를 {language}(으)로 변경했습니다.", "id": "Bahasa diubah menjadi {language}.",
        "th": "เปลี่ยนภาษาเป็น {language} แล้ว", "ar": "تم تغيير اللغة إلى {language}.", "hi": "भाषा {language} में बदल दी गई है।",
    },
    "welcome_language": {
        "en": "Select a language for this server by reacting below. You can change it later from `/support` → Language settings.",
        "ja": "下の国旗にリアクションして、このサーバーの言語を選択してください。後から `/support` → 言語設定で変更できます。",
        "zh": "点击下方国旗为服务器选择语言。之后可以通过 `/support` → 语言设置进行更改。",
        "ko": "아래 국기 리액션으로 서버 언어를 선택하세요. 나중에 `/support` → 언어 설정에서 변경할 수 있습니다.",
        "id": "Pilih bahasa server dengan memberikan reaksi bendera di bawah. Anda dapat mengubahnya nanti melalui `/support` → Pengaturan bahasa.",
        "th": "เลือกภาษาของเซิร์ฟเวอร์ด้วยการกดรีแอคชันธงด้านล่าง เปลี่ยนภายหลังได้ที่ `/support` → การตั้งค่าภาษา",
        "ar": "اختر لغة الخادم بالتفاعل مع العلم أدناه. يمكنك تغييرها لاحقًا من `/support` ← إعدادات اللغة.",
        "hi": "नीचे झंडे पर प्रतिक्रिया देकर सर्वर की भाषा चुनें। बाद में `/support` → भाषा सेटिंग्स से बदल सकते हैं।",
    },
}

_KEY_CATALOG_DIR = Path(__file__).resolve().parent.parent / "locales"
_KEY_CATALOGS: dict[str, dict[str, str]] = {}
for _locale in SUPPORTED_LOCALES:
    try:
        _data = json.loads((_KEY_CATALOG_DIR / f"{_locale}.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        _data = {}
    if isinstance(_data, dict):
        _KEY_CATALOGS[_locale] = {str(k): str(v) for k, v in _data.items()}

_CATALOG_PATH = Path(__file__).with_name("locales") / "ja_to_en.json"
try:
    _ENGLISH_CATALOG: dict[str, str] = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
except (FileNotFoundError, OSError, ValueError):
    _ENGLISH_CATALOG = {}
_ENGLISH_PAIRS = sorted(
    ((source, target) for source, target in _ENGLISH_CATALOG.items() if source and target and source != target),
    key=lambda pair: len(pair[0]), reverse=True,
)

def normalize_locale(value: Any) -> str:
    value = str(value or "").lower().replace("-", "_").split("_")[0]
    return value if value in SUPPORTED_LOCALES else DEFAULT_LOCALE

def locale_settings(store, guild_id: int) -> dict[str, Any]:
    raw = store.get(guild_id, LANGUAGE_SECTION)
    return {"locale": normalize_locale(raw.get("locale")), "panel_message_id": raw.get("panel_message_id")}

def guild_locale(guild_id: int, store=None) -> str:
    return locale_settings(store or get_store(), guild_id)["locale"]

def text(key: str, locale: str = DEFAULT_LOCALE, **values: Any) -> str:
    locale = normalize_locale(locale)
    result = _KEY_CATALOGS.get(locale, {}).get(key)
    if result is None:
        translations = _TRANSLATIONS.get(key, {})
        result = translations.get(locale, translations.get(DEFAULT_LOCALE, key))
    return result.format(**values)

def tr(key: str, guild_id: int | None = None, locale: str | None = None, **values: Any) -> str:
    """Return a translated catalog key, falling back to English then Japanese."""
    if locale is None:
        locale = guild_locale(guild_id) if guild_id is not None else DEFAULT_LOCALE
    locale = normalize_locale(locale)
    result = (_KEY_CATALOGS.get(locale, {}).get(key)
              or _KEY_CATALOGS.get(DEFAULT_LOCALE, {}).get(key)
              or _KEY_CATALOGS.get("ja", {}).get(key)
              or _TRANSLATIONS.get(key, {}).get(locale)
              or _TRANSLATIONS.get(key, {}).get(DEFAULT_LOCALE)
              or key)
    return result.format(**values)

def translate_text(value: str, locale: str = DEFAULT_LOCALE) -> str:
    """Translate a message and its static Japanese fragments for the selected locale."""
    if not isinstance(value, str) or normalize_locale(locale) != "en" or not _ENGLISH_PAIRS:
        return value
    result = value
    for source, target in _ENGLISH_PAIRS:
        if source in result:
            result = result.replace(source, target)
    return result

def guild_id_for_sender(sender: Any) -> int | None:
    guild = getattr(sender, "guild", None)
    if guild is not None and isinstance(getattr(guild, "id", None), int):
        return guild.id
    parent = getattr(sender, "_parent", None)
    if parent is not None:
        value = getattr(parent, "guild_id", None)
        if isinstance(value, int):
            return value
    value = getattr(sender, "guild_id", None)
    return value if isinstance(value, int) else None

def _translate_embed(embed: Any, locale: str) -> None:
    for attribute in ("title", "description"):
        value = getattr(embed, attribute, None)
        if isinstance(value, str):
            setattr(embed, attribute, translate_text(value, locale))
    footer = getattr(embed, "footer", None)
    if footer is not None and isinstance(getattr(footer, "text", None), str):
        embed.set_footer(text=translate_text(footer.text, locale), icon_url=getattr(footer, "icon_url", None))
    author = getattr(embed, "author", None)
    if author is not None and isinstance(getattr(author, "name", None), str):
        embed.set_author(name=translate_text(author.name, locale), icon_url=getattr(author, "icon_url", None))
    for index, field in enumerate(getattr(embed, "fields", ())):
        embed.set_field_at(index, name=translate_text(field.name, locale),
                           value=translate_text(field.value, locale), inline=field.inline)

def _translate_view(view: Any, locale: str) -> None:
    """Translate V1 views and nested Components V2 containers/rows."""
    visited: set[int] = set()

    def visit(item: Any) -> None:
        if item is None or isinstance(item, (str, bytes, int, float, bool)) or id(item) in visited:
            return
        visited.add(id(item))
        for attribute in ("label", "placeholder", "title", "description", "content"):
            value = getattr(item, attribute, None)
            if isinstance(value, str):
                try:
                    setattr(item, attribute, translate_text(value, locale))
                except (AttributeError, TypeError):
                    pass
        for option in getattr(item, "options", ()) or ():
            visit(option)
        for attribute in ("children", "items", "components"):
            children = getattr(item, attribute, None)
            if children:
                for child in children:
                    visit(child)

    visit(view)

def localize_kwargs(sender: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    """Translate Discord send/edit keyword payloads without changing business logic."""
    guild_id = guild_id_for_sender(sender)
    locale = guild_locale(guild_id) if guild_id is not None else DEFAULT_LOCALE
    if normalize_locale(locale) != "en":
        return kwargs
    result = dict(kwargs)
    if isinstance(result.get("content"), str):
        result["content"] = translate_text(result["content"], locale)
    embeds = result.get("embeds")
    if embeds:
        for embed in embeds:
            _translate_embed(embed, locale)
    embed = result.get("embed")
    if embed is not None:
        _translate_embed(embed, locale)
    view = result.get("view")
    if view is not None:
        _translate_view(view, locale)
    return result

def localize_object(value: Any, locale: str = DEFAULT_LOCALE) -> Any:
    """Translate a positional Discord UI object such as a Modal."""
    if normalize_locale(locale) == "en" and hasattr(value, "children"):
        _translate_view(value, locale)
    return value
