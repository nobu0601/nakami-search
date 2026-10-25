# なかみ検索

フォルダを登録すると、その中のファイルを **ファイル名と中身の両方** から検索できる Windows アプリです。

## できること

- テキスト・CSV・Markdown・コード・PDF・Word(.docx)・Excel(.xlsx/.xls) の中身を検索（その他のファイルもファイル名で検索）
- 索引をパソコンに保存するので、次回起動時はすぐ検索できる
- フォルダ内のファイルの追加・変更・削除を自動で反映（アプリを閉じていた間の変更も起動時に取り込む）
- 検索結果から「開く」で Word・Excel など元のアプリで開ける。「フォルダで表示」でエクスプローラーを開く
- 全角・半角の違いを区別しない。Shift_JIS のテキストも読める
- `"見積 書"` でフレーズ検索、`-下書き` で除外、正規表現にも対応

ファイルの中身はパソコンの外には送信されません。索引は `%APPDATA%\なかみ検索\index.json.gz` に保存されます。

## インストール

Releases（または Actions の成果物）から `nakami-search-setup-x.y.z.exe` をダウンロードして実行します。
署名していないため、初回に「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」を押してください。

## 開発

```bash
npm install
npm test        # 検索・索引のテスト
npm start       # アプリを起動
npm run dist:win  # Windows インストーラーを作成（Windows 上で実行）
```

`main` に push すると、GitHub Actions がインストーラーを作り、`package.json` の version 名の Release に添付します。新しい版を出すときは version を上げてください。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/main.js` | ウィンドウ、フォルダ監視、画面とのやり取り |
| `src/indexer.js` | 索引の作成・更新・保存 |
| `src/extract.js` | 各形式のファイルから文字を取り出す |
| `src/search.js` | 検索式の解釈と一致箇所の計算 |
| `src/renderer/` | 画面 |
