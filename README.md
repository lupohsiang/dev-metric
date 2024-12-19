# GitHub 開發指標分析工具

此工具用於分析 GitHub 儲存庫的開發效率指標，包含程式碼提交、PR 審查和錯誤修復等統計資料。

## 功能特點

- 分析程式碼提交頻率和趨勢
- 追蹤 PR 的創建和合併情況
- 監控標記為 bug 的 PR 處理效率
- 生成視覺化圖表和詳細報告
- 支援自定義日期範圍的數據分析

## 安裝步驟

1. 複製專案到本地：

```bash
git clone https://github.com/lupohsiang/dev-metric.git
cd dev-metric
```

2. 安裝相依套件：

```bash
npm install
```

## 設定環境變數

1. 複製環境變數範本：

```bash
cp .env.example .env
```

2. 設定必要的環境變數：

- `GITHUB_TOKEN`：GitHub 個人存取權杖

  - 前往 GitHub 設定頁面：Settings > Developer settings > Personal access tokens
  - 選擇 "Generate new token"
  - 勾選 `repo` 相關權限
  - 複製產生的權杖並填入 `.env` 檔案

- `GITHUB_OWNER`：GitHub 儲存庫擁有者名稱
- `GITHUB_REPO`：目標 REPO 名稱
- `START_DATE`：分析起始日期（格式：YYYY-MM-DD）
- `END_DATE`：分析結束日期（格式：YYYY-MM-DD）

## 執行分析

執行以下指令開始分析：

```bash
node dev-metric.mjs
```

## 輸出結果

執行完成後，可以在 `output` 資料夾中找到：

1. 統計報告

   - `detailed-metrics-[日期].json`：詳細統計數據
   - `weekly-metrics-[日期].json`：每週統計數據

2. 視覺化圖表（SVG 格式）
   - `charts/pr-trends.svg`：PR 趨勢圖
   - `charts/merge-time-trend.svg`：PR 合併時間趨勢
   - `charts/commit-activity.svg`：程式碼提交活動
   - `charts/bug-pr-trend.svg`：Bug 修復 PR 趨勢

## 注意事項

- 確保您的 GitHub Token 具有足夠的權限
- 建議將時間範圍設定在合理區間（如一年內）
