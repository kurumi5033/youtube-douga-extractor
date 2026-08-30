/**
 * YouTube動画抽出ツール - バックエンド（窓口サーバー）
 *
 * このファイルを Google Apps Script のプロジェクトにそのまま貼り付けて使います。
 * YouTube Data API キーと各スプレッドシートIDはスクリプト プロパティに保管し、
 * ブラウザ側のコードやローカルストレージには一切渡りません。
 *
 * ===== セットアップ =====
 * 1. https://script.google.com/ で新しいプロジェクトを作成し、
 *    デフォルトの Code.gs の中身をこのファイルの内容で置き換える。
 * 2. 左メニューの歯車アイコン「プロジェクトの設定」→「スクリプト プロパティ」で
 *    以下を追加する。
 *      - YOUTUBE_API_KEY      : 取得したYouTube Data API v3のキー
 *      - LEDGER_SHEET_ID      : (購入者)管理台帳スプレッドシートのID
 *      - RESULTS_SHEET_ID     : 検索結果スプレッドシートのID
 *      - USAGE_LOG_SHEET_ID   : 利用ログスプレッドシートのID
 *      - ARCHIVE_FOLDER_ID    : 月次アーカイブの保存先フォルダID
 * 3. 各スプレッドシートの1行目に、下記「シート構成」の通りヘッダーを入力しておく。
 * 4. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」を選び、
 *      実行するユーザー: 自分 / アクセスできるユーザー: 全員　でデプロイする。
 * 5. 発行された「ウェブアプリのURL」（.../exec）を index.html の GAS_ENDPOINT_URL に設定する。
 * 6. Code.gs を更新した場合は、その都度「新しいデプロイ」または
 *    既存デプロイの「編集」→「バージョン: 新バージョン」で再デプロイが必要。
 * 7. Apps Scriptエディタの関数選択プルダウンで setupMonthlyArchiveTrigger を選び、
 *    1回だけ手動実行する（「毎月1日に archiveResultsSheet を実行する」トリガーが登録される）。
 *    初回実行時はDrive/Sheetsへのアクセス許可を求められるので承認する。
 *
 * ===== シート構成 =====
 * (購入者)管理台帳: A コード / B 有効期限 / C 有効フラグ / D メモ
 *   - 有効フラグは TRUE / FALSE、有効期限は日付（空欄なら無期限）
 * 検索結果        : A 動画タイトル / B 動画URL / C サムネイルの画像 / D 再生数 / E 高評価数
 *                   / F 出演者 / G 検索日時 / H 使用したアクセスコード
 * 利用ログ        : A 日時 / B アクセスコード / C 出演者名 / D 該当件数 / E ステータス
 *
 * ===== 出演者名（検索クエリ兼判定対象）=====
 * 固定リストではなく、利用者がフォームから指定する検索パラメータです（最大3人・部分一致）。
 * 指定した人物名をそのままYouTube検索のクエリとして使い、かつ動画のタイトル・説明欄に
 * その人物名のいずれかが部分一致で含まれる動画だけを抽出します（検索キーワード欄はありません）。
 *
 * ===== 出演者数の上限、レート制限 =====
 * 1回のリクエストで受け付ける出演者名は3人まで（MAX_PERFORMERS_PER_REQUEST）。
 * アクセスコードの検証失敗が5分間に20回に達すると、5分間すべてのリクエストを拒否する
 * （総当たり対策。CacheServiceによる簡易実装のため、GASの実行環境が切り替わると
 *   カウントがリセットされる場合がある点は限界として認識しておくこと）。
 *
 * ===== 月次アーカイブ =====
 * 毎月1日 0時台に archiveResultsSheet が自動実行され、
 *   1. ARCHIVE_FOLDER_ID のフォルダ内に「検索結果_YYYYMM」（前月分）のスプレッドシートを
 *      作成（既にあれば再利用）し、
 *   2. 「検索結果」シートのデータ行をそこへ転記した上で、
 *   3. 「検索結果」シートのデータ行を削除する（ヘッダーは残す）。
 * データ行が0件の月は何もしない。
 */

// 出演者名1人あたりの検索ページ上限（1ページ=最大50件、search.list は1回100ユニット消費）
var MAX_PAGES_PER_PERFORMER = 3;

// 1回のリクエストで受け付ける出演者名の数の上限（3人まで／フロント側の表示と合わせること）
var MAX_PERFORMERS_PER_REQUEST = 3;

// ---- アクセスコードの総当たり対策（CacheServiceによる簡易レート制限）----
var FAILED_ATTEMPT_CACHE_KEY = 'access_code_failed_attempts';
var LOCKOUT_CACHE_KEY = 'access_code_lockout';
var FAILED_ATTEMPT_LIMIT = 20;       // この回数、失敗が続くとロックアウト
var FAILED_ATTEMPT_WINDOW_SECONDS = 300; // 失敗回数を数える期間（5分）
var LOCKOUT_SECONDS = 300;           // ロックアウトの継続時間（5分）

function doGet(e) {
  var params = (e && e.parameter) || {};
  var accessCode = (params.code || '').toString().trim();
  var rawPerformers = (params.performers || '').toString().trim();

  try {
    if (isRateLimited()) {
      logUsage(PropertiesService.getScriptProperties(), accessCode, rawPerformers, 0, '拒否: レート制限中');
      return jsonResponse({ error: 'アクセスが集中しているため、しばらく時間をおいて再度お試しください。' });
    }

    var props = PropertiesService.getScriptProperties();
    var apiKey = props.getProperty('YOUTUBE_API_KEY');

    if (!apiKey) {
      return jsonResponse({ error: 'サーバー側にYouTube Data APIキーが設定されていません（管理者向け: スクリプト プロパティを確認してください）。' });
    }

    // ---- 1. アクセスコードの検証（フェイルクローズ）----
    var validation = validateAccessCode(accessCode, props);
    if (!validation.ok) {
      recordFailedAttempt();
      logUsage(props, accessCode, rawPerformers, 0, '拒否: ' + validation.message);
      return jsonResponse({ error: validation.message });
    }

    if (!rawPerformers) {
      logUsage(props, accessCode, rawPerformers, 0, '拒否: 出演者名未指定');
      return jsonResponse({ error: '出演者名が指定されていません。' });
    }

    var performers = rawPerformers
      .split(/[,、]/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });

    if (performers.length === 0) {
      logUsage(props, accessCode, rawPerformers, 0, '拒否: 有効な出演者名なし');
      return jsonResponse({ error: '有効な出演者名がありません。' });
    }

    if (performers.length > MAX_PERFORMERS_PER_REQUEST) {
      logUsage(props, accessCode, rawPerformers, 0, '拒否: 出演者名の数が上限超過');
      return jsonResponse({ error: '出演者名は' + MAX_PERFORMERS_PER_REQUEST + '人までです。' });
    }

    // ---- 2. 検索実行（出演者名をそのまま検索クエリとしても使用）----
    var range = getCurrentMonthRange();
    var videoIds = searchVideoIds(performers, apiKey, range.start, range.end);

    var results = [];
    if (videoIds.length > 0) {
      var videos = fetchVideoDetails(videoIds, apiKey);
      results = filterByPerformers(videos, performers);
    }

    // ---- 3. 記録（ベストエフォート。失敗しても検索結果は返す）----
    appendSearchResults(props, results, accessCode);
    logUsage(props, accessCode, rawPerformers, results.length, '成功');

    return jsonResponse({ results: results, periodStart: range.start.toISOString(), periodEnd: range.end.toISOString() });
  } catch (err) {
    logUsage(PropertiesService.getScriptProperties(), accessCode, rawPerformers, 0, 'エラー: ' + err.message);
    return jsonResponse({ error: 'サーバーエラー: ' + err.message });
  }
}

// ---- アクセスコードの総当たり対策 ----
function isRateLimited() {
  var cache = CacheService.getScriptCache();
  return !!cache.get(LOCKOUT_CACHE_KEY);
}

function recordFailedAttempt() {
  var cache = CacheService.getScriptCache();
  var countStr = cache.get(FAILED_ATTEMPT_CACHE_KEY);
  var count = (countStr ? parseInt(countStr, 10) : 0) + 1;
  cache.put(FAILED_ATTEMPT_CACHE_KEY, String(count), FAILED_ATTEMPT_WINDOW_SECONDS);

  if (count >= FAILED_ATTEMPT_LIMIT) {
    cache.put(LOCKOUT_CACHE_KEY, '1', LOCKOUT_SECONDS);
  }
}

// ---- スプレッドシートへの数式インジェクション対策 ----
// "=" "+" "-" "@" で始まる文字列は、Sheetsに書き込むとそのまま数式として解釈されてしまうため、
// 先頭にアポストロフィを付けて必ず文字列として書き込む。
// 出演者名・アクセスコード（利用者からの入力）と、動画タイトル（YouTube側の外部データ）の
// どちらも攻撃者が自由に文字列を仕込める経路になりうるため、シートに書き込む直前に必ず通す。
function sanitizeForSheet(value) {
  var str = (value === null || value === undefined) ? '' : String(value);
  if (/^[=+\-@]/.test(str)) {
    return "'" + str;
  }
  return str;
}

// ---- アクセスコード検証 ----
function validateAccessCode(accessCode, props) {
  if (!accessCode) {
    return { ok: false, message: 'アクセスコードを入力してください。' };
  }

  var ledgerSheetId = props.getProperty('LEDGER_SHEET_ID');
  if (!ledgerSheetId) {
    // 台帳が未設定の場合は安全側に倒して拒否する（フェイルクローズ）
    return { ok: false, message: 'サーバー側の設定が未完了です（管理者向け: LEDGER_SHEET_ID未設定）。' };
  }

  var sheet;
  try {
    sheet = SpreadsheetApp.openById(ledgerSheetId).getSheets()[0];
  } catch (err) {
    return { ok: false, message: 'アクセスコードの確認に失敗しました。時間をおいて再度お試しください。' };
  }

  var data = sheet.getDataRange().getValues();
  // 1行目はヘッダー想定: コード / 有効期限 / 有効フラグ / メモ
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var code = (row[0] || '').toString().trim();
    if (code !== accessCode) continue;

    var expiry = row[1];
    var validFlag = row[2];

    if (validFlag === false || (typeof validFlag === 'string' && validFlag.toUpperCase() === 'FALSE')) {
      return { ok: false, message: 'このアクセスコードは無効化されています。' };
    }

    if (expiry instanceof Date) {
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var expiryDate = new Date(expiry);
      expiryDate.setHours(0, 0, 0, 0);
      if (expiryDate.getTime() < today.getTime()) {
        return { ok: false, message: 'このアクセスコードの有効期限が切れています。' };
      }
    }

    return { ok: true };
  }

  return { ok: false, message: 'アクセスコードが正しくありません。' };
}

// ---- 検索結果シートへの追記 ----
function appendSearchResults(props, results, accessCode) {
  if (!results || results.length === 0) return;

  var sheetId = props.getProperty('RESULTS_SHEET_ID');
  if (!sheetId) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    var now = new Date();

    var rows = results.map(function (r) {
      return [
        sanitizeForSheet(r.title),
        r.url,
        r.thumbnail ? '=IMAGE("' + r.thumbnail + '")' : '',
        r.viewCount !== null ? r.viewCount : '',
        r.likeCount !== null ? r.likeCount : '',
        sanitizeForSheet(r.performers),
        now,
        sanitizeForSheet(accessCode),
      ];
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
  } catch (err) {
    // 記録の失敗は検索結果の返却を止めない（ベストエフォート）
    Logger.log('appendSearchResults failed: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

// ---- 利用ログシートへの追記 ----
function logUsage(props, accessCode, rawPerformers, resultCount, status) {
  try {
    var sheetId = props.getProperty('USAGE_LOG_SHEET_ID');
    if (!sheetId) return;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      sheet.appendRow([
        new Date(),
        sanitizeForSheet(accessCode),
        sanitizeForSheet(rawPerformers),
        resultCount,
        sanitizeForSheet(status),
      ]);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('logUsage failed: ' + err.message);
  }
}

function getCurrentMonthRange() {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { start: start, end: now };
}

function searchVideoIds(performers, apiKey, startDate, endDate) {
  var publishedAfter = startDate.toISOString();
  var publishedBefore = endDate.toISOString();
  var idSet = {};

  performers.forEach(function (performerName) {
    var pageToken = '';
    for (var page = 0; page < MAX_PAGES_PER_PERFORMER; page++) {
      var params = {
        part: 'snippet',
        type: 'video',
        q: performerName,
        order: 'date',
        maxResults: '50',
        publishedAfter: publishedAfter,
        publishedBefore: publishedBefore,
        relevanceLanguage: 'ja',
        safeSearch: 'none',
        key: apiKey,
      };
      if (pageToken) params.pageToken = pageToken;

      var data = callYoutubeApi('https://www.googleapis.com/youtube/v3/search', params);
      (data.items || []).forEach(function (item) {
        if (item.id && item.id.videoId) idSet[item.id.videoId] = true;
      });

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  });

  return Object.keys(idSet);
}

function fetchVideoDetails(videoIds, apiKey) {
  var results = [];
  var chunkSize = 50;

  for (var i = 0; i < videoIds.length; i += chunkSize) {
    var chunk = videoIds.slice(i, i + chunkSize);
    var data = callYoutubeApi('https://www.googleapis.com/youtube/v3/videos', {
      part: 'snippet,statistics',
      id: chunk.join(','),
      key: apiKey,
    });
    (data.items || []).forEach(function (item) { results.push(item); });
  }

  return results;
}

function callYoutubeApi(baseUrl, params) {
  var query = Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  var url = baseUrl + '?' + query;

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  var body = JSON.parse(response.getContentText());

  if (code < 200 || code >= 300) {
    var message = (body && body.error && body.error.message) || ('HTTP ' + code);
    throw new Error('YouTube APIエラー: ' + message);
  }

  return body;
}

function filterByPerformers(videos, performers) {
  var rows = [];

  videos.forEach(function (video) {
    var title = (video.snippet && video.snippet.title) || '';
    var description = (video.snippet && video.snippet.description) || '';
    var haystack = title + '\n' + description;

    var matched = performers.filter(function (name) { return haystack.indexOf(name) !== -1; });
    if (matched.length === 0) return;

    var stats = video.statistics || {};
    var thumbnails = (video.snippet && video.snippet.thumbnails) || {};
    var thumbnail = (thumbnails.medium && thumbnails.medium.url)
      || (thumbnails.default && thumbnails.default.url)
      || '';

    rows.push({
      title: title,
      url: 'https://www.youtube.com/watch?v=' + video.id,
      thumbnail: thumbnail,
      performers: matched.join(', '),
      viewCount: stats.viewCount !== undefined ? Number(stats.viewCount) : null,
      likeCount: stats.likeCount !== undefined ? Number(stats.likeCount) : null,
    });
  });

  return rows;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 月次アーカイブ =====

/**
 * セットアップ用: これをApps Scriptエディタから1回だけ手動実行してください。
 * 「毎月1日 0時台に archiveResultsSheet を実行する」トリガーを登録します。
 * 何度実行しても、同じ関数の古いトリガーは削除してから登録し直すので重複しません。
 */
function setupMonthlyArchiveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'archiveResultsSheet') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('archiveResultsSheet')
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();

  Logger.log('毎月1日 0時台に archiveResultsSheet を実行するトリガーを設定しました。');
}

/**
 * 月初トリガーから呼ばれる本体。
 * 「検索結果」シートの内容を ARCHIVE_FOLDER_ID 内の「検索結果_YYYYMM」（前月分）
 * スプレッドシートへ転記し、「検索結果」シートのデータ行を空にする。
 * Apps Scriptエディタから手動実行してテストすることもできる。
 */
function archiveResultsSheet() {
  var props = PropertiesService.getScriptProperties();
  var resultsSheetId = props.getProperty('RESULTS_SHEET_ID');
  var archiveFolderId = props.getProperty('ARCHIVE_FOLDER_ID');

  if (!resultsSheetId || !archiveFolderId) {
    Logger.log('archiveResultsSheet: RESULTS_SHEET_ID または ARCHIVE_FOLDER_ID が未設定のためスキップしました。');
    return;
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    var sourceSheet = SpreadsheetApp.openById(resultsSheetId).getSheets()[0];
    var lastRow = sourceSheet.getLastRow();
    var lastCol = sourceSheet.getLastColumn();

    if (lastRow <= 1 || lastCol === 0) {
      Logger.log('archiveResultsSheet: データ行が無いためスキップしました。');
      return;
    }

    var archiveName = '検索結果_' + getPreviousMonthLabel();
    var folder = DriveApp.getFolderById(archiveFolderId);
    var archiveSpreadsheet = findSpreadsheetInFolder(folder, archiveName);
    var isNewFile = false;

    if (!archiveSpreadsheet) {
      archiveSpreadsheet = SpreadsheetApp.create(archiveName);
      isNewFile = true;
      var file = DriveApp.getFileById(archiveSpreadsheet.getId());
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file); // マイドライブ直下の重複参照を外し、フォルダ内のみに置く
    }

    var archiveSheet = archiveSpreadsheet.getSheets()[0];

    if (isNewFile) {
      sourceSheet.getRange(1, 1, 1, lastCol).copyTo(archiveSheet.getRange(1, 1, 1, lastCol));
    }

    var dataRowCount = lastRow - 1;
    var destStartRow = Math.max(archiveSheet.getLastRow() + 1, 2);

    sourceSheet.getRange(2, 1, dataRowCount, lastCol)
      .copyTo(archiveSheet.getRange(destStartRow, 1, dataRowCount, lastCol));

    SpreadsheetApp.flush();

    sourceSheet.getRange(2, 1, dataRowCount, lastCol).clearContent();

    Logger.log('archiveResultsSheet: ' + dataRowCount + '行を ' + archiveName + ' へ転記し、検索結果シートを初期化しました。');
  } catch (err) {
    Logger.log('archiveResultsSheet failed: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

function getPreviousMonthLabel() {
  var now = new Date();
  var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var y = prev.getFullYear();
  var m = String(prev.getMonth() + 1).padStart(2, '0');
  return '' + y + m;
}

function findSpreadsheetInFolder(folder, name) {
  var files = folder.getFilesByName(name);
  if (files.hasNext()) {
    return SpreadsheetApp.openById(files.next().getId());
  }
  return null;
}
