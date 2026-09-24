import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';

// Load .env file
dotenv.config();

// ============================================================
// BBS Moderation Tool - Node.js Version
// Features:
// 1. Crawl bulletin board for new posts
// 2. Detect posts with NG words
// 3. AI (Claude) classification of posts (violation/negative/request/normal)
// 4. Telegram notifications
// 5. Prevent duplicate notifications via seen_posts.json
// 6. Detailed logging
// ============================================================

// ---- Configuration ----
const MODERATION_MODE = process.env.MODERATION_MODE || 'SEMI';
const BOARD_URL = process.env.BOARD_URL || 'http://localhost:8000/board/';
const ADMIN_CGI_URL = process.env.ADMIN_CGI_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || ''; // 未設定ならチャットIDのみで判定

const NG_WORDS = (process.env.NG_WORDS || '')
  .split(',')
  .map(w => w.trim())
  .filter(w => w.length > 0);

const DETECT_EMAIL = (process.env.DETECT_EMAIL || '1') === '1';
const DETECT_URL = (process.env.DETECT_URL || '1') === '1';
const DETECT_SNS_INVITE = (process.env.DETECT_SNS_INVITE || '1') === '1';

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const URL_PATTERN = /(https?:\/\/|www\.)[\w./?#%&=+~:;@-]+/gi;

// SNS/外部チャットへの誘導文言検出
const SNS_PATTERN = /(LINE|ライン|Line|Telegram|テレグラム|カカオ|KakaoTalk|Kakao|Skype|スカイプ|Instagram|インスタ|Twitter|ツイッター|DM|ディーエム|WhatsApp|Discord|ディスコード)/i;
const INVITE_PATTERN = /(交換し|教えて|やってます|やってる|連絡して|追加して|友達に|登録して|招待|アド(レス)?教え|(LINE|ライン|Line|Telegram|テレグラム|カカオ|Kakao|Skype|スカイプ|Instagram|インスタ|Twitter|ツイッター|DM|WhatsApp|Discord|ディスコード)\s*(の)?\s*ID)/i;

const ID_PATTERN = /[a-zA-Z0-9]{4,}/;

// 店員/スタッフへの言及を検出(キーワード即検知用)
const STAFF_PATTERN = /(店員|スタッフ)/;

function detectSNSInvite(text) {
    const sentences = text.split(/[。！？\n]/).map(s => s.trim()).filter(Boolean);

  for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        if (!SNS_PATTERN.test(s)) continue;

      // 条件1: 既存の勧誘語マッチ(同一文)
      if (INVITE_PATTERN.test(s)) return true;

      // 条件2: SNS名のみの行の直後にID風文字列の行がある(改行で分離されたパターン)
      const next = sentences[i + 1];
        if (next && ID_PATTERN.test(next) && !SNS_PATTERN.test(next)) return true;

      // 条件3: 同一行内にSNS名+ID風文字列が混在
      const withoutSnsName = s.replace(SNS_PATTERN, '');
        if (ID_PATTERN.test(withoutSnsName)) return true;

      // 条件4: SNS名の言及があるだけで、勧誘語やID風文字列が伴わない場合も検知
      // (この掲示板ではSNS名の単独言及自体が誘導目的である実態が多いため)
      return true;
  }

  return false;
}

const STATE_FILE = process.env.STATE_FILE || 'seen_posts.json';
const BOARD_ENCODING = process.env.BOARD_ENCODING || 'cp932';
const LOG_FILE = process.env.LOG_FILE || 'bbs_moderation.log';

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    'Referer': 'http://www.mara-site.com/',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
};

// AI configuration
const AI_CLASSIFY = (process.env.AI_CLASSIFY || '0') === '1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REVIEW_CONFIDENCE_THRESHOLD = parseInt(process.env.REVIEW_CONFIDENCE_THRESHOLD || '80', 10);
const MAX_AI_CALLS_PER_RUN = parseInt(process.env.MAX_AI_CALLS_PER_RUN || '30', 10);
const DECISIONS_FILE = process.env.DECISIONS_FILE || 'decisions.jsonl';
const REQUESTS_LOG_FILE = process.env.REQUESTS_LOG_FILE || 'requests_log.jsonl';

// Anthropic client
let anthropicClient = null;
if (ANTHROPIC_API_KEY) {
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// ============================================================
// Logging Setup
// ============================================================
class Logger {
    constructor(logFile) {
          this.logFile = logFile;
          this.ensureLogFileExists();
    }

  ensureLogFileExists() {
        if (!fs.existsSync(this.logFile)) {
                fs.writeFileSync(this.logFile, '');
        }
  }

  getTimestamp() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  log(level, message) {
        const logLine = `${this.getTimestamp()} [${level}] ${message}`;
        console.log(logLine);

      try {
              fs.appendFileSync(this.logFile, logLine + '\n', 'utf-8');

          // Rotate log if too large (1MB)
          const stats = fs.statSync(this.logFile);
              if (stats.size > 1_000_000) {
                        this.rotateLog();
              }
      } catch (e) {
              console.error(`Failed to write log: ${e.message}`);
      }
  }

  rotateLog() {
        for (let i = 4; i >= 1; i--) {
                const oldFile = `${this.logFile}.${i}`;
                const newFile = `${this.logFile}.${i + 1}`;
                if (fs.existsSync(oldFile)) {
                          fs.renameSync(oldFile, newFile);
                }
        }
        if (fs.existsSync(this.logFile)) {
                fs.renameSync(this.logFile, `${this.logFile}.1`);
                fs.writeFileSync(this.logFile, '');
        }
  }

  info(message) {
        this.log('INFO', message);
  }

  warning(message) {
        this.log('WARNING', message);
  }

  error(message) {
        this.log('ERROR', message);
  }
}

const logger = new Logger(LOG_FILE);

// ============================================================
// Telegram Notification
// ============================================================
async function sendTelegramNotification(message, postId = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
          logger.warning('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set.');
          return false;
    }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const data = {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: true,
    };

  // 判定フィードバック用のボタンを付与（post_id が分かる通知のみ）
  if (postId) {
        data.reply_markup = {
                inline_keyboard: [[
                  { text: '✅ 判定は正しい', callback_data: `j|${postId}|ok` },
                  { text: '❌ 誤検知（通常）', callback_data: `j|${postId}|no` },
                ]],
        };
  }

  try {
        const response = await axios.post(url, data, { timeout: 10000 });
        if (response.status === 200 && response.data.ok) {
                logger.info('Telegram notification sent.');
                return true;
        }
        logger.error(`Telegram notification failed (Status: ${response.status}): ${response.data}`);
        return false;
  } catch (e) {
        logger.error(`Telegram notification error: ${e.message}`);
        return false;
  }
}

// ============================================================
// Telegram Feedback (判定ボタンの受信)
// ============================================================
const OFFSET_FILE = process.env.OFFSET_FILE || 'telegram_offset.json';

function loadUpdateOffset() {
    try {
          return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf-8')).offset || 0;
    } catch (e) {
          return 0;
    }
}

function saveUpdateOffset(offset) {
    try {
          fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }), 'utf-8');
    } catch (e) {
          logger.warning(`Failed to save update offset: ${e.message}`);
    }
}

// decisions.jsonl の該当 post_id（最新の行）に user_judgment を書き込む
function applyUserJudgment(postId, judgment) {
    let lines;
    try {
          lines = fs.readFileSync(DECISIONS_FILE, 'utf-8').split('\n').filter(l => l.trim());
    } catch (e) {
          logger.warning(`Failed to read decisions: ${e.message}`);
          return null;
    }

  for (let i = lines.length - 1; i >= 0; i--) {
        let obj;
        try {
                obj = JSON.parse(lines[i]);
        } catch (e) {
                continue;
        }
        if (String(obj.post_id) !== String(postId)) {
                continue;
        }
        obj.user_judgment = judgment;
        obj.judged_at = new Date().toISOString();
        lines[i] = JSON.stringify(obj);
        try {
                fs.writeFileSync(DECISIONS_FILE, lines.join('\n') + '\n', 'utf-8');
        } catch (e) {
                logger.warning(`Failed to write decisions: ${e.message}`);
                return null;
        }
        return obj.ai_classification;
  }
    logger.warning(`No.${postId} not found in decisions.jsonl`);
    return null;
}

// cron 実行の冒頭で、前回以降に押されたボタンをまとめて処理する
async function processTelegramFeedback() {
    if (!TELEGRAM_BOT_TOKEN) {
          return;
    }

  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
    let updates;
    try {
          const res = await axios.get(`${base}/getUpdates`, {
                  params: {
                    offset: loadUpdateOffset(),
                    timeout: 0,
                    allowed_updates: JSON.stringify(['callback_query']),
                  },
                  timeout: 15000,
                });
          if (!res.data || !res.data.ok) {
                  logger.warning('getUpdates returned not ok');
                  return;
          }
          updates = res.data.result || [];
    } catch (e) {
          logger.warning(`getUpdates error: ${e.message}`);
          return;
    }

  if (updates.length === 0) {
        return;
  }

  let handled = 0;
    let maxUpdateId = 0;

  for (const u of updates) {
        if (u.update_id >= maxUpdateId) {
                maxUpdateId = u.update_id;
        }
        const cq = u.callback_query;
        if (!cq || !cq.data || !cq.data.startsWith('j|')) {
                continue;
        }
        // 送信者チェック：通知先チャット以外・許可ユーザー以外からの操作は無視（返信もしない）
        if (String(cq.message?.chat?.id) !== String(TELEGRAM_CHAT_ID) ||
            (ALLOWED_USER_ID && String(cq.from?.id) !== String(ALLOWED_USER_ID))) {
                logger.warning(`Ignored callback from unauthorized user ${cq.from?.id}`);
                continue;
        }
        // データ形式チェック：j|<数字>|ok または j|<数字>|no 以外は無視
        if (!/^j\|\d{1,10}\|(ok|no)$/.test(cq.data)) {
                continue;
        }

    const [, postId, verdict] = cq.data.split('|');
        const aiClass = applyUserJudgment(postId, verdict === 'ok' ? null : '通常');
        // 「正しい」の場合は AI 判定をそのまま人間判定として採用する
        const judgment = verdict === 'ok' ? (aiClass || '通常') : '通常';
        if (verdict === 'ok') {
                applyUserJudgment(postId, judgment);
        }

    const label = verdict === 'ok'
          ? `✅ 正しい判定として記録（${judgment}）`
          : '❌ 誤検知として記録（通常）';

    // ポップアップ応答。ボタン押下から取り込みまで時間が空くと
    // callback_query の有効期限（約1分）が切れて 400 が返るが、
    // 記録自体は成功しているためエラー扱いしない。
    try {
          await axios.post(`${base}/answerCallbackQuery`, {
                  callback_query_id: cq.id,
                  text: label,
                }, { timeout: 10000 });
    } catch (e) {
          if (e.response?.status !== 400) {
                  logger.warning(`answerCallbackQuery error: ${e.message}`);
          }
    }

    // ボタンは残したまま、結果をメッセージ末尾に表示する。
    // 押し直しに備え、前回の結果行（── 以降）は削ってから付け直す。
    const baseText = (cq.message.text || '').split('\n\n── ')[0];
    try {
          await axios.post(`${base}/editMessageText`, {
                  chat_id: cq.message.chat.id,
                  message_id: cq.message.message_id,
                  text: `${baseText}\n\n── ${label}`,
                  disable_web_page_preview: true,
                  reply_markup: {
                    inline_keyboard: [[
                              { text: '✅ 判定は正しい', callback_data: `j|${postId}|ok` },
                              { text: '❌ 誤検知（通常）', callback_data: `j|${postId}|no` },
                    ]],
                  },
                }, { timeout: 10000 });
    } catch (e) {
          // 同じボタンを続けて押した場合は内容が変わらず 400 になる（実害なし）
          if (e.response?.status !== 400) {
                  logger.warning(`editMessageText error: ${e.message}`);
          }
    }

    handled++;
        logger.info(`Feedback recorded: No.${postId} → ${judgment} (verdict: ${verdict})`);
  }

  if (maxUpdateId > 0) {
        saveUpdateOffset(maxUpdateId + 1);
  }
    if (handled > 0) {
          logger.info(`Telegram feedback processed: ${handled} item(s)`);
    }
}

// ============================================================
// Seen Posts Management
// ============================================================
function loadSeenIds() {
    if (!fs.existsSync(STATE_FILE)) {
          return new Set();
    }
    try {
          const data = fs.readFileSync(STATE_FILE, 'utf-8');
          return new Set(JSON.parse(data));
    } catch (e) {
          logger.warning(`Failed to load seen posts: ${e.message}`);
          return new Set();
    }
}

function saveSeenIds(seenIds) {
    try {
          const sorted = Array.from(seenIds).sort((a, b) => parseInt(a) - parseInt(b));
          fs.writeFileSync(STATE_FILE, JSON.stringify(sorted), 'utf-8');
    } catch (e) {
          logger.warning(`Failed to save seen posts: ${e.message}`);
    }
}

// ============================================================
// Violation Detection
// ============================================================
function findViolations(text) {
    const reasons = [];

  // Check NG words
  for (const word of NG_WORDS) {
        if (text.includes(word)) {
                reasons.push(`NGワード:${word}`);
        }
  }

  // Check email
  if (DETECT_EMAIL && EMAIL_PATTERN.test(text)) {
        reasons.push('メールアドレス');
  }

  // Check URL
  if (DETECT_URL && URL_PATTERN.test(text)) {
        reasons.push('URL');
  }

  // Check SNS invite
  if (DETECT_SNS_INVITE && detectSNSInvite(text)) {
        reasons.push('SNS誘導文言');
  }

  return reasons;
}

// ============================================================
// Board HTML Fetching
// ============================================================
async function fetchBoardHtml() {
    logger.info(`Fetching board: ${BOARD_URL}`);
    try {
          const response = await axios.get(BOARD_URL, {
                  headers: REQUEST_HEADERS,
                  timeout: 15000,
                  responseType: 'arraybuffer',
          });

      if (response.status !== 200) {
              logger.error(`Failed to access board (Status: ${response.status})`);
              if ([403, 503].includes(response.status)) {
                        logger.error('→ Possibly blocked by bot prevention.');
              }
              return null;
      }

      return iconv.decode(Buffer.from(response.data), 'Shift_JIS');
    } catch (e) {
          logger.error(`Board fetch error: ${e.message}`);
          return null;
    }
}

// ============================================================
// Post Parsing
// ============================================================
function parsePosts(html) {
    const posts = [];
    const $ = cheerio.load(html);

  $('div.art').each((index, elem) => {
        const $elem = $(elem);

                        // Find delete link to get post ID
                        const delLink = $elem.find('a[href*="del="]');
        if (delLink.length === 0) {
                return; // Skip if no delete link
        }

                        const href = delLink.attr('href');
        const idMatch = href.match(/del=(\d+)/);
        if (!idMatch) {
                return; // Skip if ID not found
        }

                        const postId = idMatch[1];
        const title = $elem.find('strong').text().trim() || '';
        const body = $elem.find('div.com').text().trim() || '';
        const name = $elem.find('div.ope b').text().trim() || '';
        const text = `${title}\n${body}\n${name}`;

                        posts.push({
                                id: postId,
                                title,
                                name,
                                body,
                                text,
                        });
  });

  return posts;
}

// ============================================================
// AI Classification Functions
// ============================================================
async function loadDecisions() {
    if (!fs.existsSync(DECISIONS_FILE)) {
          return [];
    }
    try {
          const data = fs.readFileSync(DECISIONS_FILE, 'utf-8');
          return data
            .split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
    } catch (e) {
          logger.warning(`Failed to load decisions: ${e.message}`);
          return [];
    }
}

async function saveDecision(postId, classification, confidence, userJudgment = null) {
    try {
          const decision = {
                  timestamp: new Date().toISOString(),
                  post_id: postId,
                  ai_classification: classification,
                  ai_confidence: confidence,
                  user_judgment: userJudgment,
          };
          fs.appendFileSync(
                  DECISIONS_FILE,
                  JSON.stringify(decision) + '\n',
                  'utf-8'
                );
    } catch (e) {
          logger.warning(`Failed to save decision: ${e.message}`);
    }
}

async function saveRequest(postId, text, classification) {
    if (classification !== '要望') {
          return;
    }
    try {
          const requestItem = {
                  timestamp: new Date().toISOString(),
                  post_id: postId,
                  text: text.substring(0, 200),
          };
          fs.appendFileSync(
                  REQUESTS_LOG_FILE,
                  JSON.stringify(requestItem) + '\n',
                  'utf-8'
                );
    } catch (e) {
          logger.warning(`Failed to save request: ${e.message}`);
    }
}

function getLearningContext() {
    let decisions = [];
    try {
          decisions = fs.readFileSync(DECISIONS_FILE, 'utf-8')
            .split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
    } catch (e) {
          return '';
    }

  if (decisions.length === 0) {
        return '';
  }

  const recent = decisions.slice(-20);
    const examples = recent
      .filter(d => d.user_judgment)
      .map(d => `- タイプ: ${d.user_judgment} （AI初判定: ${d.ai_classification}）`)
      .slice(0, 10);

  if (examples.length === 0) {
        return '';
  }

  return '\n【あなたが過去に判定した例】\n' + examples.join('\n') +
        '\n\nこの傾向を参考に、今回も同じ基準で分類してください。\n';
}

async function classifyPost(postId, title, body, name, violations) {
    if (!AI_CLASSIFY || !anthropicClient) {
          return {
                  classification: null,
                  confidence: null,
                  reason: 'AI classification is disabled',
          };
    }

  const text = `${title}\n${body}`.trim();
    if (!text) {
          return {
                  classification: '通常',
                  confidence: 100,
                  reason: '本文が空',
          };
    }

  if (violations && violations.length > 0) {
        return {
                classification: '違反',
                confidence: 100,
                reason: `パターン検知済み: ${violations.join(', ')}`,
        };
  }

  const learningContext = getLearningContext();
    const systemPrompt = `あなたは掲示板のモデレーターです。投稿を以下の5つに分類してください。

    【この掲示板の前提】
    この掲示板は成人向けの出会い目的の掲示板です。来店予定の時刻、体型・身体的特徴、
    プレイの嗜好といった、性的に露骨な自己紹介・募集の投稿は「通常」の投稿形式であり、
    この板における正常な利用です。
    性的表現が露骨であること自体を理由に「違反」と判定してはいけません。
    投稿者が自分自身について書いている内容は、どれだけ露骨でも「通常」です。

    【分類】
    1. **違反** - 外部SNS・他サイトへの誘導、連絡先(メールアドレス・ID・URL)の掲載、
       商業目的の宣伝スパム、掲示板と無関係な荒らし投稿。この4種類に限定する
    2. **誹謗中傷** - 特定の個人・グループへの人格攻撃・侮辱・悪口。対象は店・スタッフに限らず、他の投稿者や第三者への中傷も含む
    3. **ネガティブ** - 批判や苦情だが、誹謗中傷には該当せず、サービス改善の具体的な提案も含まないもの
    4. **要望** - 機能リクエスト、改善案、フィードバック
    5. **通常** - 上記に該当しない投稿。自己紹介・募集・来店予告・建設的な質問・意見・雑談など

    【数字表記についての重要な注意】
    この掲示板では、投稿者が自分の身長・体重・年齢・サイズを数字で書く慣習があります。
    例: 「179.70.31」「1746728」「167 66 38」「178.62 28.P18」
    これらは身体的特徴の自己申告であり、IPアドレス・電話番号・連絡先ID・
    アカウント名のいずれでもありません。数字列を理由に「違反」と判定してはいけません。
    連絡先とみなしてよいのは、@を含むメールアドレス、http/httpsのURL、
    LINE/X/Twitter/Instagram等のサービス名が明示されたIDのみです。

    【回答形式】
    以下のJSON（1行）で返してください:
    {
      "classification": "違反" | "誹謗中傷" | "ネガティブ" | "要望" | "通常",
        "confidence": 0～100,
          "reason": "判定理由（20字以内）"
          }

          ${learningContext}`;

  const userPrompt = `【投稿の内容】
  タイトル: ${title}
  投稿者: ${name}
  本文:
  ${body}

  この投稿をどう分類しますか？（JSON形式で1行で返す）`;

  try {
        let message;
        const maxRetries = 5;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                          message = await anthropicClient.messages.create({
                                      model: 'claude-haiku-4-5-20251001',
                                      max_tokens: 200,
                                      temperature: 0,
                                      messages: [
                                        {
                                                        role: 'user',
                                                        content: userPrompt,
                                        },
                                                  ],
                                      system: systemPrompt,
                          });
                          break; // 成功したらリトライループを抜ける
                } catch (apiError) {
                          if (attempt === maxRetries) {
                                      throw apiError; // 最終試行でも失敗したら外側のcatchに投げる
                          }
                          const waitMs = Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500); // 2s→4s→8s→16s（指数バックオフ＋ゆらぎ）
                  logger.warning(
                              `AI classification retry (No.${postId}): attempt ${attempt} failed (${apiError.message}), retrying in ${waitMs}ms`
                            );
                          await new Promise((resolve) => setTimeout(resolve, waitMs));
                }
        }

      let responseText = message.content[0].text.trim();

      // Extract JSON if wrapped in markdown
      if (responseText.includes('```json')) {
              responseText = responseText.split('```json')[1].split('```')[0].trim();
      } else if (responseText.includes('```')) {
              responseText = responseText.split('```')[1].split('```')[0].trim();
      }

      const result = JSON.parse(responseText);

      logger.info(
              `AI classification: No.${postId} → ${result.classification} (confidence: ${result.confidence}%)`
            );

      await saveRequest(postId, text, result.classification);
        await saveDecision(postId, result.classification, result.confidence);

      return result;
  } catch (e) {
        logger.error(`AI classification error (No.${postId}): ${e.message}`);
        return {
                classification: null,
                confidence: null,
                failed: true,
                reason: `API error: ${e.message.substring(0, 30)}`,
        };
  }
}

// ============================================================
// Main Processing
// ============================================================
async function checkBoard() {
    const html = await fetchBoardHtml();
    if (!html) {
          return;
    }

  const posts = parsePosts(html);
    if (posts.length === 0) {
          logger.warning('No posts detected. HTML structure may have changed.');
          logger.warning(`HTML start (for debugging): ${html.substring(0, 800).replace(/\n/g, ' ')}`);
          return;
    }

  logger.info(`Detected ${posts.length} posts.`);

  const seenIds = loadSeenIds();
    const newlySeen = new Set();
    let detectedCount = 0;
    let aiCallCount = 0;

  for (const post of posts) {
        const postId = post.id;

      if (seenIds.has(postId)) {
              continue; // Skip already processed posts
      }

      const detected = findViolations(post.text);
        const staffMentioned = STAFF_PATTERN.test(post.text);

      if (!detected || detected.length === 0) {
              let aiResult = null;

          // No pattern violation, try AI classification if enabled
          if (
                    AI_CLASSIFY &&
                    anthropicClient &&
                    aiCallCount < MAX_AI_CALLS_PER_RUN
                  ) {
                    aiResult = await classifyPost(
                                postId,
                                post.title,
                                post.body,
                                post.name,
                                []
                              );
                    aiCallCount++;
          }

          if (staffMentioned) {
                    // 「店員」「スタッフ」への言及はキーワード一致で確定検知。
                // AI結果があればダブルチェックの参考情報として通知に付加する。
                detectedCount++;
                    const classification = aiResult?.classification || 'AI判定なし';
                    const confidence = aiResult?.confidence ?? 100;
                    const reasonNote = aiResult?.reason ? ` / AI理由: ${aiResult.reason}` : '';
                    const msg =
                                `【店員/スタッフへの言及を検知】\n` +
                                `記事番号: No.${postId}\n` +
                                `投稿者: ${post.name}\n` +
                                `タイトル: ${post.title}\n` +
                                `本文一部: ${post.body.substring(0, 100)}\n\n` +
                                `キーワード一致: 店員/スタッフ\n` +
                                `AI評価: ${classification} (信度: ${confidence}%)${reasonNote}`;

                if (await sendTelegramNotification(msg, postId)) {
                            newlySeen.add(postId);
                } else {
                            logger.warning(`No.${postId} notification failed - will retry next run`);
                }
                    continue;
          }

          if (aiResult && aiResult.classification && aiResult.confidence !== null) {
                    // Notify for "要望" (requests), "ネガティブ" (complaints), and "誹謗中傷" (defamation/insults)
                if (
                            aiResult.classification === '要望' ||
                            aiResult.classification === 'ネガティブ' ||
                            aiResult.classification === '誹謗中傷' ||
                            aiResult.classification === '違反'
                          ) {
                            detectedCount++;
                            const label =
                                          aiResult.classification === '要望'
                                ? '要望・フィードバック'
                                            : aiResult.classification === '誹謗中傷'
                                ? '誹謗中傷・悪口'
                                            : aiResult.classification === '違反'
                                ? '規約違反の疑い'
                                            : '苦情・批判';
                            const msg =
                                          `【投稿者の${label}】\n` +
                                          `記事番号: No.${postId}\n` +
                                          `投稿者: ${post.name}\n` +
                                          `タイトル: ${post.title}\n` +
                                          `本文一部: ${post.body.substring(0, 100)}\n\n` +
                                          `AI評価: ${aiResult.classification} (信度: ${aiResult.confidence}%)`;

                      if (await sendTelegramNotification(msg, postId)) {
                                    newlySeen.add(postId);
                      } else {
                                    logger.warning(`No.${postId} notification failed - will retry next run`);
                      }
                } else {
                            newlySeen.add(postId);
                }
          } else if (aiResult && aiResult.failed) {
                    logger.warning(`No.${postId} AI classification failed - will retry next run`);
          } else {
                    newlySeen.add(postId);
          }
              continue;
      }

      // Violation detected
      detectedCount++;
        logger.info(`Detected: No.${postId} -> ${detected.join(', ')}`);

      if (MODERATION_MODE === 'AUTO') {
              // Auto delete (not yet implemented)
          newlySeen.add(postId);
      } else {
              // SEMI mode - notify via Telegram
          const deleteUrl = `${BOARD_URL}?del=${postId}`;
              const msg =
                        `【掲示板モデレーション警告】\n` +
                        `記事番号: No.${postId}\n` +
                        `投稿者: ${post.name}\n` +
                        `タイトル: ${post.title}\n` +
                        `検知理由: ${detected.join(', ')}\n` +
                        `本文一部: ${post.body.substring(0, 80)}\n` +
                        `削除はこちら: ${deleteUrl}`;

          if (await sendTelegramNotification(msg)) {
                    newlySeen.add(postId);
          } else {
                    logger.warning(`No.${postId} notification failed - will retry next run`);
          }
      }
  }

  // Update seen posts
  for (const id of newlySeen) {
        seenIds.add(id);
  }
    saveSeenIds(seenIds);

  logger.info(
        `Crawl completed. New: ${newlySeen.size} / Detected: ${detectedCount} / AI calls: ${aiCallCount} / Total processed: ${seenIds.size}`
      );
}

// ============================================================
// Main Execution
// ============================================================
(async () => {
    try {
          if (NG_WORDS.length === 0) {
                  logger.warning('No NG words configured.');
          }
          // 前回実行以降に押された判定ボタンを先に取り込む
          await processTelegramFeedback();
          await checkBoard();
    } catch (e) {
          logger.error(`Unexpected error: ${e.message}`);
          process.exit(1);
    }
})();
