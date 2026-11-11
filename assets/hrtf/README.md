# HRTF データ（立体音響用）

`kemar_hrir_48k.npz` は、立体音響（`core/vc/music/spatial.py`）が使う
実測 HRTF（頭部伝達関数）の HRIR テーブルです。

## 出典

- MIT Media Lab の KEMAR データセット（Bill Gardner と Keith Martin による
  KEMAR ダミーヘッドでの実測、diffuse-field equalized compact セット）
  https://sound.media.mit.edu/resources/KEMAR.html
- 加工内容: 44.1kHz → 48kHz リサンプル、仰角 -30° / 0° / +30° を抽出、
  方位は実測点の線形補間と左右鏡像で 0〜355° を 5° 刻みに均一化、
  144 タップに切り詰め、全体を一括正規化（耳間レベル差・時間差は保持）。

## ファイル形式

npz（numpy）:

- `hrir_left` / `hrir_right`: float32、shape = (仰角3, 方位72, 144タップ)
- `elevations`: [-30, 0, 30]（hrir の 0 軸と対応）
- `azimuth_step`: 5（方位 index × 5° = 方位角、0° = 正面）
- `sample_rate`: 48000
