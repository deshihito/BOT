# Localization workflow

AGOBOT does not call LibreTranslate while serving Discord requests. Runtime messages are read from the checked-in locale catalog, so a translation outage cannot delay or break a command.

## Configure the local service

Add the following to `.env` on the Bot host:

```dotenv
LIBRETRANSLATE_URL=http://127.0.0.1:18080
LIBRETRANSLATE_API_KEY=
```

If LibreTranslate runs in another container, use the Docker service name and port instead of `127.0.0.1`.

## Add a message

Add the source Japanese text once to `locales/ja.json`:

```json
{
  "settings.saved": "設定を保存しました。"
}
```

Use a stable key in new code:

```python
from core.localization import tr

await interaction.response.send_message(
    tr("settings.saved", guild_id=interaction.guild_id)
)
```

Do not call the translation service from a command handler.

## Generate missing translations

The command only fills keys that are missing in each target file. Existing translations are not overwritten unless `--overwrite` is explicitly supplied.

```bash
python scripts/sync_locales.py \
  --targets en,zh,ko,id,th,ar,hi
```

Generate only English during the English-first migration:

```bash
python scripts/sync_locales.py --targets en
```

CIやコミット前に、APIへ接続せず翻訳漏れだけを確認できます。漏れがある場合は終了コード1になります。

```bash
python scripts/sync_locales.py \
  --targets en,zh,ko,id,th,ar,hi \
  --check-only
```

The generated files are committed with the code change:

```text
locales/en.json
locales/zh.json
locales/ko.json
locales/id.json
locales/th.json
locales/ar.json
locales/hi.json
```

When a target translation is not available, `tr()` falls back to English and then Japanese. This makes a new feature usable immediately while the catalog is being completed.
