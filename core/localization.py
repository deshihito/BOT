"""Guild-scoped localization settings and small translation helpers."""
from __future__ import annotations
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

def normalize_locale(value: Any) -> str:
    value = str(value or "").lower().replace("-", "_").split("_")[0]
    return value if value in SUPPORTED_LOCALES else DEFAULT_LOCALE

def locale_settings(store, guild_id: int) -> dict[str, Any]:
    raw = store.get(guild_id, LANGUAGE_SECTION)
    return {"locale": normalize_locale(raw.get("locale")), "panel_message_id": raw.get("panel_message_id")}

def guild_locale(guild_id: int, store=None) -> str:
    return locale_settings(store or get_store(), guild_id)["locale"]

def text(key: str, locale: str = DEFAULT_LOCALE, **values: Any) -> str:
    translations = _TRANSLATIONS.get(key, {})
    result = translations.get(normalize_locale(locale), translations.get(DEFAULT_LOCALE, key))
    return result.format(**values)
