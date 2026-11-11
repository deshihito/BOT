# 立体音響の実測データ

立体音響（`core/vc/music/spatial.py`）が使う実測データです。
HRTF は `assets/hrtf/` を参照。

## room_ir.npz — 部屋のインパルス応答（残響）

- `room`: Steinman Foundation Recording Suite（録音スタジオ）の実測IR。
  EchoThief Impulse Response Library（Chris Warren）より。44.1kHz→48kHz、0.85秒に整形。
- `hall`: Pori Concert Hall（フィンランド）の実測IR、カーディオイド収音 s1_r3。
  Aalto University の Pori Concert Hall IR データベースより。48kHz、2.5秒に整形。
- どちらも直接音の立ち上がりを詰め、全体を一括正規化（ピーク 0.9）。

## speakers.npz — スピーカーの実測特性

DIRPAT データベース（IEM Graz、CC0）の無響室実測から抽出。
方位 140° を正面として再配置（実測グリッドのオフセット）。

- `*_fir`: 軸上周波数特性から作った 256 タップ FIR（線形位相、200Hz〜8kHz の中央値で正規化）
- `*_directivity`: 帯域別（低 <320Hz / 中 750〜2250Hz / 高 >5kHz）の指向性ゲイン。
  shape = (3, 72)、方位 5° 刻み、正面 = 1.0

対応プリセット:

- `studio`: Neumann KH120A
- `theater`: Tannoy System 1200
- `pa`: Yamaha DXR8
- `small`: Genelec 8020

## 出典

- EchoThief: https://www.echothief.com/
- Pori Concert Hall IRs: http://legacy.spa.aalto.fi/projects/poririrs/
- DIRPAT: M. Brandner, M. Frank, D. Rudrich, "DirPat — Database and Viewer of
  2D/3D Directivity Patterns of Sound Sources and Receivers", AES 2018.
  https://phaidra.kug.ac.at/detail/o:68229 (CC0)
