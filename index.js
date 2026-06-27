import axios from 'axios';
import * as cheerio from 'cheerio';
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

function detectSNSInvite(text) {
  const sentences = text.split(/[。！？\n]/);
  return sentences.some(s => SNS_PATTERN.test(s) && INVITE_PATTERN.test(s));
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
async function sendTelegramNotification(message) {
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
    });

  if (response.status !== 200) {
    logger.error(`Failed to access board (Status: ${response.status})`);
    if ([403, 503].includes(response.status)) {
      logger.error('→ Possibly blocked by bot prevention.');
    }
    return null;
  }

  return response.data;
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
  const systemPrompt = `あなたは掲示板のモデレーターです。投稿を以下の4つに分類してください。

  【分類】
  1. **違反** - スパム、誹謗中傷、サービス規約違反の内容
  2. **ネガティブ** - 批判や苦情だが、サービス改善の具体的な提案を含まないもの
  3. **要望** - 機能リクエスト、改善案、フィードバック
  4. **通常** - 上記に該当しない、建設的な質問・意見・雑談など

  【回答形式】
  以下のJSON（1行）で返してください:
  {
  "classification": "違反" | "ネガティブ" | "要望" | "通常",
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
  const message = await anthropicClient.messages.create({
    model: 'claude-opus-4-1',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: userPrompt,
      },
      ],
    system: systemPrompt,
  });

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

  return result;
} catch (e) {
  logger.error(`AI classification error (No.${postId}): ${e.message}`);
  return {
    classification: null,
    confidence: null,
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

  if (!detected || detected.length === 0) {
    // No violation detected, try AI classification if enabled
  if (
    AI_CLASSIFY &&
    anthropicClient &&
    aiCallCount < MAX_AI_CALLS_PER_RUN
    ) {
    const result = await classifyPost(
      postId,
      post.title,
      post.body,
      post.name,
      []
      );
    aiCallCount++;

    if (result.classification && result.confidence !== null) {
      // Only notify for "要望" (requests)
    if (result.classification === '要望') {
      detectedCount++;
      const msg =
        `【投稿者の要望・フィードバック】\n` +
        `記事番号: No.${postId}\n` +
        `投稿者: ${post.name}\n` +
        `タイトル: ${post.title}\n` +
        `本文一部: ${post.body.substring(0, 100)}\n\n` +
        `AI評価: ${result.classification} (信度: ${result.confidence}%)`;

      if (await sendTelegramNotification(msg)) {
        newlySeen.add(postId);
      } else {
        logger.warning(`No.${postId} notification failed - will retry next run`);
      }
    } else {
      newlySeen.add(postId);
    }
    } else {
      newlySeen.add(postId);
    }
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
    await checkBoard();
  } catch (e) {
    logger.error(`Unexpected error: ${e.message}`);
    process.exit(1);
  }
})();
